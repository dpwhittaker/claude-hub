---
name: screenshots
description: Refresh the README screenshots after a significant UI change. Captures four images — landing page, Browse default, Browse + Develop side-by-side, and Develop terminal — and writes them to docs/img/. The skill emphasizes that **Claude is front-and-center throughout**: the dialog scaffolds Claude sessions, every project's Develop button opens a Claude terminal, and the tmux session in Develop runs `claude --continue` so your conversation persists across devices. Use this when the user asks to update screenshots, refresh README images, or after merging UI work in landing.html / renderViewShell / the create dialog.
---

# Refreshing the README screenshots

Run this skill after any change that affects:
- `landing.html` (cards, dialog, badges)
- `renderViewShell` in `server.js` (tree, tabs, splitter, develop pane)
- the create-project flow
- the visual styling of any of the above

The skill produces four PNGs in `docs/img/` that the README embeds:

| File | What it shows | Source URL |
|------|---------------|------------|
| `landing.png` | Hub home page with project cards | `http://127.0.0.1:8002/` |
| `browse-default.png` | Two-pane viewer, no Develop pane | `http://127.0.0.1:8002/view/claude-hub/?dev=0` |
| `browse-with-develop.png` | Two-pane viewer + Develop side-by-side | `http://127.0.0.1:8002/view/claude-hub/?dev=1` |
| `develop.png` | Full-screen browser terminal w/ live Claude | rendered from xterm buffer of `/term/claude-hub/` |

**The narrative the screenshots have to tell**: Claude does the work. The hub is the interface. Every screenshot should make that visible — a card that says "Develop", a Develop pane with a live Claude prompt, a terminal showing Claude's tool calls. If a screenshot shows the hub UI without Claude in frame, retake it.

## Step 1 — set up a clean demo for the landing page

The landing page screenshot wants three or four interesting-sounding cards plus the hardcoded `Develop` and `claude-hub` cards. Real projects usually leak personal context (incomplete WIPs, controversial topics, NDA stuff), so spin up a throwaway hub against a scratch projects root.

```bash
mkdir -p /tmp/claude-hub-demo /tmp/projects
rsync -a --exclude=node_modules --exclude=.git ./ /tmp/claude-hub-demo/
cd /tmp/claude-hub-demo
NODE_ENV= npm ci --omit=dev
```

Pick three to four invented project names. Each gets a folder under `/tmp/projects/<name>/` containing **only** these files:

```
.project-meta.json   # sentinel — see schema below
README.md            # H1 = card title, first paragraph = description, frontmatter `tags: [...]`
AGENTS.md            # one-line agent brief
```

`.project-meta.json` schema for a Vite-style proxied project:

```json
{
  "name": "<name>",
  "createdAt": "2026-04-12T15:30:00-05:00",
  "openUrl": "/<name>/",
  "proxyTarget": "http://127.0.0.1:5174",
  "proxyPrefix": "/<name>",
  "stripPrefix": false,
  "template": "vite"
}
```

For a non-served project (CLI / library), drop the proxy fields and set `"template": "none"`.

Mix the names — make some look like games, some like tools, some like APIs. Diverse `tags: [...]` (Game, Tool, API, Library, Service) plus a status flag (WIP, Stable) so the badges look varied.

Launch the demo on a port that doesn't collide with the live hub or any project backend:

```bash
PROJECTS_ROOT=/tmp/projects PROXY_PORT=9001 NODE_ENV= node server.js > /tmp/demo-hub.log 2>&1 &
sleep 1; curl -s http://127.0.0.1:9001/api/projects | head -c 300
```

Confirm the projects show up in the JSON response.

## Step 2 — capture landing.png from the demo hub

```bash
mkdir -p docs/img
OUT=$(pwd)/docs/img/landing.png
WIN_OUT=$(wslpath -w "$OUT")
'/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1280,900 \
  --screenshot="$WIN_OUT" \
  http://127.0.0.1:9001/
```

Inspect it. The grid should show **6 cards**: Develop (admin), claude-hub (infra), three to four invented project cards, and the `+` New Project tile. If any card looks empty, fix the corresponding `README.md` (frontmatter or first paragraph) and rerun.

Tear down once landing.png looks good:

```bash
kill $(pgrep -f "PROXY_PORT=9001") 2>/dev/null
rm -rf /tmp/claude-hub-demo /tmp/projects
```

## Step 3 — capture the two Browse screenshots from the live hub

The Browse screenshots should be of the **real claude-hub project** so the tree shows recognizable files (`server.js`, `SPEC.md`, `lib/`, `services/`, etc.). The `?dev=0` and `?dev=1` query params are honored by the client to force the Develop pane closed or open.

