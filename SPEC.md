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
- `POST /api/projects` body `{name, github?: {mode: skip|clone|create|onboard, source?, visibility?}, template?: 'none'|'vite'|'game-2d'|'game-3d'|'game-3d-complex'|'jekyll', firebase?: bool}` → `{name, termUrl, browseUrl}`. `template` defaults `'vite'`, unknown coerced `'vite'`, forced `'none'` when `github.mode ∈ {clone, onboard}` (V43). `firebase` defaults false, forced false when `template==='none'` ∨ clone ∨ onboard ∨ `jekyll` (non-npm) (V45/V52). every mode ends w/ `sudo systemctl enable --now ttyd@<name>.service` (V13). onboard adopts an existing folder under `PROJECTS_ROOT` named `name`; ⊥ clone, ⊥ scaffold on onboard.
- landing dialog field order: Project name → GitHub → Template. GitHub radio order: Clone (default) → Onboard existing folder → Skip → Create. Template radios: None | Vite (React+TS) | 2D Game (Phaser) | Simple 3D (R3F+Three) | Complex 3D (Babylon). `Firebase backend` checkbox below radios, enabled iff template ≠ None. Template fieldset hidden (display:none) when GitHub mode ∈ {clone, onboard}; visible for skip/create.
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
- `GET /api/term-sessions/<proj>` → `{sessions: [{id, uuid}], lastActive: id|null}`. lists current develop-pane tabs in id order (numeric, not lexical).
- `POST /api/term-sessions/<proj>` → `{id, uuid}`. allocates next free `sN`, stamps fresh uuid into `<proj>/.develop-sessions.json`, `sudo systemctl enable --now ttyd@<proj>__<id>.service`, waits ≤ 5s for the socket. on enable failure → 500 + rolls back the map entry.
- `DELETE /api/term-sessions/<proj>/<id>` → `sudo systemctl disable --now ttyd@<proj>__<id>.service`, `tmux kill-session -t <proj>__<id>`, drops `sessions[<id>]` and clears `lastActive` if it matched.
- `PUT /api/term-sessions/<proj>/active` body `{id}` → writes `lastActive`. 404 if id not in map. ⊥ broadcast — other live devices stay on whatever tab they're on (V49).

