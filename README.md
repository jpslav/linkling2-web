# linkling2-web

The Linkling public site: a landing page and the privacy page.

Built by the second rehearsal of [auto-program](https://github.com/jpslav/auto-program). Its program repo is private.

## Checks

Plain HTML and CSS, no build step and no package manager. CI (`ci-required`) runs three commands, all of which need only Node (CI uses 24) and a POSIX shell, and each of which exits 0 on pass, 1 on fail and 2 when it could not look:

- `sh checks/no-third-party.sh [site-root]` is R-023: no page loads anything from another origin. An outbound `<a href>` link is allowed; every other absolute URL, in a page or a stylesheet, fails. Its engine is `checks/check.mjs`, whose header lists exactly what it covers and what it does not.
- `sh checks/landing.sh [site-root]` is R-021: `index.html` names Linkling, says it is a link shortener and says clicks are not tracked.
- `node checks/selftest.mjs` runs both on generated fixtures that must pass, fail and go blind, and checks what they print as well as the exit code. Fixtures are built in a temp directory, never committed: the demo serves this whole checkout, so a committed page with an off-origin load would be a page on the site.

Each prints `<name>: PASS`, `<name>: FAIL` or `<name>: BLIND` and then the reason.
