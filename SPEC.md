# SPEC

## §G GOAL

path-routed reverse proxy + landing page. one local port → multi-project hub. landing, file viewer, ttyd terms, optional per-project app proxy.

## §C CONSTRAINTS

- Node ≥ 22 (marked v18 ESM-only). single process, no framework.
- bind `127.0.0.1` only. external reach via Tailscale (see `.claude/skills/tailscale/`).
- deps locked: `http-proxy ^1.18.1`, `marked ^18.0.3`, `ws ^8.20.0`. CommonJS.
- projects root = `~/projects` (env `PROJECTS_ROOT` overrides).
- proxy port 8002 (env `PROXY_PORT` overrides).
- ttyd unix sockets only — no TCP. socket dir = `/run/ttyd/`, owner=david, mode `0755` (systemd `RuntimeDirectory=ttyd`).
- claude binary = env `CLAUDE_BIN` else `~/.local/bin/claude`.
- systemd-managed. units in `services/`. `RuntimeDirectoryPreserve=yes` required on every ttyd unit.
- `npm` in PATH at hub runtime (vite scaffold + per-project install).

## §I INTERFACES

routes (proxy):
- `GET /` → `landing.html`
- `GET /api/projects` → `{projects: [...]}`
- `POST /api/projects` body `{name, github?: {mode: skip|clone|create|onboard, source?, visibility?}, template?: 'vite'|'none'}` → `{name, termUrl, browseUrl}`. `template` defaults `'vite'`, forced `'none'` when `github.mode ∈ {clone, onboard}`. every mode ends w/ `sudo systemctl enable --now ttyd@<name>.service` (V13). onboard adopts an existing folder under `PROJECTS_ROOT` named `name`; ⊥ clone, ⊥ scaffold on onboard.
- landing dialog field order: Project name → GitHub → Template. GitHub radio order: Clone (default) → Onboard existing folder → Skip → Create. Template fieldset hidden (display:none) when GitHub mode ∈ {clone, onboard}; visible for skip/create.
- `DELETE /api/projects/<name>` → `sudo systemctl disable --now ttyd@<name>.service`, then `extraUnits`, kill tmux, rm folder
- `GET /api/view-tree/<proj>` → `{project, tree}`. `?path=<sub>` → one-level lazy `{project, path, entries}`
- `GET /view/<proj>/` → two-pane shell
- `GET /view/<proj>/<file>` → rendered. `?embed=1` strip chrome. `?raw=1` raw bytes
- `GET /term/<proj>/` → proxy to `unix:/run/ttyd/<proj>.sock` (HTTP + WS upgrade)
- `GET /term/develop/`, `GET /term/wsl/` → admin terms
- `GET|*  /<proj>/*` → reverse-proxy if `.project-meta.json` declares `proxyTarget`
- `WS /ws/view-tree/<proj>` → live tree updates `{type: add|delete|change, path, kind?}`
- `GET /api/gh/repos` → `{repos: [{nameWithOwner, description, isFork, isPrivate, updatedAt}]}`. sort: non-forks first then forks; within each group `updatedAt` desc. 503 on `gh` failure. cached in-process, 10 min TTL. response excludes candidates whose basename matches an existing folder under `PROJECTS_ROOT` (managed or not).
- `GET /api/projects/orphans` → `{folders: [string]}`. dirs under `PROJECTS_ROOT` that exist but lack `.project-meta.json` and don't start with `.`.

