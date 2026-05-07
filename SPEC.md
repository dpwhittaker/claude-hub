# SPEC

## §G GOAL

path-routed reverse proxy + landing page. one local port → multi-project hub. landing, file viewer, ttyd terms, optional per-project app proxy.

## §C CONSTRAINTS

- Node ≥ 22 (marked v18 ESM-only). single process, no framework.
- bind `127.0.0.1` only. external reach via Tailscale (see `.claude/skills/tailscale/`).
- deps locked: `http-proxy ^1.18.1`, `marked ^18.0.3`, `ws ^8.20.0`. CommonJS.
- projects root = `~/projects` (env `PROJECTS_ROOT` overrides).
- proxy port 8002 (env `PROXY_PORT` overrides).
- ttyd unix sockets only — no TCP. socket dir = `XDG_RUNTIME_DIR` else `/tmp`, mode `0o700`.
- claude binary = env `CLAUDE_BIN` else `~/.local/bin/claude`.
- systemd-managed. units in `services/`. `RuntimeDirectoryPreserve=yes` required on every ttyd unit.
- file viewer read-only. methods ≠ GET/HEAD → 405.
- view tree node cap = 5000. file render cap = 2 MB.
- project name regex = `/^[A-Za-z0-9_.-]+$/`. reserved names `{develop, wsl, view, term, api}`.
- new projects scaffold Vite (React + TS) by default. opt-out via `template: 'none'`. `npm` ! in PATH at hub runtime.
- per-project Vite port allocated free, ≥ 5173. persisted as `proxyTarget` in `.project-meta.json`.

## §I INTERFACES

routes (proxy):
- `GET /` → `landing.html`
- `GET /api/projects` → `{projects: [...]}`
- `POST /api/projects` body `{name, github?: {mode: skip|clone|create, source?, visibility?}, template?: 'vite'|'none'}` → `{ok, project}` (default `template: 'vite'`)
- `DELETE /api/projects/<name>` → stop `ttyd@<name>` + `extraUnits`, kill tmux, rm folder
- `GET /api/view-tree/<proj>` → `{project, tree}`. `?path=<sub>` → one-level lazy `{project, path, entries}`
- `GET /view/<proj>/` → two-pane shell
- `GET /view/<proj>/<file>` → rendered. `?embed=1` strip chrome. `?raw=1` raw bytes
- `GET /term/<proj>/` → proxy to `unix:/run/ttyd/<proj>.sock` (HTTP + WS upgrade)
- `GET /term/develop/`, `GET /term/wsl/` → admin terms
- `GET|*  /<proj>/*` → reverse-proxy if `.project-meta.json` declares `proxyTarget`
- `WS /ws/view-tree/<proj>` → live tree updates `{type: add|delete|change, path, kind?}`

files:
- `services/claude-hub.service` — proxy unit
- `services/ttyd@.service` — templated per-project term
- `services/ttyd-develop.service`, `services/ttyd-wsl.service` — admin terms
- `services/ttyd-attach.sh` — joins/creates tmux session, runs `claude --continue` ?
- `services/vite@.service` — templated per-project Vite dev server. `ExecStart=npm run dev`, `WorkingDirectory=~/projects/%i`. enabled on Vite-template bootstrap.
- `templates/vite/` — scaffold source (`package.json`, `vite.config.ts`, `index.html`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `.gitignore`). copied into project on create. `<NAME>` & `<PORT>` placeholders replaced.
- `lib/tab-key.js` — single-source `tabKey(p, mode)`. server inlines via `.toString()` into client template.
- `lib/port-alloc.js` — `allocatePort(projectsRoot)` scans sibling `.project-meta.json` for free port ≥ 5173.
- `lib/template.js` — `replaceVars` + `copyTemplate` for scaffold copy w/ `<KEY>` substitution.
- `eslint.config.js` — flat config (`@eslint/js` recommended + node globals).
- `.github/workflows/ci.yml` — push/PR trigger; `npm ci` + `npm run lint` + `npm test` on Node 22.
- `<project>/.project-meta.json` — sentinel. fields: `name, createdAt, openUrl?, proxyTarget?, proxyPrefix?, stripPrefix?, extraUnits?, template?`
- `<project>/README.md` — H1 = card title, first para = description, frontmatter `tags: [...]` = badges
- `<project>/AGENTS.md` — agent context (per project)
- `<project>/vite.config.ts` (Vite template) — `base: '/<name>/'`, `server.port: <port>`, `server.host: '127.0.0.1'`

