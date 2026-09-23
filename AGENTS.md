# claude-hub — AGENTS.md

One page over everything under `~/projects` — sessions, services, files — in
free-form panels, plus the reverse proxy in front of each project's dev
server. Read this before changing code, systemd units or route conventions.

## Workflow rule: commit + push every turn

Every turn that changes code, config, assets, or docs ends with a commit and a
push — don't wait to be asked. One commit per logical change; split unrelated
WIP into separate commits before mixing. Run tests/lint first; if they fail,
fix before committing (`npm test; echo $?` — never pipe the test run into
`grep` and read its exit code, B28's commit slipped through that way). Restart
the relevant systemd unit when the live site needs the change to take effect.
Skip only when the turn produces no working-tree changes.

**Commit explicit paths, never `-A`.** Several Claude sessions share this
worktree (one per terminal tab), so `git add -A` sweeps up whatever a peer
session has half-written. Name what you wrote:
`git commit -m "…" -- lib/foo.js test/foo.test.js`.

## Workflow rule: git worktrees

Parallel work on a project goes in a worktree, not in the parent checkout —
two agents editing one tree is the "peer swept my files" problem above, at
feature scale. Claude Code's `isolation: "worktree"` drops a checkout at
`~/projects/<parent>_<task>/`; give it a `.project-meta.json` naming
`worktreeOf` + `branch` and the hub proxies its dev server on its own port
instead of competing for the parent's. **Never `rm -rf` a worktree** (the
parent's `.git/worktrees/` registry keeps the entry and then refuses to reuse
the path — `git -C <parent> worktree remove --force <dir>`), and a worktree
checks out the parent's README byte-for-byte, so give its sentinel a `title`
and `description` of its own.

## Workflow rule: the spec is the memory (SDD)

`SPEC.md` at the root is this project's durable memory — goals (`§G`),
constraints (`§C`), interfaces (`§I`), invariants (`§V`), tasks (`§T`) and
bugs (`§B`), written compressed enough to reload on every request. Read it
before you change anything; update it in the same turn as the code, never
"later". The loop is: read the spec → work against it → prove each `§V` you
touched with a named test → **backprop** — every bug becomes a `§B` row and its
class becomes a `§V` invariant, so the project stops re-making mistakes it has
already made once.

The part that needs discipline is not writing the spec, it is retiring what a
new requirement invalidated. `§V`/`§I` describe the present and get edited;
`§T`/`§B` are logs and only get appended. Numbers are permanent addresses —
never reused, even after retirement. Before appending an invariant, grep `§V`
for its subject: a rule that changed gets **revised in place at its existing
number**, tagged `(revised)` and carrying `⊥ <the old rule>` so nobody walks
back into it — a rule whose concern is gone gets **deleted**, its retirement
logged in the `§T` row that did the work.

**Full protocol: [`SDD.md`](./SDD.md)** — section reference, the encoding and
its symbol table, backprop, and the maintenance rules for keeping the spec true
as the project grows.

## What it is

```
https://<box>.<tailnet>.ts.net/  →  tailscale serve :443  →  127.0.0.1:8002 (claude-hub)

  /                  the workspace: v2/index.html + app.js (profiles, panels, tabs)
  /v2/*  /api/v2/*   its files and its JSON API            lib/v2-routes.js
  /term/hub/?arg=ID  a session's terminal (ttyd-hub.service → tmux)
  /<proj>/*          a project's dev server, if its .project-meta.json has proxyTarget
  /api/projects POST new repo (template / clone / onboard)  server.js
  /api/term-*        the glasses relay                       lib/term-relay.js
  GET /api/projects, /api/term-sessions/<p>, /api/view-tree/<p>, /view/<p>/<f>
                     read-only shims for the G2 app          lib/g2-compat.js
```

`server.js` is the proxy, the request dispatcher, repo creation and the
relay; everything pure lives in `lib/` and is unit-tested without a server.
Tests that need one use `test/helpers/fixture.js`, which boots `server.js`
in-process on a random port against scratch `PROJECTS_ROOT` and
`HUB_STATE_DIR` dirs.