files:
- `services/claude-hub.service` — proxy unit
- `services/ttyd@.service` — templated per-project term
- `services/ttyd-develop.service`, `services/ttyd-wsl.service` — admin terms
- `services/ttyd-attach.sh` — joins/creates tmux session, runs `claude --continue` (gated by V4).
- `services/vite@.service` — templated per-project Vite dev server. `ExecStart=npm run dev`, `WorkingDirectory=~/projects/%i`. enabled on Vite-template bootstrap.
- `templates/vite/` — scaffold source (`package.json`, `vite.config.ts`, `index.html`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `.gitignore`). copied into project on create. `<NAME>` & `<PORT>` placeholders replaced.
- `lib/tab-key.js` — `tabKey(p, mode)`. server inlines via `.toString()` into client template.
- `lib/port-alloc.js` — `allocatePort(projectsRoot)` scans sibling `.project-meta.json` for free port ≥ 5173.
- `lib/template.js` — `replaceVars` + `copyTemplate` for scaffold copy w/ `<KEY>` substitution.
- `lib/project-name.js` — `PROJECT_ID_RE`, `RESERVED_PROJECT_NAMES` primitives. server.js re-exports.
- `lib/bootstrap-prompt.js` — `writeBootstrapPrompt(dir, name, flavor)`.
- `lib/template-policy.js` — `effectiveTemplate(body)` (V21 + clone/onboard force).
- `lib/gh-repos.js` — `makeGhRepos({exec, ttlMs, now})` cache + `filterReposByFolders(repos, folders)`.
- `lib/onboard.js` — `bootstrapOnboard(dir, name)` + `listOrphanFolderNames(projectsRoot)`.
- `lib/tab-reload-targets.js` — `isEmbedder(path)` + `tabsToReload(tabs, changedPath)`. inlined into client via `.toString()`.
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
- V24: Vite scaffold post-step → `npm install` + `sudo systemctl enable --now vite@<name>.service`. cleanup-on-fail per V13.
- V25: `services/vite@.service` ! carry `Restart=always`, `RestartSec=2`. dev server crash → auto-recover w/o user touching systemd.
- V26: project deletion ! stop `vite@<name>.service` via `extraUnits` before rm. ⊥ orphan port held.
- V27: WS reconnect → force-reload every open tab (cache-bust). recover from `change` events missed during disconnect window. preserve scroll per V11.
- V28: per-tab scroll position persisted to `view-shell:scroll:<proj>:<key>` localStorage. restored on iframe `load`. survives page refresh + tab close/reopen.
- V29: `github.mode === 'clone'` preserves cloned tree verbatim. `AGENTS.md` / `README.md` written **only if missing**. ⊥ overwrite of pre-existing docs.
- V30: (merged into V31).
- V31: bootstrap prompt branches, written to `<project>/.claude-bootstrap.txt` and consumed by `ttyd-attach.sh` `tmux send-keys` (read + send + delete):
  - **scan-existing** (clone / onboard): Claude walks tree first turn and writes whichever of `README.md` (human-facing — purpose + "what is this & why") or `AGENTS.md` (agent-facing — tech stack, conventions, directory layout, debugging signposts) is missing. ⊥ overwrite per V29.
  - **greenfield** (skip / create + vite or none): Claude greets, asks "what should we build here?".
