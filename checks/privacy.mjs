#!/usr/bin/env node
// The engine of the check for R-022: the privacy page lists exactly what the Linkling
// service stores and for how long. Run it through its entry point,
// `checks/privacy-matches-service.sh`, which turns "node or this file is missing" into
// exit 2 instead of a shell error.
//
//   sh checks/privacy-matches-service.sh [site-root]      (default: the repo root)
//
// It reads the service's privacy-manifest.json (linkling-api ADR-0004 and ADR-0011) and
// this site's privacy.html. For each manifest entry in `stored`, the page must have
// exactly one <tr data-stored="<id>">, with exactly two cells, the entry's `what` and
// `kept`; and exactly one element each marked data-manifest="counted" and
// data-manifest="logged", holding the manifest's `counted` and `logged` sentences. None
// of those, and no table, thead, tbody or tfoot, may carry the `hidden` attribute.
// Comments and template, script, style and noscript elements are removed before anything
// is read, so a row inside one does not count; tags are dropped, character references
// decoded and whitespace collapsed before text is compared. It is a tripwire on the
// page's wording, not a full HTML parser, and not a defence against CSS that hides text:
// the page is ours and plain.
//
// Where the manifest comes from, first match wins:
//   PRIVACY_MANIFEST_FILE=<path>   read that file (the self-test, local runs);
//   PRIVACY_MANIFEST_URL=<url>     fetch that URL, no fallback;
//   PRIVACY_MANIFEST_BRANCH=<name> fetch linkling-api's branch of that name, and on a 404
//                                  only, fall back to main (CI passes a pull request's
//                                  head branch here: ADR-0011);
//   otherwise                      fetch linkling-api's main.
//
// Exit 0, `privacy-matches-service: PASS, N manifest entries and 2 statements compared
// ...`, when the page carries all of it. A page row whose id the manifest lacks, or a
// body row (one with a <td>) with no data-stored at all, prints a WARN line first and
// does not fail (ADR-0004: the page may change first).
// Exit 1, one line per difference then `privacy-matches-service: FAIL, ...`, when the
// manifest holds something the page does not say, or says differently.
// Exit 2, `privacy-matches-service: BLIND, ...`, when the manifest cannot be fetched or
// read, is not JSON of the shape above, or lists nothing; or privacy.html is missing,
// unreadable or not valid UTF-8. Never a pass: not looking is not the same as all fine.
// The wrapper also turns an engine that ends without its verdict line (a crash) into
// exit 2.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "privacy-matches-service";
const RAW = "https://raw.githubusercontent.com/jpslav/linkling2-api";
const FETCH_TIMEOUT_MS = 20_000;

class Blind extends Error {}

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  } catch (e) {
    throw new Blind(`could not fetch ${url}: ${e.cause?.code ?? e.cause?.message ?? e.message}`);
  }
  return { status: res.status, text: res.status === 200 ? await res.text() : "" };
}

// Returns [manifest text, where it came from].
async function loadManifest(env) {
  if (env.PRIVACY_MANIFEST_FILE) {
    try {
      return [readFileSync(env.PRIVACY_MANIFEST_FILE, "utf8"), env.PRIVACY_MANIFEST_FILE];
    } catch (e) {
      throw new Blind(`cannot read the manifest ${env.PRIVACY_MANIFEST_FILE}: ${e.code ?? e.message}`);
    }
  }
  const tries = [];
  if (env.PRIVACY_MANIFEST_URL) tries.push(env.PRIVACY_MANIFEST_URL);
  else {
    const branch = env.PRIVACY_MANIFEST_BRANCH;
    // Each path segment encoded, so a # or ? in a branch name stays part of the name.
    if (branch && branch !== "main") tries.push(`${RAW}/${branch.split("/").map(encodeURIComponent).join("/")}/privacy-manifest.json`);
    tries.push(`${RAW}/main/privacy-manifest.json`);
  }
  for (const [i, url] of tries.entries()) {
    const { status, text } = await fetchText(url);
    if (status === 200) return [text, url];
    const last = i === tries.length - 1;
    // Only "that branch has no manifest" falls through to main; anything else is blind.
    if (status !== 404 || last) throw new Blind(`fetching ${url} answered HTTP ${status}`);
    console.log(`${NAME}: ${url} answered 404, so reading ${tries[i + 1]} instead`);
  }
  throw new Blind("no manifest location to read");
}

