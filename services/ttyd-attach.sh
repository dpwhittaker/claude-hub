#!/bin/bash
# Launched by ttyd for every browser connection to /term/<key>/.
#
# `<key>` is the ttyd@%i instance name. Two shapes:
#
#   <project>__<tabId>   per-tab develop terminal (e.g. claude-hub__s1).
#                        tabId is `sN`. tmux session name = full key. Each tab
#                        owns its own claude conversation, identified by the
#                        uuid recorded in <project>/.develop-sessions.json
#                        under sessions[tabId]. The first attach for a tab
#                        runs `claude --session-id <uuid>`; subsequent
#                        attaches (and post-host-reboot restarts) run
#                        `claude --resume <uuid>` so the conversation
#                        persists. Closing the tab in the UI destroys the
#                        tmux session and removes the entry from the map.
#
#   <project>            legacy bare-project key, prior to multi-tab. Left
#                        functional for any unit that hasn't been migrated.
#                        Same --continue gate as before.
#
# The tmux session is long-lived: it survives ttyd restarts and is shared
# live across every concurrent browser attach (phone/desktop/etc.). Only a
# host reboot wipes it; on the next attach we resume via `--resume <uuid>`.

set -e

KEY="$1"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"

if [[ -z "$KEY" ]]; then
    echo "usage: $0 <project> | <project>__<tabId>" >&2
    exit 1
fi

# Split key on the FIRST '__' so project names containing literal underscores
# survive — only the suffix after the separator is the tab id.
if [[ "$KEY" == *__* ]]; then
    PROJECT="${KEY%%__*}"
    TAB_ID="${KEY#*__}"
else
    PROJECT="$KEY"
    TAB_ID=""
fi

PROJECT_DIR="$PROJECTS_ROOT/$PROJECT"
if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "project dir not found: $PROJECT_DIR" >&2
    exit 1
fi

# Resolve the claude command for this tab. For per-tab keys we always run
# `claude --session-id <uuid>` (first launch) or `claude --resume <uuid>`
# (uuid already has a jsonl on disk). For legacy bare keys we keep the
# pre-multi-tab `--continue` gate.
encoded="-$(printf '%s' "$PROJECT_DIR" | sed 's|^/||; s|/|-|g')"
sessions_dir="$HOME/.claude/projects/$encoded"

if [[ -n "$TAB_ID" ]]; then
    sessions_file="$PROJECT_DIR/.develop-sessions.json"
    UUID=""
    if [[ -f "$sessions_file" ]]; then
        # Minimal JSON probe — no jq dependency. Matches "tabId": "uuid".
        UUID=$(sed -n "s/.*\"${TAB_ID}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$sessions_file" | head -1)
    fi
    if [[ -z "$UUID" ]]; then
        echo "no session uuid for tab $TAB_ID in $sessions_file" >&2
        exit 1
    fi
    if [[ -f "$sessions_dir/$UUID.jsonl" ]]; then
        claude_cmd="$CLAUDE_BIN --resume $UUID --chrome"
        is_fresh=0
    else
        claude_cmd="$CLAUDE_BIN --session-id $UUID --chrome"
        is_fresh=1
    fi
else
    # Legacy bare-key path. --continue only if a prior session exists, else
    # plain `claude` (V4 exit-loop guard).
    continue_flag=""
    is_fresh=1
    if [[ -d "$sessions_dir" ]] && compgen -G "$sessions_dir/*.jsonl" > /dev/null; then
        continue_flag="--continue"
        is_fresh=0
    fi
    claude_cmd="$CLAUDE_BIN $continue_flag --chrome"
fi

if ! tmux has-session -t "$KEY" 2>/dev/null; then
    tmux new-session -d -s "$KEY" -c "$PROJECT_DIR" "$claude_cmd"
    # window-size latest = the most recently attached/focused client's size wins
    # (closer to "fit on attach" than tmux's default of smallest-attached).
    # aggressive-resize lets the active window adapt rather than being pinned
    # to the smallest historical attach.
    tmux set-option        -t "$KEY" -g window-size latest
    tmux set-window-option -t "$KEY" -g aggressive-resize on
    # Forward terminal focus-in/out escape sequences instead of swallowing
    # them — Claude Code uses this to detect when the browser tab loses focus.
    tmux set-option        -t "$KEY" -g focus-events on
    # Mouse mode: wheel events from the browser (incl. the touch→wheel shim)
    # reach tmux, which forwards them to the inner app when it requested mouse
    # tracking — Claude Code does, and scrolls its own transcript in the
    # alternate screen. Do NOT bind WheelUpPane to bare `copy-mode`; the
    # default binding's conditional passthrough is required (alt screen has no
    # tmux history — copy-mode there shows [0/0]).
    tmux set-option        -t "$KEY" -g mouse on
    # OSC 52 clipboard bridge. With set-clipboard on, tmux emits
    # \e]52;c;<base64>\a whenever a mouse-mode selection is copied;
    # claude-hub's WebSocket shim catches that on the browser side and
    # writes it to navigator.clipboard. terminal-overrides forces the Ms
    # capability so xterm-style terminfos that omit it still trigger
    # tmux's emit path.
    tmux set-option        -t "$KEY" -g set-clipboard on
    tmux set-option        -ga terminal-overrides ',xterm*:Ms=\E]52;%p1%s;%p2%s\007'

    # On a fresh project, send claude a bootstrap message a few seconds after
    # launch so it greets the user, reads AGENTS.md, and populates the
    # project's metadata. The bootstrapper in claude-hub writes a project-
    # specific prompt to .claude-bootstrap.txt — different copy for greenfield
    # vs cloned projects (V30/V31). If the file is absent (e.g. a project
    # created out-of-band by hand), fall back to a generic greenfield prompt.
    # Backgrounded so the parent ttyd-attach.sh can `exec tmux attach`. The
    # sleep gives claude time to finish booting before we type into the pane.
    # Only fire on the project's very first tab so secondary tabs start clean.
    if [[ "$is_fresh" == "1" && ( -z "$TAB_ID" || "$TAB_ID" == "s1" ) ]]; then
        bootstrap_file="$PROJECT_DIR/.claude-bootstrap.txt"
        ( sleep 4
          if [[ -f "$bootstrap_file" ]]; then
              tmux send-keys -t "$KEY" -l "$(cat "$bootstrap_file")"
              rm -f "$bootstrap_file"
          else
              tmux send-keys -t "$KEY" -l "Read AGENTS.md and README.md in this directory, then briefly greet me and ask what I want to build here. Once we agree on the project, update README.md — rewrite the H1 (card title), rewrite the first paragraph (one-sentence card description), and set the 'tags: [...]' frontmatter to short tags like 'Game', 'Tool', 'API', 'Library', or 'Service' plus a status flag like 'WIP' or 'Stable'. The landing page reads all three from README."
          fi
          tmux send-keys -t "$KEY" Enter
        ) &
    fi
fi

exec tmux -u attach-session -t "$KEY"
