// Text helpers for the glasses app (SPEC §V100). Pure, ESM, tested from
// test/glasses-text.test.js via dynamic import.

export const ICON = { dir: '▶', file: '◈', term: '▤', busy: '●', waiting: '◐', idle: '○', off: '·', more: '…' };
export const LIST_MAX = 20;          // firmware: ≤20 items per native list
export const ITEM_MAX = 64;          // firmware: ≤64 chars per item
export const BODY_MAX_BYTES = 1800;  // in-place text update cap is 1999 bytes; keep headroom

export function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + ICON.more;
}

export function label(icon, text) {
  return truncate(`${icon} ${text}`, ITEM_MAX);
}

// Claude Code's TUI chrome, which drowns a glasses screen once a wide pane
// is wrapped: separator rules collapse to one short rule, the status/mode
// lines and the empty prompt go, blank runs shrink to one.
const SEPARATOR_RE = /^[\s─━═╌┄╍┅\-_]{4,}$/;
const CHROME_RE = [
  /\| sess \d+%/,             // "Fable 5.1 | sess 2% (37m left) | week 22% …"
  /^\s*(⏵⏵|⏸|⏵)\s/,           // "⏵⏵ auto mode on (shift+tab to cycle)"
  /\? for shortcuts/,
  /^\s*❯\s*$/,                // the empty input prompt
];
export function cleanTerminal(lines) {
  const out = [];
  for (const raw of lines || []) {
    const line = String(raw).replace(/\s+$/, '');
    if (CHROME_RE.some((re) => re.test(line))) continue;
    if (SEPARATOR_RE.test(line) && line.trim()) {
      if (out[out.length - 1] !== '────') out.push('────');
      continue;
    }
    if (line === '' && out[out.length - 1] === '') continue;
    out.push(line);
  }
  while (out.length && (out[out.length - 1] === '' || out[out.length - 1] === '────')) out.pop();
  return out;
}

// The last lines that fit the byte budget (the glasses take ~1.9 KB per
// text container; the reader wants the newest end of a terminal).
export function tailBytes(lines, maxBytes = BODY_MAX_BYTES) {
  const out = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (used + n > maxBytes) break;
    out.unshift(lines[i]);
    used += n;
  }
  return out;
}

// One page of a long list: LIST_MAX-1 items plus a "more" row when needed.
export function listPage(items, page) {
  const per = LIST_MAX - 1;
  const start = page * per;
  const slice = items.slice(start, start + per);
  const left = items.length - (start + slice.length);
  return { slice, hasMore: left > 0, left };
}

export function summarizeInput(input) {
  const pick = ['command', 'file_path', 'path', 'url', 'description', 'pattern'];
  for (const k of pick) if (input && typeof input[k] === 'string' && input[k]) return input[k];
  return JSON.stringify(input || {}).slice(0, 80);
}

// A session's one-line label: state glyph, title (or its folder), folder.
export function sessionLabel(s) {
  const glyph = !s.running ? ICON.off : s.activity === 'busy' ? ICON.busy : s.activity === 'waiting' ? ICON.waiting : ICON.idle;
  const title = s.title || (s.cwd ? s.cwd.split('/').pop() : '/');
  const where = '/' + (s.cwd || '');
  return truncate(`${glyph} ${title}${title === where.slice(1) ? '' : ' · ' + where}`, ITEM_MAX);
}
