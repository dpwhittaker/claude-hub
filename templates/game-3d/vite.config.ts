import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` matches the claude-hub proxy prefix so asset URLs resolve correctly
// when the dev server is reverse-proxied at /<NAME>/. SPEC §V.20.
export default defineConfig({
  base: '/<NAME>/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: <PORT>,
    strictPort: true,
    // The hub forwards the original Host header, and Vite 7 rejects any host it
    // doesn't recognise with a 403 "Blocked request. This host is not allowed."
    // A loopback test passes while the tailnet URL 403s, so this is invisible
    // until you open the real link. The leading dot is a suffix wildcard for
    // any MagicDNS name — it keeps this machine's FQDN out of the repo.
    // SPEC §V66.
    allowedHosts: ['.ts.net', 'localhost'],
  },
});
