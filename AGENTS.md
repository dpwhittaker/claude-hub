# claude-hub — AGENTS.md

Path-routed reverse proxy + landing page. Turn one local port into multi-project dashboard. Read from disk, no phone home. Read this before changing code, systemd units, or route conventions.

## Workflow rule: commit + push every turn

Every turn that changes code, config, assets, or docs ends with a commit and a push — don't wait to be asked. One commit per logical change; split unrelated WIP into separate commits before mixing. Run tests/lint first; if they fail, fix before committing. Restart the relevant systemd unit when the live site needs the change to take effect. Skip only when the turn produces no working-tree changes.

## What it is

```
                 ┌──────────────────────────────────┐
http://localhost:8002 ──▶│   claude-hub (this dir)       │
                 │   Node, listens on 127.0.0.1     │
                 └──┬───────┬───────┬───────┬───────┘
                    │       │       │       │
       /  ──────────┘       │       │       │   landing.html (this dir, dynamic cards)
       /api/*  ─────────────┘       │       │   in-process JSON: projects + view-tree
       /view/<proj>/* ─────────────┘       │   two-pane file browser per project
       /term/<proj>/* ─────────────────────┘   ttyd unix sockets at /run/ttyd/<proj>.sock
       /<proj>/*       (optional per-project openUrl, see below)
```

Proxy = only Node process. Everything else (project apps, ttyd terminals) separate systemd unit it forwards to.

## Routes

| URL | What it does |
|---|---|
| `/` | `landing.html`. Hardcoded cards for **Develop** (fresh claude in `~/projects`) and **Proxy** (this dir). Rest rendered dynamically from `/api/projects`. |
| `/api/projects` | `GET` lists managed projects. `POST` creates new one (mkdir + AGENTS/README + `.project-meta.json` + `sudo systemctl enable --now ttyd@<name>`). |
| `/api/projects/<name>` | `DELETE` stops `ttyd@<name>` plus any `extraUnits`, kills project's tmux session, removes folder — via `git worktree remove` when the sentinel names a `worktreeOf` parent. Needs `.project-meta.json` as sentinel. |
| `/api/view-tree/<name>` | `GET` returns project's recursive tree as JSON. With `?path=<sub>` returns one level lazily — file browser uses to expand dim dirs (`node_modules`, gitignored, …) on demand. |
| `/view/<proj>/` | Two-pane viewer: collapsible tree (left, draggable splitter) + tabbed iframes (right). README.md opens in initial tab. |
| `/view/<proj>/<file>` | Renders single file (markdown via `marked`, code via highlight.js, raw bytes via mime). `?embed=1` strips page chrome — used by two-pane viewer's iframes. `?raw=1` to download. |
| `/term/<proj>/` | Forwards to `unix:/run/ttyd/<proj>.sock` if socket exists. Resolved per request — adding project no proxy restart. |
| `/term/develop/`, `/term/shell/` | Static admin terminals (fresh claude in `~/projects`, raw bash). `/term/wsl/` 301s to `/term/shell/` for old bookmarks. |
| `/<proj>/*` (optional) | Reverse-proxy to project's backend if `.project-meta.json` declares `proxyTarget`. Card's "Open" button steered via `openUrl` in same file. No proxy restart — claude-hub rebuilds route table on every project create/delete. |

## Project sentinel: `.project-meta.json`

Folder under `~/projects/` shows on landing page iff contains `.project-meta.json`. Shape:

```json
{
  "name": "<name>",
  "createdAt": "2026-01-01T00:00:00-05:00",
  "openUrl": "/<name>/",
  "proxyTarget": "http://127.0.0.1:5173",
  "proxyPrefix": "/<name>",
  "stripPrefix": false,
  "extraUnits": ["<name>.service"]
}
```

