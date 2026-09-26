#!/usr/bin/env node
// Runs checks/privacy-matches-service.sh on generated fixtures that must pass, fail, warn
// and go blind, and checks each one's exit code and what it printed. Fixtures are built
// in a temp directory and never committed: the demo serves this whole checkout, so a
// committed fixture page would be a page on the site. No network: the manifest is a local
// file, and the unreachable case points at a port on this machine that was just freed.
//
//   node checks/privacy-selftest.mjs
//
// Exit 0 when every case behaved, 1 when any did not.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./privacy-matches-service.sh", import.meta.url));

const manifest = {
  about: "fixture",
  stored: [
    { id: "link-name", fields: ["links.name"], what: "A link's short name", kept: "Until the link is deleted" },
    { id: "daily-counts", fields: ["daily_counts.count"], what: "Counts per day", kept: "Forever, even after the link is deleted" },
  ],
  counted: "Previews count too.",
  logged: "No access log.",
};

const row = (id, what, kept) => `<tr data-stored="${id}"><td>${what}</td><td>${kept}</td></tr>`;
const ROWS = [row("link-name", "A link&#39;s short name", "Until the link\n  is deleted"), row("daily-counts", "Counts <em>per</em> day", "Forever, even after the link is deleted")];
const page = ({ rows = ROWS, counted = "Previews count too.", logged = "No access log." } = {}) =>
  `<!doctype html><html><body><p data-manifest="counted">${counted}</p><p data-manifest='logged'>${logged}</p><table><tbody>${rows.join("\n")}</tbody></table></body></html>`;

const work = mkdtempSync(join(tmpdir(), "privacy-selftest-"));
let failures = 0;

function run(name, { html, manifestText = JSON.stringify(manifest), env = {} }, expectCode, expectOut) {
  const dir = mkdtempSync(join(work, `${name}-`));
  if (html !== undefined) writeFileSync(join(dir, "privacy.html"), html);
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, manifestText);
  const r = spawnSync("/bin/sh", [SCRIPT, dir], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PRIVACY_MANIFEST_FILE: manifestPath, ...env },
  });
  const out = r.stdout + r.stderr;
  const ok = r.status === expectCode && expectOut.every((re) => re.test(out));
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: exit ${r.status} (want ${expectCode})`);
  if (!ok) console.log(out.replace(/^/gm, "     | "));
}

run("pass", { html: page() }, 0, [/^privacy-matches-service: PASS, 2 manifest entries and 2 statements compared/m]);
run("missing-row", { html: page({ rows: [ROWS[0]] }) }, 1, [/no row data-stored="daily-counts"/, /: FAIL, 1 difference/]);
run("kept-differs", { html: page({ rows: [ROWS[0], row("daily-counts", "Counts per day", "400 days")] }) }, 1, [/row "daily-counts" says it is kept "400 days"/, /: FAIL, 1 difference/]);
run("commented-out-row", { html: page({ rows: [ROWS[0], `<!-- ${ROWS[1]} -->`] }) }, 1, [/no row data-stored="daily-counts"/, /: FAIL/]);
run("statement-missing", { html: page({ logged: "" }).replace(" data-manifest='logged'", "") }, 1, [/no element data-manifest="logged"/, /: FAIL/]);
run("statement-differs", { html: page({ counted: "Previews do not count." }) }, 1, [/data-manifest="counted" says "Previews do not count\."/, /: FAIL/]);
run("extra-row-warns", { html: page({ rows: [...ROWS, row("page-only", "Something", "A while")] }) }, 0, [/WARN, privacy\.html has a row data-stored="page-only"/, /: PASS/]);
run("unkeyed-row-warns", { html: page({ rows: [...ROWS, "<tr><td>Your IP address</td><td>30 days</td></tr>"] }) }, 0, [/WARN, privacy\.html has 1 table row\(s\) with no data-stored/, /: PASS/]);
run("third-cell", { html: page({ rows: [ROWS[0], ROWS[1].replace("</tr>", "<td>We also keep your address</td></tr>")] }) }, 1, [/row "daily-counts" has 3 cells, not 2/, /: FAIL/]);
run("duplicate-statement", { html: page().replace("</body>", "<p data-manifest=\"logged\">We log every address.</p></body>") }, 1, [/2 elements data-manifest="logged", not 1/, /: FAIL/]);
run("table-in-template", { html: page().replace("<table>", "<template><table>").replace("</table>", "</table></template>") }, 1, [/no row data-stored="link-name"/, /: FAIL/]);
run("hidden-statement", { html: page().replace("<p data-manifest='logged'>", "<p data-manifest='logged' hidden>") }, 1, [/data-manifest="logged" is marked hidden/, /: FAIL/]);
run("hidden-table", { html: page().replace("<table>", "<table hidden>") }, 1, [/1 table element\(s\) marked hidden/, /: FAIL/]);
run("page-not-utf8", { html: Buffer.concat([Buffer.from(page()), Buffer.from([0xc3, 0x28])]) }, 2, [/: BLIND, .*privacy\.html is not UTF-8 text/]);
run("no-page", {}, 2, [/: BLIND, cannot read .*privacy\.html: ENOENT/]);
run("manifest-not-json", { html: page(), manifestText: "{ not json" }, 2, [/: BLIND, the manifest from .* is not JSON/]);
run("manifest-empty", { html: page(), manifestText: JSON.stringify({ ...manifest, stored: [] }) }, 2, [/: BLIND, the manifest from .* lists nothing stored/]);
run("manifest-unreadable", { html: page(), env: { PRIVACY_MANIFEST_FILE: join(work, "absent.json") } }, 2, [/: BLIND, cannot read the manifest .*absent\.json: ENOENT/]);
// A port that was listening a moment ago and no longer is: the connection is refused.
const closedPort = await new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
run(
  "manifest-unreachable",
  { html: page(), env: { PRIVACY_MANIFEST_FILE: "", PRIVACY_MANIFEST_URL: `http://127.0.0.1:${closedPort}/privacy-manifest.json` } },
  2,
  [/: BLIND, could not fetch http:\/\/127\.0\.0\.1:\d+\/privacy-manifest\.json: ECONNREFUSED/],
);
run("no-node", { html: page(), env: { PATH: "/nonexistent" } }, 2, [/: BLIND, node is not on PATH/]);

// An engine that crashes exits 1, as a FAIL does, having compared nothing; the wrapper
// must call that BLIND. Run a copy of the wrapper beside an engine that cannot parse.
{
  const checks = mkdtempSync(join(work, "crash-"));
  copyFileSync(SCRIPT, join(checks, "privacy-matches-service.sh"));
  writeFileSync(join(checks, "privacy.mjs"), "this is not javascript (\n");
  const dir = mkdtempSync(join(work, "crash-site-"));
  writeFileSync(join(dir, "privacy.html"), page());
  const r = spawnSync("/bin/sh", [join(checks, "privacy-matches-service.sh"), dir], { encoding: "utf8", env: { PATH: process.env.PATH } });
  const ok = r.status === 2 && /: BLIND, the check ended with exit 1 and without its verdict line/.test(r.stdout + r.stderr);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} engine-crash: exit ${r.status} (want 2)`);
  if (!ok) console.log((r.stdout + r.stderr).replace(/^/gm, "     | "));
}

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "privacy-selftest: PASS" : `privacy-selftest: FAIL, ${failures} case(s)`);
process.exitCode = failures === 0 ? 0 : 1;
