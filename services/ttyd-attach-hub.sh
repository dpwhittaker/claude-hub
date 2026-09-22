#!/bin/bash
# Launched by ttyd-hub.service for every browser connection to
# /term/hub/?arg=<id>. ttyd runs with --url-arg, so the id in the URL arrives
# as $1 — one ttyd unit serves every hub session instead of one unit per tab.
#
# A hub session is a small JSON record the hub wrote:
#   $HUB_STATE_DIR/sessions/<id>.json    {id, cwd, agent, uuid, profile, …}
#   $HUB_STATE_DIR/sessions/<id>.prompt  optional first prompt (sent once, then deleted)
#
# It maps to tmux session `hub-<id>`, created here on first attach and shared
# live by every later attach (phone, desktop, glasses relay). The agent:
#   claude → `claude --session-id <uuid>` first time, `--resume <uuid>` after
#            (transcript on disk under ~/.claude/projects/<encoded cwd>/), plus
#            `--append-system-prompt-file <profile CLAUDE.md>` when the
#            session's profile has instructions (SPEC §V84).
#   codex  → plain `codex` (no id preassignment; tmux is its persistence).
#   shell  → `bash -l` in the folder.

set -e

ID="$1"
HUB_DIR="${HUB_STATE_DIR:-$HOME/.claude-hub}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
CODEX_BIN="${CODEX_BIN:-codex}"
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
        agent_cmd="bash -l"
        ;;
    codex)
        agent_cmd="$CODEX_BIN"
        ;;
    *)
        encoded="-$(printf '%s' "$DIR" | sed 's|^/||; s|/|-|g')"
        sessions_dir="$HOME/.claude/projects/$encoded"
        if [[ -n "$UUID" && -f "$sessions_dir/$UUID.jsonl" ]]; then
            agent_cmd="$CLAUDE_BIN --resume $UUID --chrome"
        else
            agent_cmd="$CLAUDE_BIN --session-id $UUID --chrome"
        fi
        if [[ -n "$PROFILE" && -s "$INSTRUCTIONS" ]]; then
            agent_cmd="$agent_cmd --append-system-prompt-file $INSTRUCTIONS"
        fi
        ;;
esac

if ! tmux has-session -t "=$KEY" 2>/dev/null; then
    tmux new-session -d -s "$KEY" -c "$DIR" "$agent_cmd"
    # Same tmux tuning as ttyd-attach.sh: latest client's size wins, focus
    # events through, mouse on (wheel → Claude's transcript), OSC 52 clipboard.
    tmux set-option        -t "=$KEY" -g window-size latest
    tmux set-window-option -t "=$KEY" -g aggressive-resize on
    tmux set-option        -t "=$KEY" -g focus-events on
    tmux set-option        -t "=$KEY" -g mouse on
    tmux set-option        -t "=$KEY" -g set-clipboard on
    tmux set-option        -ga terminal-overrides ',xterm*:Ms=\E]52;%p1%s;%p2%s\007'

    PROMPT_FILE="$HUB_DIR/sessions/$ID.prompt"
    if [[ -f "$PROMPT_FILE" && "$AGENT" != "shell" ]]; then
        ( sleep 4
          tmux send-keys -t "=$KEY:" -l "$(cat "$PROMPT_FILE")"
          tmux send-keys -t "=$KEY:" Enter
          rm -f "$PROMPT_FILE"
        ) &
    fi
fi

exec tmux -u attach-session -t "=$KEY"