files:
- `services/claude-hub.service` — proxy unit
- `services/ttyd@.service` — templated per-project term
- `services/ttyd-develop.service`, `services/ttyd-wsl.service` — admin terms
- `services/ttyd-attach.sh` — joins/creates tmux session, runs `claude --continue` (gated by V4).
- `services/vite@.service` — templated per-project Vite dev server. `ExecStart=npm run dev`, `WorkingDirectory=~/projects/%i`. enabled on Vite-template bootstrap.
- `services/jekyll@.service` — templated per-project Jekyll preview. `ExecStart=~/projects/%i/serve-local.sh`, `Restart=always`, system PATH (no nvm). enabled on `jekyll`-template bootstrap (V52).
- `templates/vite/` — scaffold source (`package.json`, `vite.config.ts`, `index.html`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `.gitignore`). copied into project on create. `<NAME>` & `<PORT>` placeholders replaced.
- `templates/game-2d/` — Phaser scaffold. vite + TS + `phaser`. `src/main.ts` boots `Phaser.Game` w/ demo Scene (arcade physics, keyboard input, sprite). no React. `<NAME>`/`<PORT>`.
- `templates/game-3d/` — "Simple 3D". vite + React + TS + `three` `@react-three/fiber` `@react-three/drei` `@react-three/rapier` `zustand`. demo: lit scene, `KeyboardControls`, one rapier body, zustand store, drei `Html` HUD. `<NAME>`/`<PORT>`.
- `templates/game-3d-complex/` — "Complex 3D". vite + TS + `@babylonjs/core` `@babylonjs/loaders` `@babylonjs/inspector` + Havok. `src/main.ts`: engine+scene in canvas, Havok physics, inspector toggle on key. `<NAME>`/`<PORT>`.
- `templates/_firebase/` — overlay (⊥ standalone template). `src/firebase.ts` (env-gated Auth+Firestore init), `.env.example` (`VITE_FIREBASE_*`), `firebase.json`, `.firebaserc.template`, README cloud section. copied over base tree when `firebase:true` (V45).
- `templates/jekyll/` — Jekyll/Bundler scaffold (Ruby, NOT vite). `_config.yml` (minima theme), `Gemfile.local` (jekyll+minima+webrick+feed+seo-tag; named `.local` so GH Pages ignores it), `serve-local.sh` (`bundle exec jekyll serve --baseurl /<NAME> --port <PORT>`), `.bundle/config` (`vendor/bundle`), `.gitignore`, `README.md.template` (`permalink: /` → site index), `AGENTS.md.template`. `<NAME>`/`<PORT>` placeholders. scaffolded by `bootstrapJekyll`, not `bootstrapTemplate` (V52).
- `lib/tab-key.js` — `tabKey(p, mode)`. server inlines via `.toString()` into client template.
- `lib/port-alloc.js` — `allocatePort(projectsRoot)` scans sibling `.project-meta.json` for free port ≥ 5173.
- `lib/template.js` — `replaceVars` + `copyTemplate` for scaffold copy w/ `<KEY>` substitution.
- `lib/project-name.js` — `PROJECT_ID_RE`, `RESERVED_PROJECT_NAMES` primitives. server.js re-exports.
- `lib/bootstrap-prompt.js` — `writeBootstrapPrompt(dir, name, flavor, opts={templateId, firebase})` + `STACK` map (template id → human stack blurb for greenfield prompt).
- `lib/template-policy.js` — `effectiveTemplate(body)` → enum (V43, allowlist + coerce + clone/onboard force) + `firebaseEnabled(body, template)` (V45).
- `lib/gh-repos.js` — `makeGhRepos({exec, ttlMs, now})` cache + `filterReposByFolders(repos, folders)`.
- `lib/onboard.js` — `bootstrapOnboard(dir, name)` + `listOrphanFolderNames(projectsRoot)`.
- `lib/tab-reload-targets.js` — `isEmbedder(path)` + `tabsToReload(tabs, changedPath)`. inlined into client via `.toString()`.
- `lib/term-sessions.js` — `readSessionsMap`, `writeSessionsMap`, `allocateTabId`, `parseTermKey`, `joinTermKey`, `TAB_ID_RE`, `TERM_KEY_SEP`. develop-pane tab map io + key parse.
- `<project>/.develop-sessions.json` — `{sessions: {sN: uuid}, lastActive: sN|null}`. sole source of truth for develop-pane tabs; read by `ttyd-attach.sh` to launch `claude --session-id <uuid>` (first start) / `claude --resume <uuid>` (restart).
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
- V4: `ttyd-attach.sh` per-tab path (`<project>__<tabId>`) launches `claude --session-id <uuid>` first time / `--resume <uuid>` thereafter (uuid from `.develop-sessions.json` — see V48). legacy bare-key path keeps the original `--continue` gate (only passes `--continue` when `~/.claude/projects/<encoded>/*.jsonl` exists). either path ⊥ exit-loop.
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
- V16: HTML eye-icon tab. project w/ `.project-meta.json`.`proxyTarget` → iframe = `<proxyPrefix>/<relpath>` (index.html at any depth → trailing slash, let upstream serve its own root). project w/o `proxyTarget` → `?raw=1`; RAW_MIME[.html] = `text/html; charset=utf-8`. ⊥ raw bytes of build-tool entry-point index.html (Vite source template refs absolute `/src/main.tsx`, browser can't transpile, assets 404 against wrong origin → white screen). ⊥ octet-stream fallback for `.html`.
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
  - **greenfield** (skip / create + scaffold): Claude reads AGENTS.md+README.md, greets naming the scaffolded stack so it's oriented, asks "what should we build here?". prompt names the template stack (`writeBootstrapPrompt` opts `{templateId, firebase}` → §I `STACK` map); ⊥ blank greet w/ no idea it's a Phaser/R3F/Babylon project. template `none` / no opts → no stack line.
- V32: `/api/gh/repos` runs `gh repo list --json nameWithOwner,description,isFork,isPrivate,updatedAt --limit 200`. result cached in-process w/ ≤ 10 min TTL. ⊥ shell-out per dialog open. response excludes any candidate whose basename matches an existing folder under `PROJECTS_ROOT` (managed or not). sort: `isFork=false` first then `isFork=true`; `updatedAt` desc within each group. ⊥ user's own forks dominate top of dropdown.
- V33: dialog clone-source is a `<select>` populated async from `/api/gh/repos`. on fetch failure / empty / timeout → fall back to free-text `<input>`. ⊥ block dialog while waiting.
- V34: cloning another user's repo = fork on github.com first, pick the fork from the dropdown. arbitrary-URL clone still possible via direct `POST /api/projects` w/ `source: 'owner/repo'` (power-user flow), but not via the dialog.
- V35: Clone is the default GitHub mode in the create dialog. Default dialog open state → Template fieldset hidden.
- V36: `github.mode === 'onboard'` adopts an existing folder under `PROJECTS_ROOT`. Stamps sentinel `.project-meta.json` w/ `name + createdAt` only (no `github`, no `template`). Writes scan-existing bootstrap prompt. 409 if `.project-meta.json` already exists. 404 if folder missing. ⊥ overwrite of any existing file in the tree. ttyd@ enable per V13.
- V37: dialog onboard mode populates `<select>` from `/api/projects/orphans`. Empty list → mode option disabled w/ hint "no orphan folders under ~/projects".
- V38: develop pane sits at `<main>` level — sibling of the (tree-pane | work-area) row — so it spans the full `<main>` width when shown. ⊥ nested inside `work-area` (would clip terminal to area below the file-tabs row). `<main>` is column flex; persisted as `view-shell:develop-height:<proj>`.
- V39: `ttyd-attach.sh` `CLAUDE_BIN` default ! match §C claude-binary default (`$HOME/.local/bin/claude`). bare `claude` ⊥ resolve in systemd PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin`) → tmux command fails → session dies → V4 exit-loop trip.
- V40: develop-pane terminal iframe ! translate touch-drag → synthetic `wheel` events on iframe document so xterm scrolls under finger drag. attach on iframe `load` (same-origin via proxy). deltaY = -(currentY - lastY). ⊥ stuck terminal scroll on mobile/tablet.
- V41: ∀ WS `change` event → reload tabs where `info.path === path` ∨ tab doc is embedder (ext ∈ {`md`, `markdown`, `html`, `htm`}). HTML/MD transitively embed `<img>`/`<script>`/`<link>`; child-asset change ⇒ parent tab must cache-bust. ⊥ stale embedded asset until tab close+reopen. scroll preserved per V11.
- V42: any `lib/*.js` function inlined into client via `.toString()` ! reference module-scope consts (closure dies on inline → `ReferenceError` at runtime). literals must live inside the function body. test must round-trip via `new Function(src)()` to prove self-containment.
- V43: `template` ∈ enum `{none, vite, game-2d, game-3d, game-3d-complex, jekyll}`. id == `templates/<id>/` dirname (1:1). unknown → coerce `vite`. clone/onboard force `none` (extends V21). every non-`none` template EXCEPT `jekyll` = vite project (`npm run dev`) → reuses `vite@<name>.service` (V25), port alloc (V22), proxy meta (V23). `jekyll` is the one non-vite family — own scaffolder + unit (V52). browse/eye-icon (V16/V53) works unchanged via `proxyTarget`.
- V44: `bootstrapTemplate(dir, name, templateId, {firebase})` generalizes bootstrapVite — copy `templates/<templateId>` → stamp `.project-meta.json` w/ V23 fields but `template: <templateId>` → optional firebase overlay (V45) → `npm install` → enable `vite@<name>`. cleanup-on-fail per V13. `vite` = the identity case.
- V45: `firebase:bool` POST field. forced false when `template==='none'` ∨ clone ∨ onboard (no scaffold to inject). when true → `copyTemplate(templates/_firebase)` over project tree THEN `npm install firebase` (npm merges `package.json` — ⊥ JSON-merge via placeholder copy). overlay files per §I. dialog checkbox enabled iff template ≠ None.
- V46: game + vite templates ship two static-deploy build scripts — `build:pages` (`vite build --base=/<NAME>/`, GH Pages) + `build:firebase` (`vite build --base=/`, Firebase Hosting). dev base stays `/<name>/` per V20 (proxy routing). ⊥ single base serving both hosts. GH Pages workflow + `firebase.json` shipped (latter via `_firebase` overlay).
- V47: develop pane = N tabs, each tab = `ttyd@<proj>__sN.service` + tmux session named `<proj>__sN` + claude conversation identified by uuid. id format `sN` (positive integer, no leading zero). `<proj>/.develop-sessions.json` `{sessions:{sN:uuid}, lastActive:sN}` is sole source of truth. `allocateTabId` reuses gaps (smallest unused) so labels stay compact. project create stamps `s1` with a fresh uuid before enabling the unit.
- V48: `ttyd-attach.sh` splits its arg on first `__` → `<project>__<tabId>`. tabId = `sN` → read `.develop-sessions.json`, look up uuid, launch `claude --resume <uuid>` iff `~/.claude/projects/<encoded>/<uuid>.jsonl` exists else `claude --session-id <uuid>`. no separator → legacy bare-key path (kept for admin units `develop`/`wsl` and any unmigrated project). bootstrap-prompt only fires on s1 (or legacy bare) so secondary tabs start clean.
- V49: PUT `/active` writes server-side only; ⊥ broadcast to other live connections. switching tabs on one device must not yank others. new connections read `lastActive` on load → start there. ⊥ localStorage for active id (cross-device coherence).
- V50: server startup migrates legacy `ttyd@<project>.service` units (no `__`) to `ttyd@<project>__s1.service`. extracts existing claude uuid from latest `~/.claude/projects/<encoded>/*.jsonl` (else fresh uuid), writes map, `tmux rename-session <project> → <project>__s1` (preserves live process + convo), disables old unit, enables new. idempotent — skips when `.develop-sessions.json` already exists. admin keys `develop`/`wsl` exempt.
- V51: project DELETE enumerates `ttyd@<project>__*.service` via `systemctl list-units` (all states), disables every child + legacy bare unit in one batch, kills every matching tmux session, then removes the directory. ⊥ orphan ttyd units after a delete.
- V52: `jekyll` template = Ruby/Bundler, not vite. `bootstrapJekyll(dir, name)` (not `bootstrapTemplate`): copy `templates/jekyll` → `chmod +x serve-local.sh` (copyTemplate writes 0644; unit execs it) → stamp meta `template:jekyll, proxyTarget:127.0.0.1:<port>, stripPrefix:false, openUrl:/<name>/, extraUnits:[jekyll@<name>.service]` → port via `allocatePort(root, 4000)` (4000s range, ⊥ collide w/ vite 5173+) → `BUNDLE_GEMFILE=Gemfile.local bundle install` (project-local `vendor/bundle`) → `sudo systemctl enable --now jekyll@<name>.service`. cleanup-on-fail per V13. `scaffoldProject` dispatches jekyll→bootstrapJekyll else→bootstrapTemplate. firebase forced off (no package.json). DELETE drops `jekyll@<name>` via the generic `extraUnits` path.

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
| T52 | x | restructure view shell `<main>` into column flex w/ `.top-row` (tree+work-area) + `develop-splitter` + `develop-pane` siblings. drop V38 side-by-side orientation logic and `lib/orientation.js`. develop-pane spans full `<main>` width. structural HTML test asserts develop-pane sibling-of-top-row | V38 |
| T53 | x | eye-icon render mode routes through proxy when project has `proxyTarget`. `renderViewShell` reads `.project-meta.json`, injects `PROXY_PREFIX` const. `openTab` render branch: if PROXY_PREFIX → iframe = `<prefix>/<relpath>` (index.html → trailing slash); else → `?raw=1`. view mode unchanged | V16 |
| T54 | x | add `templates/game-2d/` (Phaser), `templates/game-3d/` (R3F+Three), `templates/game-3d-complex/` (Babylon). each vite, `<NAME>`/`<PORT>`, demo scene, mirror `templates/vite/` file set + `AGENTS.md.template`/`README.md.template` | I.files,V43 |
| T55 | x | add `templates/_firebase/` overlay tree (`src/firebase.ts`, `.env.example`, `firebase.json`, `.firebaserc.template`, README cloud section) | I.files,V45 |
| T56 | x | generalize `bootstrapVite` → `bootstrapTemplate(dir, name, templateId, {firebase})`; id→dir 1:1; stamp `meta.template=templateId`; firebase overlay + `npm install firebase` when flag set | V43,V44,V45 |
| T57 | x | `lib/template-policy.js`: `effectiveTemplate(body)` enum allowlist + coerce-to-vite + clone/onboard force; add `firebaseEnabled(body, template)` | V43,V45 |
| T58 | x | `handleCreateProject`: dispatch any non-`none` template → `bootstrapTemplate`; pass `firebase` flag; force `none`/false on clone/onboard | I.routes,V43,V45 |
| T59 | x | `landing.html`: template radios → 5 options; `Firebase backend` checkbox enabled iff template ≠ None; payload `{template, firebase}` | I.routes,V43,V45 |
| T60 | x | static-deploy: `build:pages`/`build:firebase` scripts in each template `package.json` + `.github/workflows/pages.yml.template` (game/vite trees); `firebase.json` via `_firebase` overlay | V46 |
| T61 | x | tests: effective-template enum+coerce+firebase-forcing; `copyTemplate` each new tree + overlay; routes payload accept/validate | V43,V44,V45 |
| T62 | x | README + AGENTS: game-template catalog + per-host (GH Pages vs Firebase Hosting) deploy steps | I.files |
| T63 | x | `lib/term-sessions.js` — sessions map io + `allocateTabId` (gap-fill) + `parseTermKey`/`joinTermKey` | I.files,V47 |
| T64 | x | `ttyd-attach.sh` — parse `<project>__<tabId>`, lookup uuid, `claude --session-id` (first) / `--resume` (restart); s1-only bootstrap-prompt | V48 |
| T65 | x | server: `GET/POST/DELETE /api/term-sessions/<proj>` + `PUT /active`; sudo enable/disable ttyd@<proj>__sN.service; rollback map on enable fail | I.routes,V47,V49 |
| T66 | x | server: startup `migrateLegacyTermUnits()` — extract uuid from jsonl mtime sort, rename tmux, swap systemd unit; idempotent; admin units exempt | V50 |
| T67 | x | server: `handleDeleteProject` enumerates `ttyd@<proj>__*` + bare unit, batch disable + tmux kill each | V51 |
| T68 | x | server: project create stamps `.develop-sessions.json` w/ `{s1:uuid, lastActive:'s1'}` + enables `ttyd@<proj>__s1.service` instead of bare; `lookupActiveTermKey(name)` shared helper for card/shell termUrl | V47 |
| T69 | x | renderViewShell: tab strip in develop pane (label + ×) + trailing +; one iframe per session (display:none inactive) — switch is instant + state preserved; close-last auto-spawns; initial focus = lastActive (or first); PUT /active on switch | V47,V49 |
| T70 | x | tests: lib/term-sessions roundtrip + allocateTabId gap-fill + parseTermKey edge cases; routes GET/PUT/405 (POST/DELETE skipped — real sudo) | V47,V49 |
| T71 | x | `templates/jekyll/` (Ruby/minima) + `services/jekyll@.service` + `bootstrapJekyll`/`scaffoldProject` dispatch + template-policy enum/firebase-off + landing radio + STACK blurb + tests + docs | I.files,V43,V52 |

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
| B11 | 2026-05-10 | develop-pane nested inside `work-area` (sibling of viewer-pane) → terminal width clipped to area below the file-tabs row instead of spanning full `<main>`. classic side-by-side orientation logic (V38 v1) baked the nesting in | V38 (revised) |
| B12 | 2026-05-14 | eye-icon on `lifebot/index.html` → white screen. Vite source-template index.html refs absolute `<script src="/src/main.tsx">`; iframe origin = claude-hub root, so request lands at `/src/main.tsx` (not under `/view/...`), 404; browser can't transpile TSX anyway → `<div id="root">` stays empty. raw bytes only work for self-contained static HTML; build-tool entry points need the project's running server | V16 (amended) |
