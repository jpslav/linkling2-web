#!/bin/sh
# R-021: the landing page says what Linkling is. The entry point CI and people run; the
# check itself is checks/landing.mjs, whose header says what it looks for.
#
#   sh checks/landing.sh [site-root]      (default: the repo root)
#
# Exit 0 `landing: PASS, ...`; exit 1 `landing: FAIL, ...` after one line per missing
# statement, or when the root holds no index.html; exit 2 `landing: BLIND, ...` when nothing
# could be read. This script makes exit 2 of the ways of not looking that would otherwise show
# as something else: node is not on PATH (the shell's 127), landing.mjs is not beside this
# script (node's exit 1), and landing.mjs running but not saying what it found: an empty file
# (exit 0 and silence), a syntax error (exit 1), a killed process (137 for SIGKILL). It passes
# on an exit code only when the engine's output says the matching verdict anywhere in it: PASS
# with 0, FAIL with 1, BLIND with 2. Anything else is exit 2, never a pass. It runs no external
# command before the node test, so an empty PATH reaches the node message instead of failing
# earlier.

case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
here=$(cd "$here" && pwd) || {
  echo "landing: BLIND, cannot enter the directory this script is in ($0), so nothing was read" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "landing: BLIND, node is not on PATH, so nothing was read" >&2
  exit 2
}
[ -r "$here/landing.mjs" ] || {
  echo "landing: BLIND, $here/landing.mjs is missing or unreadable, so nothing was read" >&2
  exit 2
}

out=$(node "$here/landing.mjs" "$@" 2>&1)
rc=$?
case "$rc:$out" in
  0:*"landing: PASS, "*)
    printf '%s\n' "$out"
    exit 0
    ;;
  1:*"landing: FAIL, "*)
    printf '%s\n' "$out" >&2
    exit 1
    ;;
  2:*"landing: BLIND, "*)
    printf '%s\n' "$out" >&2
    exit 2
    ;;
esac
if [ -n "$out" ]; then
  printf '%s\n' "$out" >&2
fi
echo "landing: BLIND, landing.mjs exited $rc without saying PASS, FAIL or BLIND to match, so nothing is known" >&2
exit 2
