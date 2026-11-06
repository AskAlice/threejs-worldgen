#!/bin/sh
# health.sh <package>: print target, build and the answer for "is it worth driving?".
set -eu
PKG=${1:?usage: health.sh <package>}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
PORT=8460
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
VER=$(node -e "console.log(require('$ROOT/packages/$PKG/package.json').version)" 2>/dev/null || echo "?")
echo "package: $PKG@$VER"
echo "commit: $SHA"
echo "target: http://localhost:$PORT/ ($ROOT, local dev server)"
if curl -sf -o /dev/null "http://localhost:$PORT/"; then
  echo "server: UP"
  node --conditions=worldgen-source -e "import('threejs-$PKG').then(m=>console.log('library: UP ('+Object.keys(m).length+' exports)')).catch(e=>{console.error('library: DOWN '+e.message);process.exit(1)})" 2>/dev/null || { echo "library: DOWN (import failed)"; exit 1; }
else
  echo "server: DOWN (run scripts/start.sh)"; exit 1
fi
