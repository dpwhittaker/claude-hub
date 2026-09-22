// Per-session activity, reported by Claude Code hooks (SPEC §V92).
//
//   busy     a prompt was submitted / a tool just finished — the agent is working
//   waiting  a permission prompt or a question is up — it needs the user
//   idle     the turn ended (Stop)
//
// In memory only: a restart forgets everything and every session reads idle
// until its next event, which is the honest default. A `busy`/`waiting` that
// never sees its Stop (a killed session) expires so no dot pulses forever.
'use strict';

const STATES = new Set(['busy', 'waiting', 'idle']);
const STALE_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) { const e = new Error(message); e.statusCode = status; return e; }

function makeActivity({ now = Date.now, staleMs = STALE_MS } = {}) {
  const map = new Map();

  function set(uuid, state) {
    if (!UUID_RE.test(String(uuid))) throw httpError(400, 'bad uuid');
    if (!STATES.has(state)) throw httpError(400, 'bad state');
    const rec = { state, at: now() };
    map.set(uuid.toLowerCase(), rec);
    return { uuid: uuid.toLowerCase(), ...rec };
  }

  function get(uuid) {
    const rec = map.get(String(uuid || '').toLowerCase());
    if (!rec) return null;
    if (rec.state !== 'idle' && now() - rec.at > staleMs) return { state: 'idle', at: rec.at, stale: true };
    return rec;
  }

  // Snapshot for list views.
  function lookup() {
    return (uuid) => get(uuid);
  }

  return { set, get, lookup, STATES };
}

module.exports = { makeActivity, STATES, STALE_MS };
