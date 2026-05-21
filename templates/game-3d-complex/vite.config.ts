import { defineConfig } from 'vite';

// `base` matches the claude-hub proxy prefix so asset URLs resolve correctly
// when the dev server is reverse-proxied at /<NAME>/. SPEC §V.20.
// Havok ships as a WASM module; exclude it from pre-bundling so the .wasm
// asset resolves correctly.
export default defineConfig({
  base: '/<NAME>/',
  optimizeDeps: { exclude: ['@babylonjs/havok'] },
  server: {
    host: '127.0.0.1',
    port: <PORT>,
    strictPort: true,
  },
});
