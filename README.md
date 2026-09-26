# linkling2-web

The Linkling public site: a landing page and the privacy page.

Built by the second rehearsal of [auto-program](https://github.com/jpslav/auto-program). Its program repo is private.

## The privacy page

`privacy.html` copies, word for word, what [linkling-api's `privacy-manifest.json`](https://github.com/jpslav/linkling2-api/blob/main/privacy-manifest.json) says the service stores and for how long (linkling-api ADR-0004 and ADR-0011). To change what the page says about stored data, change the manifest; to change the page and the service together, use one branch name in both repos and merge the linkling-api pull request first.

- `sh checks/privacy-matches-service.sh [site-root]` is R-022. It exits 0 when the page carries every manifest entry and both statements, 1 when it does not, and 2 (BLIND) when it could not read the manifest or the page. Its engine is `checks/privacy.mjs`, whose header says where the manifest is read from.
- `node checks/privacy-selftest.mjs` runs that check on generated fixtures that must pass, fail, warn and go blind.

CI runs both on every pull request, every push to `main` and once a day.
