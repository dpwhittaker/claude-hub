import { defineConfig } from 'vite';

// `base` matches the claude-hub proxy prefix so asset URLs resolve correctly
// when the dev server is reverse-proxied at /<NAME>/. SPEC §V.20.
//
// It is also the PWA's identity: `public/manifest.webmanifest` declares the
// same path as `start_url` + `scope`, and `public/sw.js` is served from it, so
// the service worker's scope is this prefix and nothing else on the hub.
// Change one, change all four (base, start_url, scope, sentinel proxyPrefix).
export default defineConfig({
  base: '/<NAME>/',
  server: {
    host: '127.0.0.1',
    port: <PORT>,
    strictPort: true,
    // The hub forwards the original Host header, and Vite 7 rejects any host it
    // doesn't recognise with a 403 "Blocked request. This host is not allowed."
    // A loopback test passes while the tailnet URL 403s, so this is invisible
    // until you open the real link — which is the link the glasses load.
    // SPEC §V66.
    allowedHosts: ['.ts.net', 'localhost'],
  },
  // The G2 WebView is current Chromium / WKWebView — no legacy transpile needed.
  build: { target: 'esnext' },
});