| field | purpose |
|---|---|
| `name` | Folder name; informational. |
| `createdAt` | ISO timestamp; cards sort by this. A worktree sorts under its parent's value instead of its own, so it lands beside the project it branched from. |
| `openUrl` | Optional. Where card's "Open" button goes. Defaults `/view/<name>/README.md`. Set to `/<name>/` (or wherever) when project has live app reachable through proxy. |
| `proxyTarget` | Optional. If set, claude-hub reverse-proxies project's prefix to this URL. Without it, no live route — only `/view/<name>/` and `/term/<name>/`. |
| `proxyPrefix` | Optional. URL prefix to match. Defaults `/<name>`. Useful when folder name and public URL diverge. |
| `stripPrefix` | Optional, default `true`. When `false`, prefix left on request — needed for upstreams that expect it (e.g. Vite with `base: "/<name>/"`). |
| `extraUnits` | Optional list of systemd units to stop when project deleted via UI (plus `ttyd@<name>.service`). Useful when project runs own backend unit. |
| `title` | Optional. Overrides the README H1 as the card title. Set on worktrees, which inherit the parent README verbatim. |
| `description` | Optional. Overrides the README's first paragraph as the card description. Same reason. |
| `worktreeOf` | Optional. Name of the project this folder is a `git worktree` of. Adds a `worktree` badge, a provenance line on the card, and routes DELETE through git. See "Git worktrees" below. |
| `branch` | Optional. Branch the worktree has checked out; shown on the card beside the parent link. Informational. |
| `routes` | Optional ordered `[{match, to}]` rewrite rules mapping a source file → the URL it renders at (relative to the proxy prefix). Browse shows a **preview eye-icon** on any file that matches a rule and renders it via the live backend (`PROXY_PREFIX + route`). Lets `.md` (and anything else) preview through the project's real renderer. See "File→URL routes" below. |

Title, description, tags come from **`README.md`** unless the sentinel overrides them (V55):

- **Title**: first H1.
- **Description**: first paragraph after H1, inline markdown stripped.
- **Tags** (badge pills): `tags: [...]` in YAML frontmatter at top of README.md. Absent → card shows `Project`.

`.project-meta.json`'s `title` / `description` win when present — the escape hatch a worktree needs, since it checks out its parent's README byte-for-byte. Tags always come from the README; a `worktreeOf` sentinel prepends the `worktree` badge to them. Parsing lives in `lib/readme-meta.js`, card assembly + ordering in `lib/project-cards.js`.

## systemd units

Source unit files live in `services/`. Install with `sudo install -m 644
services/<file> /etc/systemd/system/`, then `sudo systemctl daemon-reload &&
sudo systemctl enable --now <unit>`. `services/ttyd-attach.sh` installs to
`/usr/local/bin/ttyd-attach.sh` (referenced by `ttyd@.service` ExecStart).

| Unit | What it runs |
|---|---|
| `services/claude-hub.service` | `node server.js` (this proxy). Adjust `ExecStart` to your node binary path. |
| `services/ttyd@.service` | Templated. `systemctl enable --now ttyd@<name>` brings up `unix:/run/ttyd/<name>.sock` running `ttyd-attach.sh <name>` — joins or creates tmux session named `<name>` running `claude --continue` (omitted on first launch when no prior session exists, avoid exit-loop). |
| `services/ttyd-develop.service` | Admin: fresh `claude` in `~/projects` per browser connection. No tmux. |
| `services/ttyd-shell.service` | Admin: raw `bash -l`. No claude, no tmux. |
| `services/vite@.service` | Templated. `systemctl enable --now vite@<name>` runs `npm run dev` in `~/projects/<name>` under `Restart=always`. Enabled during any vite-family template scaffold (`vite` / `game-2d` / `game-3d` / `game-3d-complex` all share this one unit). |
| `services/jekyll@.service` | Templated. `systemctl enable --now jekyll@<name>` runs `~/projects/<name>/serve-local.sh` (`bundle exec jekyll serve`) under `Restart=always`, system PATH (Ruby/bundler, no nvm). Enabled only for the `jekyll` template — the one non-vite family. |

`/run/ttyd/` shared across every ttyd instance. All three units carry `RuntimeDirectoryPreserve=yes` for that reason — without it, one instance stop = systemd wipes whole dir, orphans every other socket. Don't remove that line.

## File-tree dimming

Two-pane viewer's left tree marks "noisy" entries dim (lower opacity, muted name color):

- Default: anything `git ls-files --others --ignored --exclude-standard
  --directory` reports. Project's `.gitignore` = source of truth.
- Fallback (no git or empty ignore output): hardcoded list — `node_modules`, `.git`, `.serve`, `dist`, `build`, `.next`, `.cache`.
- `.git` always dim, regardless.

Dim dirs not recursed eagerly — lazy-load on first expand via `/api/view-tree/<proj>?path=<sub>`. Anything inside dim dir inherits dim. Keeps `node_modules` from blowing 5000-node tree cap.

