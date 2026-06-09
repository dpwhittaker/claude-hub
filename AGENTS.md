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
| `/api/projects/<name>` | `DELETE` stops `ttyd@<name>` plus any `extraUnits`, kills project's tmux session, removes folder. Needs `.project-meta.json` as sentinel. |
| `/api/view-tree/<name>` | `GET` returns project's recursive tree as JSON. With `?path=<sub>` returns one level lazily — file browser uses to expand dim dirs (`node_modules`, gitignored, …) on demand. |
| `/view/<proj>/` | Two-pane viewer: collapsible tree (left, draggable splitter) + tabbed iframes (right). README.md opens in initial tab. |
| `/view/<proj>/<file>` | Renders single file (markdown via `marked`, code via highlight.js, raw bytes via mime). `?embed=1` strips page chrome — used by two-pane viewer's iframes. `?raw=1` to download. |
| `/term/<proj>/` | Forwards to `unix:/run/ttyd/<proj>.sock` if socket exists. Resolved per request — adding project no proxy restart. |
| `/term/develop/`, `/term/wsl/` | Static admin terminals (fresh claude in `~/projects`, raw bash). |
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
| `createdAt` | ISO timestamp; cards sort by this. |
| `openUrl` | Optional. Where card's "Open" button goes. Defaults `/view/<name>/README.md`. Set to `/<name>/` (or wherever) when project has live app reachable through proxy. |
| `proxyTarget` | Optional. If set, claude-hub reverse-proxies project's prefix to this URL. Without it, no live route — only `/view/<name>/` and `/term/<name>/`. |
| `proxyPrefix` | Optional. URL prefix to match. Defaults `/<name>`. Useful when folder name and public URL diverge. |
| `stripPrefix` | Optional, default `true`. When `false`, prefix left on request — needed for upstreams that expect it (e.g. Vite with `base: "/<name>/"`). |
| `extraUnits` | Optional list of systemd units to stop when project deleted via UI (plus `ttyd@<name>.service`). Useful when project runs own backend unit. |

Title, description, tags come from **`README.md`** (NOT `.project-meta.json`):

- **Title**: first H1.
- **Description**: first paragraph after H1, inline markdown stripped.
- **Tags** (badge pills): `tags: [...]` in YAML frontmatter at top of README.md. Absent → card shows `Project`.

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
| `services/ttyd-wsl.service` | Admin: raw `bash -l`. No claude, no tmux. |
| `services/vite@.service` | Templated. `systemctl enable --now vite@<name>` runs `npm run dev` in `~/projects/<name>` under `Restart=always`. Enabled during any non-`none` template scaffold (`vite` / `game-2d` / `game-3d` / `game-3d-complex` all share this one unit). |

`/run/ttyd/` shared across every ttyd instance. All three units carry `RuntimeDirectoryPreserve=yes` for that reason — without it, one instance stop = systemd wipes whole dir, orphans every other socket. Don't remove that line.

## File-tree dimming

Two-pane viewer's left tree marks "noisy" entries dim (lower opacity, muted name color):

- Default: anything `git ls-files --others --ignored --exclude-standard
  --directory` reports. Project's `.gitignore` = source of truth.
- Fallback (no git or empty ignore output): hardcoded list — `node_modules`, `.git`, `.serve`, `dist`, `build`, `.next`, `.cache`.
- `.git` always dim, regardless.

Dim dirs not recursed eagerly — lazy-load on first expand via `/api/view-tree/<proj>?path=<sub>`. Anything inside dim dir inherits dim. Keeps `node_modules` from blowing 5000-node tree cap.

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
field `template: 'none' | 'vite' | 'game-2d' | 'game-3d' | 'game-3d-complex'`
(default `'vite'`; unknown coerced to `'vite'`; forced to `'none'` when
`github.mode ∈ {clone, onboard}`). Optional `firebase: bool` opt-in (forced
false on `none`/clone/onboard). Clone source on the dialog comes from
`GET /api/gh/repos` (cached 10 min) — only the user's own repos are listed.
Cloning someone else's repo = fork on github.com first; the fork appears in
the dropdown. `POST /api/projects` still accepts an arbitrary `source` slug
or URL for power-user direct calls.

**Template catalog** — every non-`none` template is a Vite project, so they
all share one `vite@<name>.service` (no per-template systemd unit):

| `template` | Stack | Entry |
|---|---|---|
| `vite` | React + TypeScript | `src/main.tsx` |
| `game-2d` | Phaser 3 (2D engine) | `src/main.ts` |
| `game-3d` | react-three-fiber + Three + rapier + zustand ("Simple 3D") | `src/App.tsx` |
| `game-3d-complex` | Babylon.js + Havok + inspector ("Complex 3D") | `src/main.ts` |

Scaffold (`bootstrapTemplate`):

1. `templates/<template>/` copied with `<NAME>` + `<PORT>` placeholders replaced (`template` id == dir name, 1:1).
2. Free port ≥ 5173 allocated by scanning sibling projects' `.project-meta.json` `proxyTarget`.
3. If `firebase` → `templates/_firebase/` overlaid (adds `src/firebase.ts`, `.env.example`, `firebase.json`, `.firebaserc`).
4. `.project-meta.json` stamped: `template: '<template>'`, `proxyTarget`, `proxyPrefix: /<name>`, `stripPrefix: false`, `openUrl: /<name>/`, `extraUnits: ['vite@<name>.service']`.
5. `npm install` (+ `npm install firebase` when overlaid), 5 min timeout, in scaffolded dir.
6. `sudo systemctl enable --now vite@<name>.service`.

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

- **Stale node process** — `server.js` lives in V8 memory; edits don't apply until `systemctl restart claude-hub.service`. `landing.html` is read per request, no restart needed.
- **Game template = vite project** — `game-2d`/`game-3d`/`game-3d-complex` ride the one `vite@<name>.service`, not a per-template unit. New template? Make it a vite project or you'll need a new unit + meta changes.
- **Greenfield bootstrap prompt is stack-aware** — `writeBootstrapPrompt(dir, name, 'greenfield', {templateId, firebase})` injects a `STACK[templateId]` blurb so a fresh session greets oriented. New template → add a `STACK` entry in `lib/bootstrap-prompt.js`.
- **Vite base path splits** — dev base = `/<NAME>/` (proxy needs it, V20). Static deploy: `build:pages` bakes `/<NAME>/`, `build:firebase` bakes `/`. Don't unify.
- **Firebase keys are public** — `VITE_FIREBASE_*` ship in the bundle by design. Gate access with Firestore/Storage security rules, not key secrecy.
- **WSL2 self-loopback to `*.ts.net` fails** — route lives on the Windows tailscale virtual interface (V17). Test from a peer or from Windows.

See `SPEC.md` §B (bugs) + §V (invariants) for full history. Backprop new bugs via `/ck:spec bug: …`.

## Sharing across devices

Proxy binds `127.0.0.1` only — by design not reachable from LAN. Tailscale is the tested path for phone/laptop access. See the `tailscale` skill (in `.claude/skills/tailscale/`) for setup, Funnel notes, and the WSL2 self-loopback gotcha.