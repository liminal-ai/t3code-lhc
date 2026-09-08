#!/usr/bin/env bash
# check-lhc-touch.sh: verify the fork footprint over lhc-release/BASE..<head>.
#
#   scripts/check-lhc-touch.sh [head]        (default HEAD)
#
# Checks, in order:
#   1. BASE is a commit here and an ancestor of <head>.
#   2. If BASE_TAG exists locally, its peeled commit equals BASE (skipped with a
#      note when the tag is absent; tags live on the `upstream` remote).
#   3. Workflows: every deletion under .github/workflows/ is expected and not
#      inventoried; every file under .github/workflows/ in <head> starts with lhc-.
#   4. Inventory, both ways: every other path in `git diff BASE..<head>` is listed
#      in lhc-release/INVENTORY, and every listed path differs.
# Exit 0 only when all pass. Plain bash + git, no other dependencies.
set -euo pipefail
export LC_ALL=C

root=$(git rev-parse --show-toplevel)
cd "$root"
head=${1:-HEAD}
base=$(tr -d '[:space:]' < lhc-release/BASE)
tag=$(tr -d '[:space:]' < lhc-release/BASE_TAG)
fail=0
note() { printf '%s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; fail=1; }

# 1. BASE
git cat-file -e "$base^{commit}" 2>/dev/null || { bad "BASE $base is not a commit in this repository"; printf 'check-lhc-touch: FAIL\n'; exit 1; }
if git merge-base --is-ancestor "$base" "$head"; then
  note "BASE $base is an ancestor of $head"
else
  bad "BASE $base is not an ancestor of $head"
fi

# 2. BASE_TAG peel
if peeled=$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null); then
  if [ "$peeled" = "$base" ]; then
    note "BASE_TAG $tag peels to BASE"
  else
    bad "BASE_TAG $tag peels to $peeled, BASE is $base"
  fi
else
  note "note: tag $tag not present locally, peel check skipped (git fetch upstream --tags to enable)"
fi

# 3. Workflows rule
survivors=$(git ls-tree -r --name-only "$head" -- .github/workflows/ || true)
while IFS= read -r wf; do
  [ -n "$wf" ] || continue
  case "${wf#.github/workflows/}" in
    lhc-*) ;;
    *) bad "workflow survives without lhc- prefix: $wf" ;;
  esac
done <<< "$survivors"
deleted_wf=$(git diff --name-status --no-renames "$base" "$head" -- .github/workflows/ | awk '$1=="D"{print $2}' | wc -l)
note "workflows: $deleted_wf upstream workflow(s) deleted, $(printf '%s\n' "$survivors" | grep -c . || true) surviving file(s)"

# 4. Inventory, both ways
diff_paths=$(git diff --name-status --no-renames "$base" "$head" \
  | awk '!($1=="D" && $2 ~ /^\.github\/workflows\//) {print $2}' | sort -u)
inv_paths=$(grep -v '^[[:space:]]*#' lhc-release/INVENTORY | grep -v '^[[:space:]]*$' | sort -u)
missing=$(comm -23 <(printf '%s\n' "$diff_paths") <(printf '%s\n' "$inv_paths") | grep . || true)
stale=$(comm -13 <(printf '%s\n' "$diff_paths") <(printf '%s\n' "$inv_paths") | grep . || true)
if [ -n "$missing" ]; then
  bad "path(s) differ from BASE but are not in lhc-release/INVENTORY:"
  printf '  %s\n' $missing
fi
if [ -n "$stale" ]; then
  bad "path(s) listed in lhc-release/INVENTORY do not differ from BASE:"
  printf '  %s\n' $stale
fi
note "inventory: $(printf '%s\n' "$diff_paths" | grep -c .) differing path(s), $(printf '%s\n' "$inv_paths" | grep -c .) listed"

if [ "$fail" -eq 0 ]; then
  printf 'check-lhc-touch: PASS\n'
else
  printf 'check-lhc-touch: FAIL\n'
  exit 1
fi
