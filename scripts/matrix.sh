#!/usr/bin/env bash
# Runs every row of the README tables into results/summary.tsv, in about 40 minutes.
# Installs each Next.js version in turn, then restores package.json and the lockfile.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p results
summary=results/summary.tsv
: >"$summary"

install() {
  pnpm add --save-exact "next@$1" >/dev/null 2>&1 || { echo "install of next@$1 failed" >&2; exit 2; }
}

run() { # <script> <variant label> <env...> -- <scenarios...>
  local script="$1" variant="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  echo "== next@$(node -p "require('./node_modules/next/package.json').version") $script $variant $*"
  env ${envs[@]+"${envs[@]}"} node "scripts/$script.mjs" "$@" | tee /dev/stderr | grep -E '^(PROD_)?RESULT ' |
    sed -E "s/^(PROD_)?RESULT //" | while read -r json; do printf '%s\t%s\t%s\n' "$script" "$variant" "$json" >>"$summary"; done
}

for version in 16.3.5 16.3.8 16.5.0-canary.3 16.4.0; do
  install "$version"
  run repro default --
  run prod default --
done

run repro "DATA_DELAY_MS=0" DATA_DELAY_MS=0 -- builtin custom
run repro "PARTIAL_PREFETCHING=false" PARTIAL_PREFETCHING=false -- builtin custom
run repro "HANDLER_AGE_CHECK=false" HANDLER_AGE_CHECK=false -- custom
node scripts/apply-candidate-fix.mjs
run repro "candidate fix" -- builtin custom
run prod "candidate fix" -- custom

git checkout -- package.json pnpm-lock.yaml
# pnpm writes a release-age exclusion here for a freshly published canary
git ls-files --error-unmatch pnpm-workspace.yaml >/dev/null 2>&1 || rm -f pnpm-workspace.yaml
rm -rf node_modules
pnpm install --frozen-lockfile >/dev/null
cat "$summary"