env:
- `PROXY_PORT` (default 8002)
- `PROJECTS_ROOT` (default `~/projects`)
- `CLAUDE_BIN` (default `~/.local/bin/claude`)
- `TTYD_BIN` (default `ttyd`)
- `GIT_AUTHOR_NAME` (optional; passed as `git -c user.name=...` during `bootstrapCreateRepo` / `ghInitPush`. empty = let git use global config)
- `GIT_AUTHOR_EMAIL` (optional; same)

module exports (test surface, not public API):
- `server` — `http.Server` instance, lazy-listened (guard: `require.main === module`)
- `PROJECT_ID_RE`, `RESERVED_PROJECT_NAMES` — name validation primitives
- `projectWatchers` — `Map<project, { watcher, clients, pending, dimRefresh }>`. tests probe `.has(project)` for teardown checks.

## §V INVARIANTS

- V1: ∀ req → URL path validated before disk access. file paths ! `startsWith(projectRoot + sep)` else 400.
- V2: project name ! match `PROJECT_ID_RE` & ∉ `RESERVED_PROJECT_NAMES` & ! starts with `.` else 404.
- V3: `/view/*` methods ∈ `{GET, HEAD}` else 405.
- V4: `ttyd-attach.sh` ! pass `--continue` unless `~/.claude/projects/<encoded>/*.jsonl` exists. ⊥ exit-loop.
- V5: every ttyd unit ! carry `RuntimeDirectoryPreserve=yes`. ⊥ shared `/run/ttyd/` wipe.
- V6: file render size ≤ 2 MB, else 413 + suggest `?raw=1`.
- V7: tree node count ≤ 5000 per walk. dim dirs not recursed eagerly.
- V8: `.project-meta.json` required as sentinel for managed-project listing & deletion.
- V9: WS file-watcher events ! filter dim paths (gitignored + hidden dirs). ⊥ noise from `node_modules` builds.
- V10: WS `change` event fired iff path ∈ `knownFiles` at watcher seed. else `add` & insert into `knownFiles`.
- V11: viewer iframe reload on `change` ! preserve scroll via `contentWindow.scrollTo(prevX, prevY)` after `load`.
- V12: dir delete → drop descendants from `knownFiles` & `knownDirs` (Linux recursive watch may skip per-child).
- V13: project create → `mkdir` + `.project-meta.json` + `README.md` + `AGENTS.md` + `sudo systemctl enable --now ttyd@<name>` ! all atomic. partial fail → cleanup.
- V14: WS upgrade `/ws/view-tree/<proj>` handled in-process (`viewTreeWss`). proxy upgrade only after non-match.
- V15: tab state per project keyed by `mode + '\0' + path` (NUL separator — only byte forbidden in POSIX paths). localStorage `view-shell:tabs:<proj>` + `view-shell:active:<proj>`. ⊥ cross-project bleed. ⊥ collision w/ filenames containing mode-prefix string.
- V16: HTML eye-icon tab uses `?raw=1`. RAW_MIME[.html] = `text/html; charset=utf-8`. ⊥ octet-stream fallback for `.html`.
- V17: WSL2 self-loopback to `*.ts.net` URL fails (route lives on Windows tailscale virtual interface). test from Windows or peer.
- V18: ⊥ orphan `node server.js` binding 8002 — systemd owns it. fix on EADDRINUSE: `pkill -f 'node.*server.js'` then `systemctl restart claude-hub.service`.
- V19: project HTTP backends ! concurrent (`ThreadingHTTPServer` or async). stock `http.server.HTTPServer` single-threaded → `CLOSE_WAIT` pile, wedge.
- V20: Vite-style upstreams ! `base: '/<name>/'` + `.project-meta.json` `stripPrefix: false`. else asset URLs collapse.
- V21: project create default `template: 'vite'` (React + TS). `template: 'none'` = legacy bare AGENTS+README only.
- V22: per-project Vite port = free port ≥ 5173, allocated by in-process scanner before scaffold. persisted as `proxyTarget` in `.project-meta.json`. ⊥ collision.
- V23: Vite template scaffold ! stamp `.project-meta.json` w/ `proxyTarget: 'http://127.0.0.1:<port>'`, `proxyPrefix: '/<name>'`, `stripPrefix: false`, `openUrl: '/<name>/'`, `template: 'vite'`, `extraUnits: ['vite@<name>.service']`. enforces V20.
- V24: Vite scaffold post-step → `npm install` (background) + `sudo systemctl enable --now vite@<name>.service`. install fail → cleanup dir, return 500 (extends V13).
- V25: `services/vite@.service` ! carry `Restart=always`, `RestartSec=2`. dev server crash → auto-recover w/o user touching systemd.
- V26: project deletion ! stop `vite@<name>.service` via `extraUnits` before rm. ⊥ orphan port held.
- V27: WS reconnect → force-reload every open tab (cache-bust). recover from `change` events missed during disconnect window. preserve scroll per V11.
- V28: per-tab scroll position persisted to `view-shell:scroll:<proj>:<key>` localStorage. restored on iframe `load`. survives page refresh + tab close/reopen.