## The three things on the page

There is no "project" in the UI (the word survives only in `.project-meta.json`
and the repo-creation dialog).

- **Sessions** — an agent (claude / codex / a shell) in some folder under
  `~/projects`, one record at `~/.claude-hub/sessions/<id>.json`, one tmux
  session named by its `termKey` (`hub-<id>`, or the `<project>__sN` name a
  session migrated from v1 kept). ONE ttyd unit serves them all:
  `services/ttyd-hub.service` runs ttyd with `--url-arg`, the tab loads
  `/term/hub/?arg=<id>`, and `services/ttyd-attach-hub.sh <id>` attaches (or
  creates) the tmux session. Creating a session is a file write, not a
  `sudo systemctl enable`. Ending one deletes the record and kills tmux;
  suspending only kills tmux (a reconnect starts it again; a Claude
  conversation resumes by uuid). `lib/v2-sessions.js`.
- **Services** — discovered, not registered (`lib/v2-services.js`): every
  regular unit file in `/etc/systemd/system` that runs as the hub's user or
  works under `$HOME`, plus `vite@`/`jekyll@` instances and sentinel
  `extraUnits`, minus the ttyd family. A unit's URL comes from its sentinel,
  from `~/.claude-hub/services.json`, or from the `tailscale serve` listener
  whose mount targets a port the unit listens on (`ss -ltnp` → cgroup). A
  service tab shows the site / the unit file / a log tail, with start, stop,
  restart in its bar.
- **Files** — anywhere under `~/projects`, through one guard:
  `resolveUnder` in `lib/v2-paths.js` is the whole security story. A file tab
  has Raw / View / Edit / Diff (`lib/v2-fs.js`, `v2/tab-file.js`); saves carry
  the mtime they loaded and get a 409 instead of clobbering an agent's write.

**Profiles** (`lib/v2-profiles.js`) hold a person's tabs + layout under
`~/.claude-hub/profiles/<id>/`, `rev`-checked on save so two devices never
silently clobber each other, and a `CLAUDE.md` appended to every claude
session the profile launches. Which profile a browser uses is
`localStorage['hub.profile']`; `?profile=<id>` on the URL overrides it for
that page load without persisting — use `ai-testing` when driving the UI
from a test browser. Term-tab titles are LIVE (derived from the sessions
list on every page, never written to the profile).

**Layout** (`lib/v2-layout.js`, served to the browser wrapped as
`window.HubLayout`) is a pure tree of proportional splits and panels. Tab
contents live in `#stage`, absolutely positioned over their panel body, so an
iframe never reloads when the layout changes. Width ≤ 75 % of height is
*narrow*: one tab at a time, panels become groups in the ☰ menu. A new tab
lands in the panel with the largest area.

## Claude Code's own records are the truth for a live session

`~/.claude/sessions/<pid>.json` (`lib/claude-registry.js`) names the tmux pane
a running `claude` lives in, the session id it is ACTUALLY on (a `--resume` or
`/clear` mints a new one; the hub follows it into the record so a reboot
resumes the right conversation), its name with source (`user` = `/rename`,
`auto` = Claude's own, `derived` = the `folder-1a` placeholder, never shown)
and its status (busy / waiting / idle), which is what pulses the dot on Home.
When several processes claim one pane — a `claude -p` the session spawned
registers against it too — the earliest-started interactive `cli` entry is the
tab. Recency is the registry's status change (idle TUI repaints bump tmux
activity every few minutes, so tmux activity counts only for codex/shell).

**Titles** follow the newest by time of the registry name and the hub's auto
title, so `/rename` and the titler take turns. `services/session-title-hook.mjs`
runs on `Stop`, forks a detached worker (the hook exits in ms) that asks Haiku
for a 3–7 word title — told to answer `KEEP` unless the purpose drifted, with
no tools and a fenced quoted excerpt so it never acts on the transcript — and
POSTs it to `/api/v2/titles`. A user-typed name is off limits for four prompts
after the rename. Install with `node services/install-session-hooks.mjs`;
`SESSION_TITLES=0` disables; the worker's own `claude -p` runs with
`HUB_TITLE_WORKER=1`, which is the recursion guard. Hooks are read when a
session starts, so a session older than the install never runs it — the
registry needs no hook, which is why it does the live work.