## File→URL routes (preview eye-icon)

The Browse tree shows a **preview eye-icon** on:

1. `.html` / `.svg` — rendered in an iframe (html via proxy when available, else `?raw=1`; svg always `?raw=1` as `image/svg+xml`). V16.
2. Any file matching a `routes` rule in `.project-meta.json` — rendered via the live backend at `PROXY_PREFIX + route` (needs a `proxyTarget`). V54.

`routes` is an **ordered list of rewrite rules**, first match wins:

```json
"routes": [
  { "match": "README.md",    "to": "/" },
  { "match": "**/index.md",  "to": "/:dir/" },
  { "match": "**/*.md",      "to": "/:dir/:name.html" }
]
```

- **glob** (`match`): `*` = exactly one path segment, `**` = zero or more segments (captured as `:splat`), everything else literal.
- **template** (`to`): a root-relative URL (may include a `#fragment`). Vars: `:dir` (dirname, `''` at root), `:name` (basename minus final ext), `:ext`, `:path` (full rel path), `:pathnoext`, `:splat`. Output is slash-normalized (`//`→`/`, `#/`→`#`).
- Files with any path segment starting `_` or `.` are never routed (Jekyll/most static hosts don't serve them).
- The resolver is `lib/file-routes.js` (`matchGlob` + `routeForPath`), inlined into the Browse client via `.toString()` (so it must stay self-contained — no closures), and validated server-side by `readProjectRoutes` (`to` must be `^/[^\s"'<>\\]*$`).

The two live examples, discovered to differ fundamentally:

- **genesis** — a real Jekyll site (default page permalinks): the rules above map `sessions/x/index.md → /sessions/x/` and `texts/a.md → /texts/a.html`. The eye-icon opens the Jekyll-rendered HTML through `genesis-preview.service`.
- **systematic-theology** — a `.nojekyll` SPA (`index.html` + `js/app.js` hash router, Markdown fetched client-side). Its `.md` files don't map to server HTML — they map to `#fragment` routes:
  ```json
  "routes": [
    { "match": "handouts/**/*.md",    "to": "/#:path" },
    { "match": "storyboards/**/*.md", "to": "/#:path" },
    { "match": "data/**/*.md",        "to": "/#:splat/:name" }
  ]
  ```
  so `data/god/trinity.md → /theology/#god/trinity`, `data/TOC.md → /theology/#TOC`, `handouts/x.md → /theology/#handouts/x.md`. The eye-icon loads the SPA, whose router renders the Markdown.

New jekyll-template projects are stamped with the genesis-style default rules automatically (`bootstrapJekyll`).

## Git worktrees

Claude Code's `isolation: "worktree"` drops a `git worktree add` checkout next
to its parent — `~/projects/<parent>_<task>/`. Give it a `.project-meta.json`
and it becomes a first-class card with its own Vite port, terminal and Browse
pane, so an agent can render and test its own branch instead of competing for
the parent's dev server. The three live ones look like:

```json
{
  "name": "world-builder-opus-5_avatar-lighting",
  "worktreeOf": "world-builder-opus-5",
  "branch": "avatar-lighting",
  "title": "World Forge — avatar-lighting",
  "description": "Worktree of world-builder-opus-5 on branch 'avatar-lighting'.",
  "proxyTarget": "http://127.0.0.1:5179",
  "extraUnits": ["vite@world-builder-opus-5_avatar-lighting.service"]
}
```

Three things follow from `worktreeOf`, all of them because a worktree is *not*
an independent project:

- **The card can't trust the README.** The checkout carries the parent's
  README verbatim, so title + description come from the sentinel (V55).
- **It sorts with its parent, not by age.** A worktree created months after
  its parent still renders directly beneath it, ahead of newer projects. The
  `<parent>_<task>` naming alone can't do this — a plain `createdAt` sort
  scatters them (V55).
- **DELETE goes through git.** The checkout is registered in the *parent's*
  `.git/worktrees/`, so DELETE runs `git -C <parentDir> worktree remove
  --force <dir>` and only falls back to `rm` + `git worktree prune` if that
  fails. A bare `rm -rf` leaves the parent listing a checkout that is gone
  and refusing to reuse the path (V56, B16).

`worktreeOf` is read from on-disk JSON and turned into a path, so it gets the
same `PROJECT_ID_RE` validation as a project name. An invalid one degrades to
"plain project" rather than reaching outside `PROJECTS_ROOT`.

To check the parent's registry by hand:

```bash
git -C ~/projects/<parent> worktree list
git -C ~/projects/<parent> worktree prune   # drop stale entries
```

## Where the code lives

`server.js` is routing, request handling and disk access — everything that
touches `http`, `fs` or `sudo`. Anything pure gets extracted to `lib/` so it
can be unit-tested without booting a server; tests that DO need a server use
`test/helpers/fixture.js`, which boots `server.js` in-process on a random port
against a scratch `PROJECTS_ROOT`.

| module | what |
|---|---|
| `lib/view-shell.js` | The Browse two-pane document (`/view/<proj>/`) — tree, tabs, develop pane, client script. |
| `lib/pwa-shell.js` | The per-project PWA shell (`/p/<proj>/`) — installable, home link in the term tabstrip, FAB cycling TERM→OPEN→VIEW (swaps the right half while split), long-press menu (refresh + sticky split preference, the only way in/out of split). |
| `lib/project-cards.js` | Landing-card assembly: sentinel-over-README precedence + worktree ordering (V55). |
| `lib/readme-meta.js` | README text → `{title, description, tags}`. |
| `lib/worktree.js` | Git-worktree teardown plan (V56). |
| `lib/file-routes.js` | `routes` glob → URL rewriting (V54). |
| `lib/term-sessions.js` | Develop-pane tab map io (V47). |
| `lib/android-input.js` | Android soft-keyboard input shim for ttyd pages (V61, B17). |
| `lib/keyboard-fit.js` | Mobile viewport fit for ttyd pages; `patchViewportMeta` + `installKeyboardFit` (V62). |
| `lib/term-reconnect.js` | Automatic reconnect + post-reopen refit for ttyd pages (V63, V64, B19). |
| `lib/escape-html.js` | The one server-side HTML escaper. |

Ten helpers are shared between server and browser by injecting their source
with `.toString()` (`tabKey`, `installTouchWheel`, `isEmbedder`,
`tabsToReload`, `matchGlob`, `routeForPath`, `installOsc52Bridge`,
`installKeyboardFit`, `installAndroidInput`, `installTermReconnect`). **Those must stay
self-contained** — no closures over module scope, no `require` inside them —
because the browser only receives the function body.

## Mobile terminal input (Android)

Every `/term/<key>/` HTML response gets four scripts spliced into `<head>` on
the way through the proxy (`proxyRes`, `server.js`): `installOsc52Bridge`,
the scrollbar-hide style, `installTouchWheel` (V40) and — added for B17 —
`installKeyboardFit` (V62) plus `installAndroidInput` (V61).

**Why the Android one exists.** ttyd 1.7.7 bundles xterm.js 5.x, and Gboard
reports every character as a `keydown` with keyCode 229. xterm routes that
into `CompositionHelper._handleAnyTextareaChanges`, which snapshots
`textarea.value` and diffs it inside a `setTimeout(0)` guarded by
`!_isComposing`. That loses keystrokes two ways, both worse the faster you
type: the macrotask competes with the renderer (tmux repainting a
full-screen TUI per echoed byte starves it), and a composition opening
between the keydown and the timer discards the diff outright. There is no
local echo, so a dropped character never appears — it reads as the terminal
lagging the server.

`lib/android-input.js` takes the path over. It works because of an
**event-phase asymmetry**: xterm binds `compositionstart|update|end` on the
textarea in the *bubble* phase, and `keydown|keypress|input` in the capture
phase *on the textarea itself* — so a capture listener on `document` runs
before all of them and `stopImmediatePropagation` suppresses xterm's handling
without touching a private field. It then diffs the textarea against a mirror
**synchronously, in the handler that observed the change**.

Things that look like details but are load-bearing:

- **Gated on `/Android/i`.** Desktop and iOS keep xterm's stock path; the
  shim returns before binding anything.
- **Exactly one sender per key**, decided at keydown by `xtermOwns`. Text
  keys are the shim's — the IME sentinel *and* every printable key, space
  included — and are suppressed at **both** `keydown` and `keypress`.
  `stopImmediatePropagation` stops propagation but **not the browser's
  default action**, so Chrome still fires `keypress` and `input`, and xterm's
  own listeners are live on the textarea: suppressing only `keydown` lets
  xterm send the character on top of the diff (B18). Control keys — Enter,
  Tab, arrows, Escape, Backspace, Home/End, function keys, anything with a
  modifier — stay xterm's, and the textarea change they cause is *adopted*
  into the mirror rather than re-sent.
- **DEL per codepoint, not per UTF-16 unit** — a line editor erases an emoji
  with one backspace, and the prefix scan refuses to land between surrogates.
- **The textarea is never emptied.** Gboard only emits
  `deleteContentBackward` when there is something to delete, so an empty box
  silently eats backspaces. It is trimmed to a 64-char tail past 512 instead —
  and only at a whitespace boundary, because rewriting the box mid-word moves
  text under Gboard's composing region (tracked by offset) and desyncs the
  keyboard from the DOM (B18). A 2048 hard cap is the escape hatch.
- **`focusin` seeds the mirror**, so an `input` with no preceding keydown
  (voice, suggestion-strip tap) is diffed rather than swallowed as first
  sight of the element.
- Only public xterm API is used: `term.textarea`, `term.input(data, true)`,
  `term.scrollToBottom()`.

> **Verifying a change here: hook `term.onData`, not `term.input`.** xterm's
> own path calls `coreService.triggerDataEvent()` directly and never goes
> through the public `term.input()`, so wrapping `input` shows you only the
> shim's output and will happily report "no duplicates" while xterm is
> double-sending beside you. `onData` is the only hook that sees both. That
> mistake is what let B18 ship.

`installKeyboardFit` is the other half. It used to forward *every*
visualViewport `resize` as a synthetic `window` `resize`; ttyd binds that
straight to `fitAddon.fit()` with **no debounce**, and a fit that lands on new
rows/cols sends `RESIZE_TERMINAL` → SIGWINCH → full TUI repaint. Gboard fires
vv `resize` for no-op suggestion-strip toggles as you type, so that was a
whole redraw per keystroke competing with input. It now drops resizes that
changed neither dimension and coalesces the dispatch to one per animation
frame (V62).

## Terminal reconnect (V63, V64, B19)

`installTermReconnect` is the fifth injected shim, and the second that wraps
`window.WebSocket` — it goes in AFTER `installOsc52Bridge` so the nesting is
`ReconnectWrapped(Osc52Wrapped(native))` and every socket still flows through
osc52's message scanner. Head-parse timing, no DOMContentLoaded gate, for the
same reason osc52 has none: ttyd constructs its socket from
`componentDidMount`, and a gated wrapper would arrive too late.

**What it undoes.** ttyd 1.7.7's `connect()` registers
`addEventListener(socket, 'error', () => this.doReconnect = false)`, and
`onSocketClose` reads `doReconnect` to choose between reconnecting and parking
on `Press ⏎ to Reconnect`. Every real network loss — a phone sleeping, a
wifi↔cellular handoff — fires `error` before `close`, so the automatic branch
was effectively dead code. The shim simply never registers that listener.

**Where the backoff comes from.** ttyd reconnects the instant its close
handler runs, so the shim holds that handler and calls it later; the delay
before delivery IS the retry delay. Nothing of ttyd's is patched, and holding
the close defers `dispose()` too, which keeps the refit binding alive for the
whole wait.

**Why the refit is separate.** `dispose()` drops `initListeners()`'s
`window 'resize' → fitAddon.fit()` binding, so xterm keeps its pre-drop
cols/rows while the socket is down and `onSocketOpen` re-handshakes with them.
The shim calls `window.term.fit` — set in ttyd's `open()` and never torn down —
rather than dispatching a synthetic resize, because V62's dedupe drops a
forwarded resize when neither viewport dimension changed, which is exactly the
case that still needs a refit.

> Reading the bundle beats guessing: it is one ~735KB inlined file at
> `/term/<key>/`, and `grep -o '.\{160\}<symbol>.\{240\}'` over it recovers
> the minified source of any handler you need. That is how the `error` listener
> and the `window.term.fit` hook above were both confirmed rather than assumed.

## Common ops

```bash
# status / logs
systemctl is-active claude-hub.service
journalctl -u claude-hub.service -f

# restart after editing server.js (node holds it in memory).
# landing.html is read from disk per request — no restart needed.
sudo systemctl restart claude-hub.service

# probe routes locally
curl -sI http://127.0.0.1:8002/
curl -s   http://127.0.0.1:8002/api/projects | jq .
curl -s   http://127.0.0.1:8002/api/view-tree/<project> | jq .
```

## Project creation

Default template = **Vite (React + TypeScript)**. `POST /api/projects` body
field `template: 'none' | 'vite' | 'game-2d' | 'game-3d' | 'game-3d-complex' | 'jekyll'`
(default `'vite'`; unknown coerced to `'vite'`; forced to `'none'` when
`github.mode ∈ {clone, onboard}`). Optional `firebase: bool` opt-in (forced
false on `none`/clone/onboard/`jekyll`). Clone source on the dialog comes from
`GET /api/gh/repos` (cached 10 min) — only the user's own repos are listed.
Cloning someone else's repo = fork on github.com first; the fork appears in
the dropdown. `POST /api/projects` still accepts an arbitrary `source` slug
or URL for power-user direct calls.

**Template catalog** — every vite-family template shares one
`vite@<name>.service` (no per-template unit). `jekyll` is the one exception: a
Ruby/Bundler project with its own `jekyll@<name>.service`.

| `template` | Stack | Entry | Unit |
|---|---|---|---|
| `vite` | React + TypeScript | `src/main.tsx` | `vite@` |
| `game-2d` | Phaser 3 (2D engine) | `src/main.ts` | `vite@` |
| `game-3d` | react-three-fiber + Three + rapier + zustand ("Simple 3D") | `src/App.tsx` | `vite@` |
| `game-3d-complex` | Babylon.js + Havok + inspector ("Complex 3D") | `src/main.ts` | `vite@` |
| `jekyll` | Jekyll + minima (Ruby, Markdown site) | `README.md` (`permalink: /`) | `jekyll@` |

`scaffoldProject(dir, name, template, {firebase})` dispatches: `jekyll` →
`bootstrapJekyll`, everything else → `bootstrapTemplate`.

Vite-family scaffold (`bootstrapTemplate`):

1. `templates/<template>/` copied with `<NAME>` + `<PORT>` placeholders replaced (`template` id == dir name, 1:1).
2. Free port ≥ 5173 allocated by scanning sibling projects' `.project-meta.json` `proxyTarget`.
3. If `firebase` → `templates/_firebase/` overlaid (adds `src/firebase.ts`, `.env.example`, `firebase.json`, `.firebaserc`).
4. `.project-meta.json` stamped: `template: '<template>'`, `proxyTarget`, `proxyPrefix: /<name>`, `stripPrefix: false`, `openUrl: /<name>/`, `extraUnits: ['vite@<name>.service']`.
5. `npm install` (+ `npm install firebase` when overlaid), 5 min timeout, in scaffolded dir.
6. `sudo systemctl enable --now vite@<name>.service`.

Jekyll scaffold (`bootstrapJekyll`, V52):

1. `templates/jekyll/` copied with `<NAME>`/`<PORT>` replaced; `serve-local.sh` `chmod +x` (copyTemplate writes 0644).
2. Free port allocated from the **4000s** (`allocatePort(root, 4000)`) so jekyll ports never collide with the vite 5173+ range.
3. `.project-meta.json` stamped like above but `extraUnits: ['jekyll@<name>.service']`.
4. `BUNDLE_GEMFILE=Gemfile.local bundle install` into a project-local `vendor/bundle` (`.bundle/config`), 5 min timeout. No firebase (not an npm project).
5. `sudo systemctl enable --now jekyll@<name>.service`.

`template: 'none'` skips all of this — bare `AGENTS.md` + `README.md` + sentinel only.

**Static deploy** — games are meant to ship to static hosting, not run from
the hub long-term. Each template ships `build:pages` (`vite build
--base=/<NAME>/`, GitHub Pages — base = repo name) and `build:firebase`
(`--base=/`, Firebase Hosting), plus `.github/workflows/pages.yml`. The dev
base stays `/<NAME>/` for the proxy (V20). The `firebase` overlay adds
`firebase.json` (Hosting → `dist`) for `firebase deploy`.

### Manual (without the + card)

1. `mkdir ~/projects/<name>` and add `AGENTS.md` + `README.md`.
2. Drop `.project-meta.json` (schema above).
3. `sudo systemctl enable --now ttyd@<name>.service` — only systemd touch needed for terminal access. `/term/<name>/` route resolves dynamically as soon as `/run/ttyd/<name>.sock` appears.
4. (Optional) If project has live web app, set `proxyTarget` (and `stripPrefix` / `proxyPrefix` as needed) in `.project-meta.json`, point `openUrl` at prefix. claude-hub picks up on next request — no restart.

## Gotchas

- **Stale node process** — `server.js` lives in V8 memory; edits don't apply until `systemctl restart claude-hub.service`. `landing.html` is read per request, no restart needed. Same for anything under `lib/` — it's `require`d into the same process.
- **Game template = vite project** — `game-2d`/`game-3d`/`game-3d-complex` ride the one `vite@<name>.service`, not a per-template unit. New template? Make it a vite project (reuse `vite@`) — or, like `jekyll`, give it its own scaffolder + `<kind>@<name>.service` and dispatch it in `scaffoldProject`.
- **Jekyll template is the non-vite exception** — `jekyll` is Ruby/Bundler, scaffolded by `bootstrapJekyll` (not `bootstrapTemplate`), runs under `jekyll@<name>.service`, ports allocated from the 4000s (not 5173+), no firebase. `serve-local.sh` carries the baked `--baseurl /<name>` + port; the unit just execs it. README.md (`permalink: /`) is the site index.
- **Greenfield bootstrap prompt is stack-aware** — `writeBootstrapPrompt(dir, name, 'greenfield', {templateId, firebase})` injects a `STACK[templateId]` blurb so a fresh session greets oriented. New template → add a `STACK` entry in `lib/bootstrap-prompt.js`.
- **Vite base path splits** — dev base = `/<NAME>/` (proxy needs it, V20). Static deploy: `build:pages` bakes `/<NAME>/`, `build:firebase` bakes `/`. Don't unify.
- **Firebase keys are public** — `VITE_FIREBASE_*` ship in the bundle by design. Gate access with Firestore/Storage security rules, not key secrecy.
- **Never `rm -rf` a worktree project** — the parent repo holds its registry entry. Use the UI's delete (which runs `git worktree remove`) or `git -C ~/projects/<parent> worktree remove --force <dir>`. If one got removed the hard way, `git -C ~/projects/<parent> worktree prune` cleans up (B16).
- **Upgrading ttyd/xterm invalidates the Android input shim's premise** — `lib/android-input.js` (V61) relies on xterm binding `compositionstart|update|end` in the *bubble* phase and on the public `term.textarea` / `term.input()` / `term.scrollToBottom()` surface. Re-check both against the new bundle before shipping an upgrade; if upstream ever fixes `_handleAnyTextareaChanges` (the `setTimeout(0)` + `!_isComposing` drop, B17), delete the shim rather than stacking it on a fixed path.
- **Vite `allowedHosts` must cover the tailnet host** — Vite 403s (`Blocked request. This host … is not allowed`) any `Host` it doesn't recognise, and the proxy forwards the original header. Loopback tests pass while the tailnet URL fails, so **test through the real URL, not just `127.0.0.1:8002`**. Use the suffix wildcard `allowedHosts: ['.ts.net', 'localhost', '127.0.0.1']` — it matches any MagicDNS name without committing a hostname.

See `SPEC.md` §B (bugs) + §V (invariants) for full history. Backprop new bugs via `/ck:spec bug: …`.

## Sharing across devices

Proxy binds `127.0.0.1` only — by design not reachable from LAN. Tailscale is the tested path for phone/laptop access. See the `tailscale` skill (in `.claude/skills/tailscale/`) for setup and Funnel notes.
## Hindsight memory (optional)

Per-repo long-term memory for Claude sessions on this box. It is *harness-level* —
it lives in `~/.hindsight/` and `~/.claude/`, not in this repo — and claude-hub
neither requires nor references it: no route, unit or project sentinel touches it,
and uninstalling it changes nothing here.

Install, version table, the reasoning behind each config value, verification and
gotchas: **[`HINDSIGHT.md`](HINDSIGHT.md)**.

Keep that file's version table current whenever any part of the stack is upgraded.
Every failure mode in it degrades silently by design — a memory-less session looks
exactly like a healthy one — so the table is the only baseline a drift check has.