## §T TASKS

| id | status | task | cites |
|---|---|---|---|
| T1 | x | Node http proxy + landing | I.routes |
| T2 | x | `/api/projects` GET/POST/DELETE | I.routes,V13 |
| T3 | x | `/api/view-tree` w/ lazy `?path=` | V7 |
| T4 | x | `/view/*` markdown+code+raw render | V3,V6 |
| T5 | x | two-pane viewer shell, splitter, tabs | I.routes |
| T6 | x | tab persistence per project (localStorage) | V15 |
| T7 | x | develop pane (terminal iframe) toggle + splitter | - |
| T8 | x | HTML eye-icon → `?raw=1` render tab | V16 |
| T9 | x | `/ws/view-tree/<proj>` live updates | V9,V14 |
| T10 | x | watcher emits add/delete in-place, no full reload | V10,V12 |
| T11 | x | watcher emits `change` → iframe reload preserves scroll | V10,V11 |
| T12 | x | services moved to `services/` | I.files |
| T13 | x | tailscale skill split out of AGENTS.md | I.files |
| T14 | x | tests: route validation + path traversal | V1,V2,V3 |
| T15 | x | tests: WS lifecycle + dedup events | V9,V10,V12 |
| T16 | x | tests: tab key collision (`render:` prefix vs path) | V15 |
| T17 | x | watcher recursive on Linux Node 24 — failure-mode test (inotify limit) | V9 |
| T18 | x | CI/lint pipeline: ESLint flat config + GH Actions Node 22 | C.deps |
| T19 | x | add `templates/vite/` w/ React+TS scaffold + `<NAME>`/`<PORT>` placeholders | I.files,V21 |
| T20 | x | add `services/vite@.service` template (`npm run dev`, Restart=always) | I.files,V25 |
| T21 | x | port allocator: scan free port ≥ 5173 not in any project's `.project-meta.json` | V22 |
| T22 | x | `bootstrapVite(dir, name, port)` — copy template, replace placeholders, write meta, `npm install`, enable `vite@<name>` | V21,V23,V24 |
| T23 | x | `POST /api/projects` accepts `template` field; default `'vite'`, dispatch `bootstrapVite` vs `bootstrapNoGithub` | I.routes,V21 |
| T24 | x | `landing.html` create dialog: template select (Vite default \| None) | I.routes |
| T25 | x | `handleDeleteProject` — `extraUnits` already covers `vite@<name>.service` once meta stamped | V26 |
| T26 | x | update README.md + AGENTS.md w/ Vite-default workflow + install steps for `vite@.service` | I.files |
| T27 | x | WS reconnect handler force-reloads all open tabs via `reloadTabFrame` | V11,V27 |
| T28 | x | per-tab scroll persisted to localStorage; restored on iframe load | V28 |

## §B BUGS

| id | date | cause | fix |
|---|---|---|---|
| B1 | 2026-05-05 | `nohup node server.js` orphan binds 8002 → systemd unit fail w/ `EADDRINUSE` | V18 |
| B2 | 2026-05-05 | single ttyd stop wipes shared `/run/ttyd/`, orphans peer sockets | V5 |
| B3 | 2026-05-05 | stock `http.server.HTTPServer` wedges → `CLOSE_WAIT` pile, no response | V19 |
| B4 | 2026-05-05 | Vite app asset URLs collapse w/o `base` + `stripPrefix:false` | V20 |
| B5 | 2026-05-05 | `claude --continue` on fresh project → exit-loop (no prior session) | V4 |
| B6 | 2026-05-05 | tab key `'render:' + path` collides w/ filename literally `render:foo` (Linux allows `:` in names) | V15 |
| B7 | 2026-05-05 | WS dropped on server restart; client reconnect backoff 1–30s; edits during gap → no `change` events → tab stale | V27 |
