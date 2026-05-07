# claude-hub — AGENTS.md

Path-routed reverse proxy + landing page. Turn one local port into multi-project dashboard. Read from disk, no phone home. Read this before changing code, systemd units, or route conventions.

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
| `services/vite@.service` | Templated. `systemctl enable --now vite@<name>` runs `npm run dev` in `~/projects/<name>` under `Restart=always`. Enabled by claude-hub during Vite-template scaffold. |

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

# restart after editing server.js / landing.html
sudo systemctl restart claude-hub.service

# probe routes locally
curl -sI http://127.0.0.1:8002/
curl -s   http://127.0.0.1:8002/api/projects | jq .
curl -s   http://127.0.0.1:8002/api/view-tree/<project> | jq .
```

## Project creation

Default template = **Vite (React + TypeScript)**. `POST /api/projects` body
field `template: 'vite' | 'none'` (default `'vite'`). Vite scaffold:

1. `templates/vite/` copied with `<NAME>` + `<PORT>` placeholders replaced.
2. Free port ≥ 5173 allocated by scanning sibling projects' `.project-meta.json` `proxyTarget`.
3. `.project-meta.json` stamped: `template: 'vite'`, `proxyTarget`, `proxyPrefix: /<name>`, `stripPrefix: false`, `openUrl: /<name>/`, `extraUnits: ['vite@<name>.service']`.
4. `npm install` (5 min timeout) in scaffolded dir.
5. `sudo systemctl enable --now vite@<name>.service`.

`template: 'none'` skips all of this — bare `AGENTS.md` + `README.md` + sentinel only.

### Manual (without the + card)

1. `mkdir ~/projects/<name>` and add `AGENTS.md` + `README.md`.
2. Drop `.project-meta.json` (schema above).
3. `sudo systemctl enable --now ttyd@<name>.service` — only systemd touch needed for terminal access. `/term/<name>/` route resolves dynamically as soon as `/run/ttyd/<name>.sock` appears.
4. (Optional) If project has live web app, set `proxyTarget` (and `stripPrefix` / `proxyPrefix` as needed) in `.project-meta.json`, point `openUrl` at prefix. claude-hub picks up on next request — no restart.

## Things that have bitten past sessions

See `SPEC.md` §B (bugs) + §V (invariants). Backprop new bugs via `/ck:spec bug: …`.

## Sharing across devices

Proxy binds `127.0.0.1` only — by design not reachable from LAN. Tailscale is the tested path for phone/laptop access. See the `tailscale` skill (in `.claude/skills/tailscale/`) for setup, Funnel notes, and the WSL2 self-loopback gotcha.