## Project sentinel: `.project-meta.json`

A folder under `~/projects/` with this file is a project the PROXY knows:

```json
{ "name": "<name>", "createdAt": "…", "proxyTarget": "http://127.0.0.1:5173",
  "proxyPrefix": "/<name>", "stripPrefix": false, "extraUnits": ["vite@<name>.service"],
  "openUrl": "/<name>/", "routes": [{ "match": "**/*.md", "to": "/:dir/:name.html" }] }
```

`proxyTarget` + `proxyPrefix` (default `/<name>`) + `stripPrefix` (default
true; `false` for Vite with `base: "/<name>/"`) drive `/<name>/*`. `extraUnits`
and `openUrl` give the unit its site on Home. `routes` (`lib/file-routes.js`,
V54) maps a source file to the URL it renders at, so View on an `.md` behind a
Jekyll or SPA dev server shows the live page. `title` / `description` override
the README for a worktree. The route table is rebuilt on startup and after a
create — no restart.

## systemd units

Source unit files live in `services/`. Install with `sudo install -m 644
services/<file> /etc/systemd/system/`, then `sudo systemctl daemon-reload &&
sudo systemctl enable --now <unit>`.

| Unit | What it runs |
|---|---|
| `services/claude-hub.service` | `node server.js`. `KillMode=process` so a restart never kills the ttyd/tmux children. |
| `services/ttyd-hub.service` | ttyd on `/run/ttyd/hub.sock` with `--url-arg`; `ttyd-attach-hub.sh` (installed to `/usr/local/bin`) attaches the id's tmux session. `KillMode=process`: the first attach after a boot starts the user's tmux server INSIDE this cgroup, and a unit restart must not take every session with it. `RuntimeDirectoryPreserve=yes`. |
| `services/vite@.service` / `services/jekyll@.service` | Templated dev servers, `Restart=always`; enabled by the scaffolds. |
| `services/stt.service` | faster-whisper on `127.0.0.1:8012` for the glasses (`/api/stt`). |

## Retiring v1 (done 2026-09-23)

v1 kept one `ttyd@<project>__sN.service` per tab and a
`.develop-sessions.json` per project. `services/migrate-v1-sessions.mjs`
turned every tab whose tmux session was alive into a hub session that KEPT
its tmux name, let the dead ones expire, retargeted profile tabs and renamed
each map to `.v1`. The v1 units were `disable`d but NOT stopped: the user's
tmux server lives in one of their cgroups (stopping that unit would kill every
session), so they run until the next reboot and never come back. The unit
files and `ttyd-attach.sh` are gone from `/etc` and the repo.

## Glasses relay (claude-hub-g2)

The G2 app reads a terminal through tmux — `/api/term-capture` for the text,
`/api/term-input` for typed/spoken prompts, `/api/term-scroll` for wheel
ticks — and answers Claude's interactive prompts through
`services/glasses-relay-hook.mjs` (`node services/install-glasses-hooks.mjs`
wires it). The hook is inert unless a glasses client polled
`/api/term-capture/<key>` within the last 5 s; a held prompt goes back to the
TUI when the glasses stop polling or after 540 s. The glasses compose a key as
`<project>__<id>`; `canonicalTermKey` in `server.js` strips that prefix off a
`hub-…` name. Until claude-hub-g2 is ported to `/api/v2/*`, `lib/g2-compat.js`
answers its four v1 reads from v2 data.

## Mobile terminal input

