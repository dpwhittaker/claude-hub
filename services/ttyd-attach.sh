#!/bin/bash
# Launched by ttyd for every browser connection to /term/<project>/.
# Joins (or creates) a long-lived tmux session named after the project, so
# the same shell+state is shared live across phone/desktop/etc. and survives
# ttyd or proxy restarts (only a host reboot wipes the session).
#
# On first attach (post-reboot, or after the user /quit'd claude) the session
# is created and Claude Code is launched inside it with --continue so the
# previous conversation resumes automatically.

set -e

PROJECT="$1"
PROJECT_DIR="${PROJECTS_ROOT:-$HOME/projects}/$PROJECT"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if [[ -z "$PROJECT" || ! -d "$PROJECT_DIR" ]]; then
    echo "usage: $0 <project-name> (project must exist under \$PROJECTS_ROOT, default ~/projects/)" >&2
    exit 1
fi

if ! tmux has-session -t "$PROJECT" 2>/dev/null; then
    # claude --continue only works if a prior conversation exists. For a
    # brand-new project there's nothing to resume, so claude exits
    # immediately, tmux's last window dies, the session disappears, ttyd
    # reconnects, and we loop forever. Detect the session dir claude uses
    # (~/.claude/projects/<encoded>) and only pass --continue when at least
    # one session file already lives there.
    encoded="-$(printf '%s' "$PROJECT_DIR" | sed 's|^/||; s|/|-|g')"
    sessions_dir="$HOME/.claude/projects/$encoded"
    is_fresh=1
    continue_flag=""
    if [[ -d "$sessions_dir" ]] && compgen -G "$sessions_dir/*.jsonl" > /dev/null; then
        continue_flag="--continue"
        is_fresh=0
    fi

    tmux new-session -d -s "$PROJECT" -c "$PROJECT_DIR" \
        "$CLAUDE_BIN $continue_flag --chrome"
    # window-size latest = the most recently attached/focused client's size wins
    # (closer to "fit on attach" than tmux's default of smallest-attached).
    # aggressive-resize lets the active window adapt rather than being pinned
    # to the smallest historical attach.
    tmux set-option        -t "$PROJECT" -g window-size latest
    tmux set-window-option -t "$PROJECT" -g aggressive-resize on
    # Forward terminal focus-in/out escape sequences instead of swallowing
    # them — Claude Code uses this to detect when the browser tab loses focus.
    tmux set-option        -t "$PROJECT" -g focus-events on

    # On a fresh project, kick claude with a bootstrap message a couple of
    # seconds after launch so it greets the user, reads AGENTS.md, and
    # starts populating the project's metadata. Backgrounded so the parent
    # ttyd-attach.sh can continue to `exec tmux attach`. The sleep gives
    # claude time to finish booting before we type into the pane.
    if [[ "$is_fresh" == "1" ]]; then
        bootstrap_msg="Read AGENTS.md and README.md in this directory, then briefly greet me and ask what I want to build here. Once we agree on the project, update README.md — rewrite the H1 (card title), rewrite the first paragraph (one-sentence card description), and set the 'tags: [...]' frontmatter to short tags like 'Game', 'Tool', 'API', 'Library', or 'Service' plus a status flag like 'WIP' or 'Stable'. The landing page reads all three from README."
        ( sleep 4 && tmux send-keys -t "$PROJECT" -l "$bootstrap_msg" && tmux send-keys -t "$PROJECT" Enter ) &
    fi
fi

exec tmux -u attach-session -t "$PROJECT"
