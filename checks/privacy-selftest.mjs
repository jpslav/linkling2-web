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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "privacy-selftest: PASS" : `privacy-selftest: FAIL, ${failures} case(s)`);
process.exitCode = failures === 0 ? 0 : 1;
