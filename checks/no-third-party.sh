#!/bin/sh
# R-023: the public site loads nothing from any other origin. The entry point CI and people
# run (linkling-api docs/adr/0008-third-party-services.md names this file); the check itself
# is checks/check.mjs, whose header says what it covers and what it does not.
#
#   sh checks/no-third-party.sh [site-root]      (default: the repo root)
#
# Exit 0 `no-third-party: PASS, ...`; exit 1 `no-third-party: FAIL, ...` after one line per
# problem; exit 2 `no-third-party: BLIND, ...`. This script adds the ways of not looking that
# a shell would otherwise report as something else: node is not on PATH, or check.mjs is not
# beside this script (the shell's 127), and check.mjs running but not saying what it found:
# an empty file (exit 0 and silence), a syntax error (exit 1), a killed process. It passes on
# an exit code only when the engine's last word agrees with it. All of those are exit 2,
# never a pass. It runs no external command before the node test, so an empty PATH reaches
# the node message instead of failing earlier.

case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
here=$(cd "$here" && pwd) || {
  echo "no-third-party: BLIND, cannot enter the directory this script is in ($0), so nothing was read" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "no-third-party: BLIND, node is not on PATH, so nothing was read" >&2
  exit 2
}
[ -r "$here/check.mjs" ] || {
  echo "no-third-party: BLIND, $here/check.mjs is missing or unreadable, so nothing was read" >&2
  exit 2
}

out=$(node "$here/check.mjs" "$@" 2>&1)
rc=$?
case "$rc:$out" in
  0:*"no-third-party: PASS, "*)
    printf '%s\n' "$out"
    exit 0
    ;;
  1:*"no-third-party: FAIL, "*)
    printf '%s\n' "$out" >&2
    exit 1
    ;;
  2:*"no-third-party: BLIND, "*)
    printf '%s\n' "$out" >&2
    exit 2
    ;;
esac
if [ -n "$out" ]; then
  printf '%s\n' "$out" >&2
fi
echo "no-third-party: BLIND, check.mjs exited $rc without saying PASS, FAIL or BLIND to match, so nothing is known" >&2
exit 2
