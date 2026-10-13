#!/usr/bin/env bash
# Publishes every workspace package whose current version isn't on npm yet, in workspace order
# (dependencies first). Safe to re-run: published versions are skipped, so after a failure just run it
# again. Private packages are skipped. Afterwards every public package on npm gets a trusted publisher for
# .github/workflows/release.yml (see trust() below), so tagged releases publish from CI without a token.
#
#   scripts/publish-all.sh             # build, then publish
#   scripts/publish-all.sh --dry-run   # show what would be published (npm publish --dry-run)
#
# Auth: your `npm login` session (runs `npm login` if you aren't logged in). NPM_TOKEN still works for
# publishing (never written to disk), but npm refuses trust setup with tokens, so log in for first
# publishes. With 2FA, let npm prompt, or set NPM_OTP=123456 for the publishes.
set -euo pipefail
cd "$(dirname "$0")/.."

dry=""
[[ "${1:-}" == "--dry-run" ]] && dry="--dry-run"

# A public package that depends on a private workspace package would install broken from npm: skip it.
blocked="$(node -e '
  const ws = require("./package.json").workspaces.map((w) => require(`./${w}/package.json`))
  const priv = new Set(ws.filter((p) => p.private).map((p) => p.name))
  for (const p of ws) {
    const deps = Object.keys({ ...p.dependencies, ...p.peerDependencies }).filter((d) => priv.has(d))
    if (!p.private && deps.length) console.log(`${p.name}\t${deps.join(", ")}`)
  }')"

if [[ -z "$dry" && -z "${NPM_TOKEN:-}" ]] && ! npm whoami >/dev/null 2>&1; then npm login; fi
# Auth via a throwaway npmrc that references $NPM_TOKEN, so the token stays in the environment only.
if [[ -n "${NPM_TOKEN:-}" ]]; then
  export NPM_TOKEN
  npmrc="$(mktemp)"; trap 'rm -f "$npmrc"' EXIT
  { [[ -f .npmrc ]] && cat .npmrc; echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'; } > "$npmrc"
  export NPM_CONFIG_USERCONFIG="$npmrc"
fi
[[ -z "$dry" ]] && echo "Publishing as $(npm whoami)"

# Workspaces in package.json order, as dir<TAB>name<TAB>version<TAB>private (bash 3.2-safe: no mapfile).
todo="" public=""
while IFS=$'\t' read -r dir name version private; do
  if [[ "$private" == 1 ]]; then echo "skip  $name (private)"; continue; fi
  dep="$(printf '%s\n' "$blocked" | awk -F'\t' -v n="$name" '$1 == n { print $2 }')"
  if [[ -n "$dep" ]]; then echo "skip  $name (depends on private $dep)"; continue; fi
  public="$public $name"
  if [[ -n "$(npm view "$name@$version" version 2>/dev/null)" ]]; then echo "skip  $name@$version (already published)"; continue; fi
  echo "todo  $name@$version"
  todo="$todo $dir"
done < <(node -e '
  for (const w of require("./package.json").workspaces) {
    const p = require(`./${w}/package.json`)
    console.log([w, p.name, p.version, p.private ? 1 : 0].join("\t"))
  }')
# Trusted publishing (OIDC): lets release.yml publish each package from GitHub Actions without a token.
# npm only allows it on packages that already exist and needs your login (and 2FA), so it runs here, after
# publishing, rather than in CI. Packages that already trust release.yml are skipped, so re-runs are safe.
REPO=AskAlice/threejs-worldgen
WORKFLOW=release.yml
trust() {
  for name in $public; do
    if [[ -z "$(npm view "$name" version 2>/dev/null)" ]]; then
      echo "skip  trust $name (not on npm${dry:+; trusted after its first real publish})"; continue
    fi
    if [[ -n "$dry" ]]; then echo "would trust $name -> $REPO/$WORKFLOW"; continue; fi
    if npm trust list "$name" --json 2>/dev/null | grep -q "$WORKFLOW"; then
      echo "skip  trust $name (already trusts $WORKFLOW)"; continue
    fi
    # --allow-publish: release.yml runs `npm publish` (staged publishing is always allowed).
    npm trust github "$name" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes
  done
}

[[ -z "$todo" ]] && { echo "Nothing to publish."; trust; exit 0; }

# One full build in workspace order: each package's .d.ts build needs its dependencies' dist/.
npm run build

otp=""
[[ -n "${NPM_OTP:-}" ]] && otp="--otp=$NPM_OTP"
count=0
for dir in $todo; do
  # Already built above, so skip prepublishOnly's rebuild. Stop at the first failure: later packages
  # may depend on this one.
  npm publish -w "$dir" --access public --ignore-scripts $dry $otp
  count=$((count + 1))
done
echo "Done: ${count} package(s)${dry:+ (dry run)}."
trust
