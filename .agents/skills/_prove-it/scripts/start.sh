#!/bin/sh
# Start the demo server on the fixed project port if it is not already healthy.
# Detached: no caller streams stay open, so RUN=$(start.sh) returns immediately.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
PORT=8460
RUN="$ROOT/.prove-it"
mkdir -p "$RUN"
if curl -sf -o /dev/null "http://localhost:$PORT/"; then echo "already up: http://localhost:$PORT/"; exit 0; fi
if [ -f "$RUN/server.pid" ] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then
  echo "pid $(cat "$RUN/server.pid") alive but not answering; stopping it"; "$ROOT/.agents/skills/_prove-it/scripts/stop.sh"
fi
cd "$ROOT"
nohup npm run dev </dev/null >"$RUN/server.log" 2>&1 &
echo $! >"$RUN/server.pid"
for i in $(seq 1 40); do
  if curl -sf -o /dev/null "http://localhost:$PORT/"; then echo "started pid $(cat "$RUN/server.pid") at http://localhost:$PORT/"; exit 0; fi
  sleep 0.5
done
echo "did not become healthy; last log:"; tail -20 "$RUN/server.log"; exit 1