Every `/term/<key>/` HTML response gets the shims spliced into `<head>` on the
way through the proxy: `installOsc52Bridge` (tmux `set-clipboard` → host
clipboard), `installTermReconnect` (V63/V64: ttyd parks on "Press ⏎ to
Reconnect" after a network drop; the shim retries and refits), the
scrollbar-hide style, `installTouchWheel`, `installKeyboardFit` (V62) and
`installAndroidInput` (V61, B17/B18/B23 — Gboard drops keystrokes through
xterm's `CompositionHelper`; the shim diffs the textarea synchronously). All
five are `.toString()`-inlined, so they must stay self-contained. **Upgrading
ttyd/xterm invalidates their premises** — re-check the bundle before shipping
an upgrade; `grep -o '.\{160\}<symbol>.\{240\}'` over `/term/hub/` recovers
any minified handler.

## Repo creation

`POST /api/projects` body `{name, template, github: {mode: skip|clone|create|onboard,
source?, visibility?}, firebase?, profile?}`. Templates: `vite` (default),
`game-2d`, `game-3d`, `game-3d-complex`, `jekyll`, `evenhub`, `none`.
Vite-family scaffolds copy `templates/<id>/` with `<NAME>`/`<PORT>`/`<NAMESLUG>`
replaced, allocate a port ≥ 5173, `npm install` with `NODE_ENV=development`
(B20 — the hub's own `NODE_ENV=production` would skip devDependencies) and
enable `vite@<name>.service`; `jekyll` bundles into `vendor/bundle` and enables
`jekyll@<name>.service` on a 4000s port. Every path ends by creating a hub
session in the folder, seeded with the bootstrap prompt
(`lib/bootstrap-prompt.js`), and returns `{name, sessionId, termKey, termUrl}`.
Template trees are UTF-8 text only (V71); every vite template sets
`server.allowedHosts: ['.ts.net', 'localhost']` (V66, B21).

## Common ops

```bash
systemctl is-active claude-hub.service ttyd-hub.service
journalctl -u claude-hub.service -f
sudo systemctl restart claude-hub.service      # server.js / lib/ are held in memory
                                               # v2/* is read per request — no restart
curl -s http://127.0.0.1:8002/api/v2/sessions | jq .
curl -s http://127.0.0.1:8002/api/v2/services | jq .
```

## Where the code lives

| module | what |
|---|---|
| `lib/v2-routes.js` | the `/v2/` files, `/api/v2/*`, markdown render, `claude -p` completion |
| `lib/v2-layout.js` | split/panel tree, pure, shared with the browser |
| `lib/v2-paths.js`, `lib/v2-fs.js` | the path guard; list/read/write/diff/log |
| `lib/v2-profiles.js`, `lib/v2-sessions.js`, `lib/v2-services.js`, `lib/v2-titles.js` | the stores and discovery |
| `lib/claude-registry.js`, `lib/claude-transcript.js`, `lib/session-title.js` | Claude Code's live registry, its transcripts, the titler's digest + prompt |
| `lib/v1-migrate.js`, `lib/g2-compat.js` | the v1 migration; the glasses shim (delete when g2 is ported) |
| `lib/term-relay.js` | watched-terminal registry + held prompts behind `/api/term-*` |
| `lib/template.js`, `lib/template-policy.js`, `lib/port-alloc.js`, `lib/scaffold-install.js`, `lib/onboard.js`, `lib/gh-repos.js`, `lib/bootstrap-prompt.js`, `lib/file-routes.js`, `lib/readme-meta.js` | repo creation and the sentinel readers |
| `lib/android-input.js`, `lib/keyboard-fit.js`, `lib/term-reconnect.js`, `lib/osc52.js`, `lib/touch-wheel.js` | the injected terminal shims |
| `v2/app.js`, `v2/tabs.js`, `v2/tab-home.js`, `v2/tab-file.js`, `v2/app.css`, `v2/index.html` | the workspace, tab kinds, Home + Explorer, the file tab |

See `SPEC.md` §V for the invariants and §B for every bug that got out.

## Hindsight memory (optional)

Per-repo long-term memory for Claude sessions on this box — harness-level, in
`~/.hindsight/` and `~/.claude/`, nothing here depends on it. Install, version
table and gotchas: [`HINDSIGHT.md`](HINDSIGHT.md).