```bash
OUT=$(pwd)/docs/img/browse-default.png
WIN_OUT=$(wslpath -w "$OUT")
'/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1400,900 --virtual-time-budget=4000 \
  --screenshot="$WIN_OUT" \
  "http://127.0.0.1:8002/view/claude-hub/?dev=0"

OUT=$(pwd)/docs/img/browse-with-develop.png
WIN_OUT=$(wslpath -w "$OUT")
'/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1400,900 --virtual-time-budget=4000 \
  --screenshot="$WIN_OUT" \
  "http://127.0.0.1:8002/view/claude-hub/?dev=1"
```

`browse-with-develop.png` will show the Develop pane on the right side. The pane embeds `/term/claude-hub/` — i.e. a live Claude session attached to this project's tmux. **That's the screenshot's whole point**: the user is reading code on the left while Claude is mid-thought on the right. If the right pane is blank, the headless render didn't get enough time for ttyd to negotiate its WebSocket. Bump `--virtual-time-budget` to 8000 and retry, or fall back to the live-Chrome MCP capture in step 4.

## Step 4 — capture develop.png (live Claude terminal)

ttyd uses xterm.js with WebGL, which `--virtual-time-budget` doesn't handle reliably. Instead, capture the rendered terminal buffer directly from a real Chrome tab via the `claude-in-chrome` MCP.

The trick: read xterm's text buffer with `term.buffer.active`, render it onto a fresh 2D canvas, POST the PNG to a tiny local listener, save it.

**4a.** Spin up a one-shot uploader:

```bash
cat > /tmp/uploader.js <<'EOF'
const http = require('http');
const fs = require('fs');
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.writeFileSync('/tmp/upload.png', Buffer.concat(chunks));
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('ok');
    });
    return;
  }
  res.writeHead(404).end();
}).listen(9090, '127.0.0.1');
EOF
node /tmp/uploader.js > /tmp/uploader.log 2>&1 &
echo $! > /tmp/uploader.pid
```

**4b.** Open the live terminal in Chrome via MCP (use `127.0.0.1:8002`, not the tailnet host — fetches from a tailnet HTTPS origin to a local HTTP uploader will be blocked as mixed content). Through `mcp__claude-in-chrome__navigate` go to `http://127.0.0.1:8002/term/claude-hub/`, then `wait` ~4 seconds for Claude to print its prompt.

**4c.** Run this via `mcp__claude-in-chrome__javascript_tool`:

```javascript
(async () => {
  const t = window.term || window.terminal || (window.tty && window.tty.term);
  if (!t) return 'no term';
  const buf = t.buffer.active;
  const lines = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const shown = lines.slice(-36);
  const fontSize = 16;
  const lh = 22;
  const longest = Math.max(...shown.map(l => l.length), 80);
  const w = Math.min(1600, Math.ceil(longest * fontSize * 0.6) + 32);
  const h = shown.length * lh + 32;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d1320';
  ctx.fillRect(0, 0, w, h);
  ctx.font = fontSize + 'px ui-monospace, "JetBrains Mono", Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#e2e8f0';
  for (let i = 0; i < shown.length; i++) ctx.fillText(shown[i], 16, 16 + i * lh);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const r = await fetch('http://127.0.0.1:9090/', { method: 'POST', body: blob });
  return { ok: r.status === 200, w, h, shown: shown.length };
})()
```

**4d.** Save the result + tear down:

```bash
cp /tmp/upload.png docs/img/develop.png
kill $(cat /tmp/uploader.pid); rm -f /tmp/uploader.pid /tmp/uploader.{js,log}
```

The terminal buffer that lands in the screenshot is whatever Claude was last doing in that tmux session. **Pick a moment where Claude is mid-task** — running a tool, printing diff output, asking a clarifying question, anything that makes Claude visibly the protagonist. If the buffer shows only a blank prompt, send a quick "what should we build today?" through the actual terminal first, wait for Claude's response, then capture.

If you're worried about leaking session content, kill the tmux session (`tmux kill-session -t claude-hub`), reconnect through the browser to spawn a fresh Claude (it'll boot with `--continue`, so the prior conversation reappears — to truly start clean, also `rm ~/.claude/projects/-home-david-projects-claude-hub/*.jsonl` first), and capture the welcome banner instead.

## Step 5 — review and commit

```bash
ls -la docs/img/
git add docs/img/ README.md
git commit -m "docs: refresh screenshots after <UI change>"
git push
```

Open the README on GitHub once pushed and verify each image renders. Compressed PNGs ≤ 250 KB each is a sensible target — if anything's substantially bigger, the source render was probably oversized; rerun with smaller `--window-size`.

## What to skip

- **Don't screenshot the user's real projects** unless they explicitly say so. They'll usually be incomplete, controversial, or contain client work. Use the `/tmp/projects` demo flow for landing.png.
- **Don't include the browser URL bar.** Headless Chrome captures viewport only; live MCP screenshots can include UI chrome — if so, crop or use the canvas-buffer approach.
- **Don't bake the user's tailnet hostname (`*.ts.net`) into screenshots.** Stick to `127.0.0.1:8002` URLs for headless captures.
- **Don't add CI for these.** Screenshot regression testing is its own thing; this skill is a manual refresh after deliberate UI work.
