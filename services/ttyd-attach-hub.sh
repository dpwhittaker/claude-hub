#!/bin/bash
# Launched by ttyd-hub.service for every browser connection to
# /term/hub/?arg=<id>. ttyd runs with --url-arg, so the id in the URL arrives
# as $1 — one ttyd unit serves every hub session instead of one unit per tab.
#
# A hub session is a small JSON record the hub wrote:
#   $HUB_STATE_DIR/sessions/<id>.json    {id, cwd, agent, uuid, profile, …}
#   $HUB_STATE_DIR/sessions/<id>.prompt  optional first prompt (sent once, then deleted)
#
# It maps to a terminal keyed `hub-<id>`, created here on first attach and
# shared live by every later attach (phone, desktop, glasses relay). The
# terminal is a detached g2mirror session running `env HUB_TERM_KEY=<key> …
# <agent>` — the key is how the hub finds it (lib/g2sessions.js) — and each
# tab attaches with `--force --watch`: the newest tab drives the session,
# older ones keep showing it and take it back on a click or key. The agent:
#   claude → `claude --session-id <uuid>` first time, `--resume <uuid>` after
#            (transcript on disk under ~/.claude/projects/<encoded cwd>/), plus
#            `--append-system-prompt-file <profile CLAUDE.md>` when the
#            session's profile has instructions (SPEC §V84).
#   codex  → plain `codex` (no id preassignment; the terminal is its
#            persistence).
#   shell  → `bash -l` in the folder.

set -e

ID="$1"
HUB_DIR="${HUB_STATE_DIR:-$HOME/.claude-hub}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
CODEX_BIN="${CODEX_BIN:-codex}"
G2MIRROR_BIN="${G2MIRROR_BIN:-$HOME/.local/bin/g2mirror}"
PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"

if [[ ! "$ID" =~ ^[a-z0-9]{8}$ ]]; then
    echo "usage: $0 <session id>  (got: '$ID')" >&2
    exit 1
fi

FILE="$HUB_DIR/sessions/$ID.json"
if [[ ! -f "$FILE" ]]; then
    echo "unknown hub session: $ID" >&2
    exit 1
fi

# One field per line, in a fixed order, so bash needs no JSON parser.
{ read -r CWD; read -r AGENT; read -r UUID; read -r PROFILE; } < <(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const k of ["cwd", "agent", "uuid", "profile"]) console.log(String(s[k] == null ? "" : s[k]).replace(/\n/g, " "));
' "$FILE")

DIR="$PROJECTS_ROOT${CWD:+/$CWD}"
if [[ ! -d "$DIR" ]]; then
    echo "session folder not found: $DIR" >&2
    exit 1
fi

KEY="hub-$ID"
INSTRUCTIONS="$HUB_DIR/profiles/$PROFILE/CLAUDE.md"

case "$AGENT" in
    shell)
        agent=(bash -l)
        ;;
    codex)
        agent=("$CODEX_BIN")
        ;;
    *)
        encoded="-$(printf '%s' "$DIR" | sed 's|^/||; s|/|-|g')"
        sessions_dir="$HOME/.claude/projects/$encoded"
        if [[ -n "$UUID" && -f "$sessions_dir/$UUID.jsonl" ]]; then
            agent=("$CLAUDE_BIN" --resume "$UUID" --chrome)
        else
            agent=("$CLAUDE_BIN" --session-id "$UUID" --chrome)
        fi
        if [[ -n "$PROFILE" && -s "$INSTRUCTIONS" ]]; then
            agent+=(--append-system-prompt-file "$INSTRUCTIONS")
        fi
        ;;
esac

PROMPT_FILE="$HUB_DIR/sessions/$ID.prompt"

# The lock keeps two tabs opening a new session at once from starting it
# twice. `running` matches the headless wrapper's own command line, anchored:
# attach clients carry the key too.
running() { pgrep -u "$(id -u)" -f "^[^ ]*g2mirror --headless .* -- env HUB_TERM_KEY=$KEY " >/dev/null; }
mkdir -p "$HUB_DIR/locks"
exec 9>"$HUB_DIR/locks/$KEY.lock"
flock 9
if ! running; then
    # The agent gets the terminal type the browser tab really is, and the
    # key first, so the attach pattern below always has a space after it.
    ERR="$HUB_DIR/locks/$KEY.err"
    if ! SOCKET="$(cd "$DIR" && "$G2MIRROR_BIN" --detached --title "$KEY" -- \
            env HUB_TERM_KEY="$KEY" TERM=xterm-256color COLORTERM=truecolor "${agent[@]}" 2>"$ERR")"; then
        cat "$ERR" >&2
        exit 1
    fi
    if [[ -f "$PROMPT_FILE" && "$AGENT" != "shell" && -n "$SOCKET" ]]; then
        # Typed once Claude is up; the pause before Enter makes it a submit,
        # not a paste ending in a newline.
        ( sleep 4
          node -e '
            const [sock, file] = process.argv.slice(1);
            const text = require("fs").readFileSync(file);
            const c = require("net").createConnection(sock, () => {
              const msg = (m) => JSON.stringify(m) + "\n";
              c.end(msg({ type: "init", version: 1, device: "claude-hub", width: 80, height: 24, size_rank: 4294967295 })
                + msg({ type: "input", data: Buffer.concat([text, Buffer.from("\r")]).toString("base64"),
                        delays: [{ at: text.length, ms: 150 }] }));
            });
            c.on("error", () => process.exit(1));
          ' "${G2MIRROR_DIR:-$HOME/.g2mirror}/$SOCKET" "$PROMPT_FILE" && rm -f "$PROMPT_FILE"
        ) &
    fi
fi
flock -u 9
exec 9>&-

exec "$G2MIRROR_BIN" -a "HUB_TERM_KEY=$KEY " --force --watch
