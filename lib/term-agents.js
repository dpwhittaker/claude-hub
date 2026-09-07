/**
 * The develop-pane "+" menu: which agent a new terminal tab should run.
 *
 * Both shells (`lib/view-shell.js` for Browse, `lib/pwa-shell.js` for the
 * installed PWA) inline `openAgentMenu` into their client script via
 * `.toString()`, so it must be self-contained — every value it needs arrives
 * as an argument, never as a module-scope reference (V42; see B10 for what
 * happens when one sneaks in). `TERM_AGENTS` is serialized into the page as a
 * JSON literal rather than referenced by name for the same reason.
 */

// Offer order in the menu. Mirrors `AGENTS` in lib/term-sessions.js, which is
// the server-side validator — a label here without an id there is a 400.
const TERM_AGENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

/**
 * Open a one-shot menu anchored under `anchor`, offering `agents`. Calling it
 * again while a menu is open closes it instead (the "+" button toggles).
 * `onPick` gets the chosen agent id; dismissal — outside click, Escape,
 * scroll — calls nothing.
 *
 * @param {Element}  anchor  the "+" button
 * @param {Array<{id: string, label: string}>} agents
 * @param {(agentId: string) => void} onPick
 * @returns {Element|null} the menu, or null when the call closed an open one
 */
function openAgentMenu(anchor, agents, onPick) {
  const doc = anchor.ownerDocument;
  const open = doc.querySelector('.term-agent-menu');
  if (open) {
    if (typeof open.__close === 'function') open.__close();
    else open.remove();
    return null;
  }

  const menu = doc.createElement('div');
  menu.className = 'term-agent-menu';
  menu.setAttribute('role', 'menu');

  function close() {
    menu.remove();
    doc.removeEventListener('click', onDocClick, true);
    doc.removeEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'false');
  }
  function onDocClick(e) {
    if (menu.contains(e.target) || e.target === anchor) return;
    close();
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    close();
    if (typeof anchor.focus === 'function') anchor.focus();
  }
  menu.__close = close;

  for (const agent of agents) {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'term-agent-item';
    item.setAttribute('role', 'menuitem');
    item.dataset.agent = agent.id;
    item.textContent = agent.label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      onPick(agent.id);
    });
    menu.appendChild(item);
  }

  // Anchored to the "+" itself, not to the strip: the strip scrolls
  // horizontally, so a menu positioned by the strip drifts off the button.
  // position:fixed, hence viewport coordinates straight off the rect.
  if (typeof anchor.getBoundingClientRect === 'function') {
    const rect = anchor.getBoundingClientRect();
    const width = (doc.documentElement && doc.documentElement.clientWidth) || 0;
    const left = width ? Math.max(4, Math.min(rect.left, width - 148)) : rect.left;
    menu.style.left = left + 'px';
    menu.style.top = rect.bottom + 'px';
  }

  doc.body.appendChild(menu);
  anchor.setAttribute('aria-expanded', 'true');
  // Added while this click is still being dispatched — document's capture
  // phase has already passed, so the opening click can't immediately close it.
  doc.addEventListener('click', onDocClick, true);
  doc.addEventListener('keydown', onKey, true);
  const first = menu.querySelector('.term-agent-item');
  if (first && typeof first.focus === 'function') first.focus();
  return menu;
}

module.exports = { TERM_AGENTS, openAgentMenu };
