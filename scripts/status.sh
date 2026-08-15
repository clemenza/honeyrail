#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${HONEYRAIL_TMUX_SESSION:-${AGW_TMUX_SESSION:-honeyrail_server}}"
PORT="${PORT:-4178}"
LOG_FILE="${HONEYRAIL_LOG_FILE:-${AGW_LOG_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/npm_start.log}}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"

if [[ -z "$TMUX_BIN" && -x /usr/local/bin/tmux ]]; then
  TMUX_BIN="/usr/local/bin/tmux"
fi

if [[ -n "$TMUX_BIN" ]] && "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux: running ($SESSION_NAME)"
  "$TMUX_BIN" list-panes -t "$SESSION_NAME" -F "pane_pid=#{pane_pid} command=#{pane_current_command} dead=#{pane_dead}"
else
  echo "tmux: not running ($SESSION_NAME)"
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port: listening ($PORT)"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
else
  echo "port: not listening ($PORT)"
fi

echo "auth:"
curl -fsS "http://127.0.0.1:$PORT/api/auth/config" 2>/dev/null || true
echo

if [[ -f "$LOG_FILE" ]]; then
  echo "recent log:"
  tail -20 "$LOG_FILE"
fi