function parseManifest(text, where) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new Blind(`the manifest from ${where} is not JSON: ${e.message}`);
  }
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  if (!m || !Array.isArray(m.stored) || !str(m.counted) || !str(m.logged)) {
    throw new Blind(`the manifest from ${where} lacks stored, counted or logged`);
  }
  if (m.stored.length === 0) throw new Blind(`the manifest from ${where} lists nothing stored`);
  for (const e of m.stored) {
    if (!e || !str(e.id) || !str(e.what) || !str(e.kept)) {
      throw new Blind(`the manifest from ${where} has an entry without id, what or kept: ${JSON.stringify(e)}`);
    }
  }
  return m;
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Visible text of an HTML fragment: tags dropped, references decoded, spaces collapsed.
function text(fragment) {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return NAMED[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// A boolean `hidden` attribute in a start tag's attribute text.
const isHidden = (attrs) => /(?:^|\s)hidden(?=[\s=\/]|$)/i.test(attrs);

// Rows keyed by data-stored, each { cells, hidden }; statements keyed by data-manifest,
// each { text, hidden }; `unkeyed` counts body rows (rows with a <td>) that carry no
// data-stored; `hiddenTables` counts <table>, <thead>, <tbody> and <tfoot> tags marked
// hidden. Comments, and elements whose content a visitor never reads as the page
// (template, script, style, noscript), are removed first.
function readPage(html) {
  const body = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(template|script|style|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const rows = new Map();
  let unkeyed = 0;
  for (const m of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)(?=<tr\b|<\/tr\s*>|<\/tbody|<\/table|$)/gi)) {
    const id = attr(m[1], "data-stored");
    if (id === null) {
      if (/<td\b/i.test(m[2])) unkeyed += 1;
      continue;
    }
    const cells = [...m[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/t[dh]\s*>|$)/gi)].map((c) => text(c[1]));
    if (!rows.has(id)) rows.set(id, []);
    rows.get(id).push({ cells, hidden: isHidden(m[1]) });
  }
  const hiddenTables = [...body.matchAll(/<(?:table|thead|tbody|tfoot)\b([^>]*)>/gi)].filter((m) => isHidden(m[1])).length;
  const statements = new Map();
  for (const m of body.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const key = attr(m[2], "data-manifest");
    if (key === null) continue;
    const close = new RegExp(`</${m[1]}\\s*>`, "i");
    const rest = body.slice(m.index + m[0].length);
    const end = rest.search(close);
    if (!statements.has(key)) statements.set(key, []);
    statements.get(key).push({ text: text(end === -1 ? rest : rest.slice(0, end)), hidden: isHidden(m[2]) });
  }
  return { rows, statements, unkeyed, hiddenTables };
}

async function run(root, env) {
  const [manifestText, where] = await loadManifest(env);
  const manifest = parseManifest(manifestText, where);
  const pagePath = join(root, "privacy.html");
  let bytes;
  try {
    bytes = readFileSync(pagePath);
  } catch (e) {
    throw new Blind(`cannot read ${pagePath}: ${e.code ?? e.message}`);
  }
  let html;
  try {
    if (bytes.includes(0) || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) throw new Error();
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Blind(`${pagePath} is not UTF-8 text (invalid UTF-8, NUL bytes or a UTF-16 byte order mark)`);
  }
  const { rows, statements, unkeyed, hiddenTables } = readPage(html);

  const problems = [];
  if (hiddenTables > 0) problems.push(`privacy.html: ${hiddenTables} table element(s) marked hidden, so a visitor would not read them`);
  for (const e of manifest.stored) {
    const found = rows.get(e.id);
    if (!found) {
      problems.push(`privacy.html: no row data-stored="${e.id}" for "${norm(e.what)}"`);
      continue;
    }
    if (found.length > 1) problems.push(`privacy.html: ${found.length} rows data-stored="${e.id}"`);
    const { cells, hidden } = found[0];
    const [what = "", kept = ""] = cells;
    if (hidden) problems.push(`privacy.html: row "${e.id}" is marked hidden`);
    if (cells.length !== 2) problems.push(`privacy.html: row "${e.id}" has ${cells.length} cells, not 2 (what is stored, how long)`);
    if (what !== norm(e.what)) problems.push(`privacy.html: row "${e.id}" says what is stored as "${what}", the manifest says "${norm(e.what)}"`);
    if (kept !== norm(e.kept)) problems.push(`privacy.html: row "${e.id}" says it is kept "${kept}", the manifest says "${norm(e.kept)}"`);
  }
  for (const key of ["counted", "logged"]) {
    const found = statements.get(key) ?? [];
    if (found.length === 0) {
      problems.push(`privacy.html: no element data-manifest="${key}"`);
      continue;
    }
    if (found.length > 1) problems.push(`privacy.html: ${found.length} elements data-manifest="${key}", not 1`);
    if (found[0].hidden) problems.push(`privacy.html: data-manifest="${key}" is marked hidden`);
    if (found[0].text !== norm(manifest[key])) {
      problems.push(`privacy.html: data-manifest="${key}" says "${found[0].text}", the manifest says "${norm(manifest[key])}"`);
    }
  }
  const ids = new Set(manifest.stored.map((e) => e.id));
  for (const id of rows.keys()) {
    if (!ids.has(id)) console.log(`${NAME}: WARN, privacy.html has a row data-stored="${id}" the manifest does not list`);
  }
  if (unkeyed > 0) {
    console.log(`${NAME}: WARN, privacy.html has ${unkeyed} table row(s) with no data-stored, which the manifest cannot account for`);
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`${NAME}: FAIL, ${problems.length} difference(s) between ${pagePath} and the manifest from ${where}`);
    return 1;
  }
  console.log(`${NAME}: PASS, ${manifest.stored.length} manifest entries and 2 statements compared between ${pagePath} and the manifest from ${where}`);
  return 0;
}

try {
  process.exitCode = await run(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)), process.env);
} catch (e) {
  console.error(`${NAME}: BLIND, ${e instanceof Blind ? e.message : e.stack}`);
  process.exitCode = 2;
}