- V32: `/api/gh/repos` runs `gh repo list --json nameWithOwner,description,isFork,isPrivate,updatedAt --limit 200`. result cached in-process w/ ≤ 10 min TTL. ⊥ shell-out per dialog open. response excludes any candidate whose basename matches an existing folder under `PROJECTS_ROOT` (managed or not). sort: `isFork=false` first then `isFork=true`; `updatedAt` desc within each group. ⊥ user's own forks dominate top of dropdown.
- V33: dialog clone-source is a `<select>` populated async from `/api/gh/repos`. on fetch failure / empty / timeout → fall back to free-text `<input>`. ⊥ block dialog while waiting.
- V34: cloning another user's repo = fork on github.com first, pick the fork from the dropdown. arbitrary-URL clone still possible via direct `POST /api/projects` w/ `source: 'owner/repo'` (power-user flow), but not via the dialog.
- V35: Clone is the default GitHub mode in the create dialog. Default dialog open state → Template fieldset hidden.
- V36: `github.mode === 'onboard'` adopts an existing folder under `PROJECTS_ROOT`. Stamps sentinel `.project-meta.json` w/ `name + createdAt` only (no `github`, no `template`). Writes scan-existing bootstrap prompt. 409 if `.project-meta.json` already exists. 404 if folder missing. ⊥ overwrite of any existing file in the tree. ttyd@ enable per V13.
- V37: dialog onboard mode populates `<select>` from `/api/projects/orphans`. Empty list → mode option disabled w/ hint "no orphan folders under ~/projects".
- V38: develop pane orientation = side-by-side (terminal right) iff viewport `width > 1.2 * height`; else stacked (terminal below file viewer). re-evaluate on `window.resize` + initial mount. splitter axis + pane flex-direction swap atomically. separate persisted size keys per orientation. ⊥ stale layout on viewport rotate/resize.
- V39: `ttyd-attach.sh` `CLAUDE_BIN` default ! match §C claude-binary default (`$HOME/.local/bin/claude`). bare `claude` ⊥ resolve in systemd PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin`) → tmux command fails → session dies → V4 exit-loop trip.
- V40: develop-pane terminal iframe ! translate touch-drag → synthetic `wheel` events on iframe document so xterm scrolls under finger drag. attach on iframe `load` (same-origin via proxy). deltaY = -(currentY - lastY). ⊥ stuck terminal scroll on mobile/tablet.
- V41: ∀ WS `change` event → reload tabs where `info.path === path` ∨ tab doc is embedder (ext ∈ {`md`, `markdown`, `html`, `htm`}). HTML/MD transitively embed `<img>`/`<script>`/`<link>`; child-asset change ⇒ parent tab must cache-bust. ⊥ stale embedded asset until tab close+reopen. scroll preserved per V11.
- V42: any `lib/*.js` function inlined into client via `.toString()` ! reference module-scope consts (closure dies on inline → `ReferenceError` at runtime). literals must live inside the function body. test must round-trip via `new Function(src)()` to prove self-containment.

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
| T29 | x | landing.html: reorder dialog — GitHub above Template. Template fieldset disabled when `gh-mode === 'clone'` (radios + visual fade) | I.routes |
| T30 | x | `handleCreateProject`: force `template = 'none'` when `gh.mode === 'clone'`. ⊥ scaffolder run on cloned repo | V21,V29 |
| T31 | x | `bootstrapClone`: keep "skip if exists" guards on AGENTS.md/README.md; add test asserting pre-existing files survive | V29 |
| T32 | x | bootstrap-prompt branching: write `.claude-bootstrap.txt` per project (scan-existing for clone, greenfield for skip/create); `ttyd-attach.sh` reads + sends + deletes | V30,V31 |
| T33 | x | `GET /api/gh/repos` route w/ in-process 10 min TTL cache. 503 on `gh` error | I.routes,V32 |
| T34 | x | landing.html: clone-source becomes async `<select>`; fallback to `<input>` on fetch fail / empty | V33 |
| T35 | x | tests: cache hit/miss + JSON shape (mock `gh` via stubbed `execFileP`) | V32 |
| T36 | x | README + AGENTS note: forking workflow for non-owned repos | V34 |
| T37 | x | `/api/gh/repos`: filter out candidates whose basename matches any folder under `PROJECTS_ROOT` | I.routes,V32 |
| T38 | x | landing.html: reorder GitHub radios (Clone default, Onboard added). Template fieldset `display:none` when mode ∈ {clone, onboard} | V33,V35 |
| T39 | x | tests: gh-repos filter excludes folder-name matches | V32 |
| T40 | x | server: `bootstrapOnboard(dir, name)` + `GET /api/projects/orphans` + dispatch in `handleCreateProject` for `github.mode === 'onboard'` | I.routes,V36 |
| T41 | x | landing.html: Onboard option populates select from `/api/projects/orphans`; disabled w/ hint when empty | V37 |
| T42 | x | tests: orphan listing + onboard happy path + 409 / 404 errors | V36,V37 |
| T43 | x | gh-repos sort: non-forks first then forks, updatedAt desc within group | V32 |
| T44 | x | rip lazy in-process ttyd. project create runs `sudo -n systemctl enable --now ttyd@<name>.service`; delete unconditionally disables it. /term/<key>/ proxies `unix:/run/ttyd/<key>.sock` directly. develop+wsl admin units enabled at install time | V13,V36,I.routes |
| T45 | x | move test-only helpers out of `server.js` exports: `effectiveTemplate`, `writeBootstrapPrompt`, `filterReposByFolders`, `bootstrapOnboard`, `listOrphanFolderNames` → dedicated `lib/*.js` modules. tests import from `lib/`. server.js exports stay at `{server, PROJECT_ID_RE, RESERVED_PROJECT_NAMES, projectWatchers}` | I.exports |
| T46 | x | landing.html onboard hint = exact spec string `"no orphan folders under ~/projects"` | V37 |
| T47 | x | spec dedup: drop §C lines duplicating V2/V3/V6/V7/V21/V22; refresh ttyd socket constraint to /run/ttyd/ 0755; rewrite `POST /api/projects` + `DELETE` narrative for T44 reality; refresh §I.files lib enumeration; trim V24 cleanup-dup, V33 hidden-fieldset-dup, V36 ttyd-enable-dup; merge V30 into V31 | - |
| T48 | x | responsive develop-pane orientation: side-by-side when `vw > 1.2 * vh`, stacked otherwise. listen `resize`, swap flex-direction + splitter axis. separate persisted size keys per orientation | V38 |
| T49 | x | touch→wheel translator on develop iframe: on `load`, listen `touchstart/touchmove` on `contentWindow.document`, dispatch `WheelEvent('wheel', {deltaY, deltaMode:0})` per move delta. preventDefault on touchmove to suppress page scroll inside iframe | V40 |
| T50 | x | extract reload-target selector → `lib/tab-reload-targets.js` (`isEmbedder` + `tabsToReload`). server `handleChange` uses it; inlined into client via `.toString()`. tests cover direct match + embedder transitive reload | V41 |
| T51 | x | inline `EMBED_EXT` const into `isEmbedder` body so `.toString()` round-trip stays self-contained; add Function-reconstruction test | V42 |

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
| B8 | 2026-05-08 | ttyd-attach.sh fell back to bare `claude`; absent from systemd PATH → tmux new-session command fails → session dies → exit-loop on every browser connect | V39 |
| B9 | 2026-05-09 | browse tab not auto-reload when image/js referenced by an open `.md`/`.html` tab changes; `handleChange` filtered by exact path match only → user had to close+reopen tab | V41 |
| B10 | 2026-05-09 | V41 fix shipped broken: `isEmbedder` referenced module-scope `const EMBED_EXT` that didn't survive `.toString()` inline → `ReferenceError` aborted `handleChange` for every embedder-mismatch tab → no reload at all on the-first-step/sparks.md edit | V42 |
