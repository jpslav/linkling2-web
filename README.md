# linkling2-web

The Linkling public site: a landing page and the privacy page.

Built by the second rehearsal of [auto-program](https://github.com/jpslav/auto-program). Its program repo is private.

## Checks

Plain HTML and CSS, no build step and no package manager. CI (`ci-required`) runs the five commands below on every pull request, every push to `main` and once a day. The first three are described here: they need only Node (CI uses 24) and a POSIX shell, and each exits 0 on pass, 1 on fail and 2 when it could not look. The last two are under "The privacy page"; the check there reads linkling-api's manifest over the network.

- `sh checks/no-third-party.sh [site-root]` is R-023: no page loads anything from another origin, and none holds a `<script>` element or an `on...=` attribute. An outbound `<a href>` link is allowed; an absolute URL that a page would load or send data to (`src`, `srcset`, a stylesheet's `url()` or `@import`, a form's `action`, and the rest of the list in the engine's header) fails. Its engine is `checks/check.mjs`, whose header lists exactly what it covers and what it does not.
- `sh checks/landing.sh [site-root]` is R-021: `index.html` names Linkling, says it is a link shortener and says clicks are not tracked.
- `node checks/selftest.mjs` runs both on generated fixtures that must pass, fail and go blind, and checks what they print as well as the exit code. Fixtures are built in a temp directory, never committed: the demo serves this whole checkout, so a committed page with an off-origin load would be a page on the site.

Each prints `<name>: PASS`, `<name>: FAIL` or `<name>: BLIND` and then the reason.

## The privacy page

`privacy.html` copies, word for word, what [linkling-api's `privacy-manifest.json`](https://github.com/jpslav/linkling2-api/blob/main/privacy-manifest.json) says the service stores and for how long (linkling-api ADR-0004 and ADR-0011). To change what the page says about stored data, change the manifest; to change the page and the service together, use one branch name in both repos and merge the linkling-api pull request first.

- `sh checks/privacy-matches-service.sh [site-root]` is R-022. It exits 0 when the page carries every manifest entry and both statements, 1 when it does not, and 2 (BLIND) when it could not read the manifest or the page. Its engine is `checks/privacy.mjs`, whose header says where the manifest is read from.
- `node checks/privacy-selftest.mjs` runs that check on generated fixtures that must pass, fail, warn and go blind.
