#!/bin/sh
# Truth-pin: fail CI when product facts in this repo drift from ground truth.
#
# Forbids copy that was ever true and no longer is (stale quotas, the old docs
# URL, "midnight UTC" resets) and requires the current facts wherever the repo
# states quotas at all. POSIX sh, no dependencies beyond git and grep.
#
# CHANGELOG.md is exempt from the forbidden scans: its older entries describe
# history and are allowed to quote what the product used to say.
set -eu
cd "$(dirname "$0")/.."

fail=0

files=$(git ls-files '*.md' '*.ts' '*.json' '*.yml' '*.mjs' \
  | grep -v -e '^package-lock\.json$' -e '^CHANGELOG\.md$' -e '^scripts/truthcheck\.sh$')

forbid() {
  pattern=$1
  why=$2
  hits=$(printf '%s\n' "$files" | xargs grep -inE "$pattern" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf 'FORBIDDEN (%s):\n%s\n' "$why" "$hits"
    fail=1
  fi
}

forbid '(100[, ]?000|100k)[^0-9]{0,20}(request|/day|per day|daily)' 'stale pre-cut day quota'
forbid 'free[^0-9]{0,40}1,?000[^0-9]{0,3}/ ?day' 'stale FREE=1k/day quota (FREE is 100/day)'
forbid 'livetennisapi\.com/docs' 'docs live at docs.livetennisapi.com, not livetennisapi.com/docs'
forbid 'bensynapse' 'personal handle in org-owned metadata'
forbid 'midnight UTC' 'the daily reset is a local-midnight-derived instant, NOT midnight UTC'

# This repo states quotas (README quota table), so the current grid must be there.
grep -qE '100(/day| requests/day)' README.md \
  || { echo 'REQUIRED: README must state the FREE 100/day quota'; fail=1; }
grep -q 'docs\.livetennisapi\.com' README.md \
  || { echo 'REQUIRED: README must link docs.livetennisapi.com'; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo 'truthcheck: OK'
fi
exit "$fail"
