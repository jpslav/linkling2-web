#!/bin/sh
# R-022: the privacy page lists exactly what the Linkling service stores. The entry point
# CI and people run; the check itself is checks/privacy.mjs, whose header says what it
# compares and where it reads linkling-api's privacy-manifest.json from.
#
#   sh checks/privacy-matches-service.sh [site-root]      (default: the repo root)
#
# Exit 0 `privacy-matches-service: PASS, ...`; exit 1 `privacy-matches-service: FAIL, ...`
# after one line per difference; exit 2 `privacy-matches-service: BLIND, ...` when the
# manifest or the page could not be read. This script adds the two ways of not looking
# that a shell would otherwise report as "command not found" (127): node is not on PATH,
# or privacy.mjs is not beside this script. Both are exit 2, never a pass.

case $0 in
  */*) here=${0%/*} ;;
  *) here=. ;;
esac
here=$(cd "$here" && pwd) || {
  echo "privacy-matches-service: BLIND, cannot enter the directory this script is in ($0), so nothing was read" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "privacy-matches-service: BLIND, node is not on PATH, so nothing was read" >&2
  exit 2
}
[ -r "$here/privacy.mjs" ] || {
  echo "privacy-matches-service: BLIND, $here/privacy.mjs is missing or unreadable, so nothing was read" >&2
  exit 2
}
exec node "$here/privacy.mjs" "$@"
