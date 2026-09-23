// `systemd-escape --path` in JS (SPEC §V99), so a nested project's folder can
// be a template-unit instance: `vite-path@<escaped>.service` with
// `WorkingDirectory=…/%I` unescapes back to `glasses/my-app`. Rules: `/` →
// `-`; `[A-Za-z0-9:_.]` kept; a leading `.` and everything else → `\xNN`
// (bytes of the UTF-8 encoding).
'use strict';

function systemdEscapePath(rel) {
  const p = String(rel || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (!p) return '-';
  let out = '';
  const bytes = Buffer.from(p, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const c = String.fromCharCode(b);
    if (c === '/') out += '-';
    else if (/[A-Za-z0-9:_]/.test(c) || (c === '.' && i > 0)) out += c;
    else out += '\\x' + b.toString(16).padStart(2, '0');
  }
  return out;
}

module.exports = { systemdEscapePath };
