const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'templates/**',
      '.claude/**',
      'dist/**',
      '.vite/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  // The two files that run in the browser, not under node. Everything else
  // here is CommonJS server code; the shims under lib/ are node modules whose
  // functions are stringified into a page, so they keep the node globals and
  // take `window`/`document` as arguments (V42).
  {
    files: ['assets/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['upload-dialog.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // The hub v2 shell: classic browser scripts sharing `window.Hub`, with
  // lib/v2-layout.js served to them wrapped as `window.HubLayout`.
  {
    files: ['v2/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  // The glasses relay hook + its installer are ESM scripts run by node.
  {
    files: ['services/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  // The Omni glasses app root: ESM (glasses/package.json), run by the omnieven server.
  {
    files: ['glasses/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];
