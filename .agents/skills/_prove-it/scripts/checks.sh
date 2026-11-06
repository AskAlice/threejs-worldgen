#!/bin/sh
# checks.sh <package>: scripted half of the proof.
#   A: the package test suite (answer key rung 3).
#   B: public export list vs the committed snapshot (answer key rung 2). Additions pass, removals fail.
set -eu
PKG=${1:?usage: checks.sh <package>}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
echo "== A tests: $PKG"
node --conditions=worldgen-source --test "packages/$PKG/test/"*.test.ts
echo "== B exports vs snapshot: $PKG"
SNAP="$ROOT/.prove-it/snapshots/$PKG/exports.txt"
[ -f "$SNAP" ] || { echo "missing snapshot $SNAP"; exit 1; }
node --conditions=worldgen-source -e "import('threejs-$PKG').then(m=>{const s=require('fs').readFileSync('$SNAP','utf8').trim().split('\n').filter(Boolean);const now=Object.keys(m);const removed=s.filter(n=>!now.includes(n));const added=now.filter(n=>!s.includes(n));if(added.length)console.log('added (ok if intended): '+added.join(', '));if(removed.length){console.error('REMOVED exports: '+removed.join(', '));process.exit(1)}console.log('exports: '+now.length+', none removed')})"
