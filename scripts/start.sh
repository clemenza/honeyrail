#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${HONEYRAIL_TMUX_SESSION:-${AGW_TMUX_SESSION:-honeyrail_server}}"
PORT="${PORT:-4178}"
LOG_FILE="${HONEYRAIL_LOG_FILE:-${AGW_LOG_FILE:-$ROOT_DIR/npm_start.log}}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux || true)}"

if [[ -z "$TMUX_BIN" && -x /usr/local/bin/tmux ]]; then
  TMUX_BIN="/usr/local/bin/tmux"
fi

if [[ -z "$TMUX_BIN" ]]; then
  echo "tmux not found. Install tmux or set TMUX_BIN." >&2
  exit 1
fi

quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

is_listening() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

if "$TMUX_BIN" has-session -t "$SESSION_NAME" 2>/dev/null; then
  if is_listening; then
    echo "HoneyRail already running in tmux session '$SESSION_NAME' on port $PORT."
    exit 0
  fi
  echo "Found stale tmux session '$SESSION_NAME' without port $PORT listener; recreating it."
  "$TMUX_BIN" kill-session -t "$SESSION_NAME"
fi

if is_listening; then
  echo "Error: port $PORT is already in use. Run scripts/stop.sh first." >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

echo "Building HoneyRail frontend and checking backend types..."
npm run build

ROOT_Q="$(quote "$ROOT_DIR")"
LOG_Q="$(quote "$LOG_FILE")"

START_COMMAND="source ~/.zshrc >/dev/null 2>&1 || true; cd $ROOT_Q; export NODE_ENV=production; echo '--- start: '\$(date -Iseconds)' ---' >> $LOG_Q; exec node --require $ROOT_Q/node_modules/tsx/dist/preflight.cjs --import file://$ROOT_DIR/node_modules/tsx/dist/loader.mjs server/index.ts >> $LOG_Q 2>&1"

"$TMUX_BIN" new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR" "zsh -lc $(quote "$START_COMMAND")"

for _ in {1..20}; do
  if is_listening; then
    echo "HoneyRail started in tmux session '$SESSION_NAME' on http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.5
done

echo "HoneyRail did not start listening on port $PORT. Recent log:" >&2
tail -40 "$LOG_FILE" >&2 || true
exit 1
