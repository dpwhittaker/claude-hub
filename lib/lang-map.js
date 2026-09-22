// Highlight.js language hints keyed by file extension. Shared by the v1
// viewer (`renderCode`) and the v2 file API so both colour a file the same
// way. hljs auto-detects what it doesn't know; a hint just makes it faster
// and more accurate.
'use strict';

const HLJS_LANG = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.css': 'css',
  '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.svg': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'ini', '.ini': 'ini', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.rb': 'ruby', '.sql': 'sql', '.dockerfile': 'dockerfile',
  '.gradle': 'gradle', '.gitignore': 'plaintext', '.env': 'plaintext',
  '.txt': 'plaintext', '.log': 'plaintext', '.conf': 'ini', '.md': 'markdown',
  '.markdown': 'markdown', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.lua': 'lua', '.r': 'r', '.scss': 'scss',
  '.less': 'less', '.vue': 'xml', '.svelte': 'xml', '.service': 'ini',
};

function langForFile(name) {
  const base = String(name || '').toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot) : '';
  if (HLJS_LANG[ext]) return HLJS_LANG[ext];
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return '';
}

module.exports = { HLJS_LANG, langForFile };
