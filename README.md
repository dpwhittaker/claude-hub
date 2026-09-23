# claude-hub

One page over everything under `~/projects`: the Claude Code (or Codex, or plain shell) sessions running in tmux, the dev servers and daemons systemd keeps up, and every file, all as tabs you arrange in free-form panels. Reachable from a laptop, a phone or the G2 glasses over Tailscale, with the same workspace waiting on each.

There is no "project" in the UI. A **session** is an agent running in some folder; a **service** is a systemd unit, with its site when it serves one; a **file** opens raw, rendered, in an editor or as a diff. A **profile** holds your open tabs and layout, plus the instructions appended to every Claude session you start, so two people (or one person's separate lives) share the box without sharing a workspace.

## What you get

- **Terminals that survive everything.** Each session is a tmux session served by one ttyd unit. Close the laptop, open the phone: same scrollback, same conversation. Suspend it from the tab's bar; reconnect starts it again and Claude resumes where it was. Titles follow Claude's own naming, `/rename`, and an auto-titler that renames the tab as the work drifts.
- **Panels, not windows.** Drag a tab to a panel edge to split, to its centre to move, onto a strip to reorder. Sizes are proportions, so the same layout renders on a 4K monitor and a quarter-width side panel. Narrow screens collapse panels into tab groups in a menu.
- **Files anywhere.** A browser rooted at `~/projects`, folders coloured by whether a terminal is open there. Raw shows highlighted source, View renders markdown, images, PDFs and the live page for html behind a dev server, Edit is CodeMirror with Ctrl+Space completion from the local `claude` CLI, Diff compares against HEAD or any commit that touched the file. Saves refuse to clobber a file an agent changed meanwhile.
- **Services with their sites.** Units you maintain are discovered, not registered, and matched to their `tailscale serve` listeners. A service tab shows the site, the unit file or a live log tail, with start, stop and restart in its bar.
- **New repos.** From a template (Vite + React, Phaser, react-three-fiber, Babylon, Jekyll, an Even Realities G2 app), a clone of one of your GitHub repos, or an existing folder. The scaffold gets a dev-server unit behind the proxy and a Claude session seeded with an orientation prompt.
- **Glasses.** The G2 app reads a terminal through tmux, speaks prompts into it, and answers Claude's questions and permission prompts through a hook that is inert unless the glasses are watching.

## Run it

```bash
git clone https://github.com/dpwhittaker/claude-hub.git ~/projects/claude-hub
cd ~/projects/claude-hub && npm install
sudo install -m 644 services/claude-hub.service /etc/systemd/system/    # edit User= and paths first
sudo install -m 644 services/ttyd-hub.service /etc/systemd/system/
sudo install -m 755 services/ttyd-attach-hub.sh /usr/local/bin/
sudo install -m 644 services/vite@.service services/jekyll@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now claude-hub.service ttyd-hub.service
node services/install-session-hooks.mjs      # tab titles follow the work (Claude Code Stop hook)
node services/install-glasses-hooks.mjs      # only if you have the glasses app
```

The hub binds `127.0.0.1:8002`. `tailscale serve --bg --https=443 http://localhost:8002` puts it on your tailnet with a real certificate and nothing on the public internet. Open `https://<your-box>.<tailnet>.ts.net/`, pick or create a profile, and start a terminal from any folder in the Explorer.

Requirements: Node 22+, tmux, ttyd 1.7+, a `claude` login (the completion and the auto-titler use it), and passwordless `sudo systemctl` for the hub's user so it can start and stop units.

## Where things live

- `~/.claude-hub/` holds the state: `profiles/<id>/profile.json` and `CLAUDE.md`, `sessions/<id>.json`, `titles.json`, and an optional `services.json` that names units to show or gives one a URL.
- `~/projects/<name>/.project-meta.json` is a project's proxy config: `proxyTarget`, `proxyPrefix`, `stripPrefix`, `extraUnits`, and optional `routes` mapping source files to the URLs they render at.
- `SPEC.md` is the durable spec (goals, interfaces, invariants, tasks, bugs); `AGENTS.md` is the brief for an agent working on the hub itself; `SDD.md` is the protocol both follow.
