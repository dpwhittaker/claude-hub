// OSC 52 → navigator.clipboard bridge for ttyd terminals.
//
// xterm.js does not handle OSC 52 by default, so a tmux `set-clipboard on`
// emission (the standard `\x1b]52;c;<base64>\x07` sequence on mouse-select
// or `copy-pipe-and-cancel`) reaches the browser as inert text. This shim
// intercepts ttyd's WebSocket BEFORE its main bundle constructs the socket,
// scans incoming PTY output for OSC 52, decodes the base64 payload, and
// writes it to the system clipboard via navigator.clipboard.
//
// ttyd frames its WS messages as a single command byte followed by data;
// '0' (0x30) = "terminal output", which is the only frame we care about.
// Anything else passes through untouched. Frames may be string or binary
// depending on ttyd build; both paths covered.
//
// Server inlines installOsc52Bridge.toString() into <head> (no DOM gate) so
// it runs before ttyd's bundle wires its WebSocket — wrapping the
// constructor after-the-fact would miss the already-open socket.
function installOsc52Bridge(view) {
  if (!view || view.__osc52Installed) return;
  view.__osc52Installed = true;
  const Orig = view.WebSocket;
  if (typeof Orig !== 'function') return;

  // Per-socket rolling buffer. A single OSC 52 sequence can straddle two
  // WebSocket frames if the payload is large; we hold a small tail until
  // either ST/BEL arrives or the buffer grows past a cap. The cap is well
  // below any realistic clipboard payload (tmux truncates at 1 MiB by
  // default) so the slice never amputates mid-base64.
  const MAX_BUF = 2 * 1024 * 1024;
  const OSC52_RE = /\x1b\]52;[a-zA-Z]*;([A-Za-z0-9+/=]*?)(?:\x07|\x1b\\)/g;
  const decoder = new view.TextDecoder('utf-8', { fatal: false });

  function writeToClipboard(text) {
    try {
      if (view.navigator && view.navigator.clipboard && view.navigator.clipboard.writeText) {
        view.navigator.clipboard.writeText(text).catch(() => {});
      }
    } catch {}
  }

  function decodeBase64ToString(b64) {
    let bin;
    try { bin = view.atob(b64); } catch { return null; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return decoder.decode(bytes);
  }

  function makeScanner() {
    let buf = '';
    return function scan(chunk) {
      if (!chunk) return;
      buf += chunk;
      if (buf.length > MAX_BUF) buf = buf.slice(buf.length - (MAX_BUF >> 1));
      OSC52_RE.lastIndex = 0;
      let m;
      let lastEnd = 0;
      while ((m = OSC52_RE.exec(buf)) !== null) {
        const text = decodeBase64ToString(m[1]);
        if (text != null && text.length > 0) writeToClipboard(text);
        lastEnd = m.index + m[0].length;
      }
      if (lastEnd > 0) buf = buf.slice(lastEnd);
    };
  }

  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    const scan = makeScanner();
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      if (typeof d === 'string') {
        // ttyd command-byte framing: '0' = PTY output.
        if (d.length && d.charCodeAt(0) === 0x30) scan(d.slice(1));
        return;
      }
      if (d && typeof d.byteLength === 'number') {
        // ArrayBuffer
        const u = new Uint8Array(d);
        if (u.length && u[0] === 0x30) scan(decoder.decode(u.subarray(1)));
        return;
      }
      if (typeof Blob !== 'undefined' && d instanceof Blob) {
        d.arrayBuffer().then((buf) => {
          const u = new Uint8Array(buf);
          if (u.length && u[0] === 0x30) scan(decoder.decode(u.subarray(1)));
        }).catch(() => {});
      }
    });
    return ws;
  }
  Wrapped.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { Wrapped[k] = Orig[k]; } catch {}
  }
  view.WebSocket = Wrapped;
}

module.exports = { installOsc52Bridge };
