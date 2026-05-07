const PROJECT_ID_RE = /^[A-Za-z0-9_.-]+$/;
// Reserved against folder names that would collide with hub-level routes.
const RESERVED_PROJECT_NAMES = new Set([
  'develop', 'wsl', 'view', 'term', 'api',
]);

module.exports = { PROJECT_ID_RE, RESERVED_PROJECT_NAMES };
