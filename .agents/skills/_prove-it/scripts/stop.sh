#!/bin/sh
# Stop only the server this harness started, by pid file.
set -eu
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
PIDFILE="$ROOT/.prove-it/server.pid"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null || true; echo "stopped pid $PID"; else echo "pid $PID not running"; fi
  rm -f "$PIDFILE"
else
  echo "nothing to stop (no pid file)"
fi
