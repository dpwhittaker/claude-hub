import { connectBridge, startGlassesPage } from './glasses';

// Entry point for the companion half of the app — the page the phone loads.
//
// Two consumers, one bundle:
//   1. The Even App's WebView, which also gives us a bridge to the glasses.
//   2. A plain browser, where this is just a website you can install to the
//      home screen as a PWA.
//
// Nothing here top-level-awaits the bridge. Outside the Even App that promise
// never settles (see connectBridge), and a blank installed app is a bad first
// impression — so the page renders first and the glasses attach if they can.

const statusEl = document.querySelector<HTMLElement>('#status')!;
const detailEl = document.querySelector<HTMLElement>('#detail')!;
const readoutEl = document.querySelector<HTMLElement>('#readout')!;

function setStatus(state: 'connecting' | 'linked' | 'standalone', label: string, detail: string) {
  statusEl.dataset.state = state;
  statusEl.textContent = label;
  detailEl.textContent = detail;
}

// Registered before anything else: installability must not depend on the
// glasses being there. Service workers need a secure context, which both
// http://127.0.0.1:<PORT>/ and the hub's https:// tailnet URL satisfy.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* Installability is a nice-to-have; the app works without it. */
    });
  });
}

const TAP_HINT = 'Tap the temple to count · double-tap to exit.';

async function main() {
  setStatus('connecting', 'Connecting…', 'Looking for the Even App bridge.');

  // Two ways to end up companion-only, and both are normal: no bridge object
  // at all, or a bridge with no Even App behind it (see startGlassesPage).
  const bridge = await connectBridge();
  const session = bridge && await startGlassesPage(bridge, `<NAME>\n${TAP_HINT}`);
  if (!session) {
    setStatus(
      'standalone',
      'No glasses',
      'Running as a plain web app — install it to your home screen, or open this ' +
        'URL from the Even Realities app to drive the G2. ' +
        '`npm run qr -- "<the URL you loaded>"` prints a QR to scan.',
    );
    return;
  }

  let taps = 0;
  setStatus('linked', 'Glasses linked', TAP_HINT);
  readoutEl.hidden = false;

  session.onTap(() => {
    taps += 1;
    readoutEl.textContent = String(taps);
    session.render(`Taps: ${taps}\n${TAP_HINT}`);
  });
}

main().catch((err: unknown) => {
  setStatus('standalone', 'Error', err instanceof Error ? err.message : String(err));
});
