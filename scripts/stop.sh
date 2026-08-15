#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${HONEYRAIL_TMUX_SESSION:-${AGW_TMUX_SESSION:-honeyrail_server}}"
PORT="${PORT:-4178}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"

if [[ -z "$TMUX_BIN" && -x /usr/local/bin/tmux ]]; then
  TMUX_BIN="/usr/local/bin/tmux"
fi

if [[ -z "$TMUX_BIN" ]]; then
  echo "tmux not found. Install tmux or set TMUX_BIN." >&2
  exit 1
fi

# Kill the tmux session (if any)
if "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
  "$TMUX_BIN" kill-session -t "$SESSION_NAME"
  echo "Stopped tmux session '$SESSION_NAME'."
else
  echo "tmux session '$SESSION_NAME' is not running."
fi

# Kill any orphaned process still holding the port (not in tmux)
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Killing orphaned process on port $PORT..." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
fi

# Wait up to 3s for graceful shutdown
for _ in {1..6}; do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# SIGKILL fallback if SIGTERM was ignored
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Process ignored SIGTERM, sending SIGKILL..." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Final check
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: port $PORT still in use after SIGKILL:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi
