#!/usr/bin/env bash
# Publishes every workspace package whose current version isn't on npm yet, in workspace order
# (dependencies first). Safe to re-run: published versions are skipped, so after a failure just run it
# again. Private packages are skipped.
#
#   scripts/publish-all.sh             # build, then publish
#   scripts/publish-all.sh --dry-run   # show what would be published (npm publish --dry-run)
#
# Auth: uses NPM_TOKEN if set (never written to disk), otherwise your `npm login` session, otherwise
# asks for a token. With 2FA on publish, set NPM_OTP=123456 or let npm prompt for it.
set -euo pipefail
cd "$(dirname "$0")/.."

dry=""
[[ "${1:-}" == "--dry-run" ]] && dry="--dry-run"

# Auth via a throwaway npmrc that references $NPM_TOKEN, so the token stays in the environment only.
if [[ -z "$dry" && -z "${NPM_TOKEN:-}" ]] && ! npm whoami >/dev/null 2>&1; then
  read -rsp "npm access token: " NPM_TOKEN; echo
fi
if [[ -n "${NPM_TOKEN:-}" ]]; then
  export NPM_TOKEN
  npmrc="$(mktemp)"; trap 'rm -f "$npmrc"' EXIT
  { [[ -f .npmrc ]] && cat .npmrc; echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'; } > "$npmrc"
  export NPM_CONFIG_USERCONFIG="$npmrc"
fi
[[ -z "$dry" ]] && echo "Publishing as $(npm whoami)"

# Workspaces in package.json order, as dir<TAB>name<TAB>version<TAB>private (bash 3.2-safe: no mapfile).
todo=""
while IFS=$'\t' read -r dir name version private; do
  if [[ "$private" == 1 ]]; then echo "skip  $name (private)"; continue; fi
  if [[ -n "$(npm view "$name@$version" version 2>/dev/null)" ]]; then echo "skip  $name@$version (already published)"; continue; fi
  echo "todo  $name@$version"
  todo="$todo $dir"
done < <(node -e '
  for (const w of require("./package.json").workspaces) {
    const p = require(`./${w}/package.json`)
    console.log([w, p.name, p.version, p.private ? 1 : 0].join("\t"))
  }')
[[ -z "$todo" ]] && { echo "Nothing to publish."; exit 0; }

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
