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
  },
});
