#!/bin/sh
# R-021: the landing page says what Linkling is. The entry point CI and people run; the
# check itself is checks/landing.mjs, whose header says what it looks for.
#
#   sh checks/landing.sh [site-root]      (default: the repo root)
#
# Exit 0 `landing: PASS, ...`; exit 1 `landing: FAIL, ...` after one line per missing
# statement, or when the root holds no index.html; exit 2 `landing: BLIND, ...` when nothing
# could be read. This script adds the two ways of not looking that a shell would otherwise
# report as "command not found" (127): node is not on PATH, or landing.mjs is not beside
# this script. Both are exit 2, never a pass. It runs no external command before that test,
# so an empty PATH reaches the node message instead of failing earlier.

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
exec node "$here/landing.mjs" "$@"
