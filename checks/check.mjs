#!/usr/bin/env node
// The seed of the public site's CI check. Dependency-free on purpose: the site has
// no build step and no package manager (ADR-0007). The full check is LL-006's.
//
//   node checks/check.mjs [site-root]      (default: the repo root)
//
// Exit 1 (something is wrong) when
//   - an .html file is not well-formed enough to parse: an unterminated comment, tag,
//     <script>, <style>, <textarea> or <title>; a start tag that does not fit the tag
//     grammar; a stray end tag; or an element left open (elements whose end tag HTML
//     lets you omit, such as p, li and td, are excepted). One problem per file, the
//     first, since everything after it is parsed from an unreliable state;
//   - an .html or .css file has an src= or href= attribute, or a url(...), whose value
//     is an absolute http(s) URL or a protocol-relative one (//host). The site's own
//     origin is not known yet, so every absolute URL counts as another origin
//     (ADR-0008: nothing is loaded from anywhere else);
//   - a symlink sits in the tree: it would be skipped, and skipped means unchecked.
// Exit 2 (could not look) when the root or a file cannot be read, or there is no
// index.html at the root: zero pages checked is "never looked", not "all fine".
//
// Not covered here: srcset, action, formaction, poster, <meta http-equiv=refresh>,
// @import "url" strings, entity-encoded URLs (h&#116;tps://), scripts and inline event
// handlers, .htm files, and everything about the privacy page's content.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "checks"]);
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
  "source", "track", "wbr",
]);
const OPTIONAL_END = new Set([
  "html", "head", "body", "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody",
  "tfoot", "option", "optgroup", "colgroup", "caption", "rt", "rp",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const START_TAG =
  /<([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9-]*)\s*>/y;

class Blind extends Error {}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function collect(root) {
  const files = [];
  const problems = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Blind(`cannot read directory ${dir}: ${e.message}`);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(`${relative(root, path)}: symlink, not followed and so not checked`);
      } else if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && /\.(html|css)$/i.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return { files, problems };
}

function offOrigin(text) {
  const found = [];
  const patterns = [
    /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]*))\s*\)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      // Browsers drop tabs and newlines inside a URL, strip leading and trailing
      // whitespace, and read a backslash as a slash in http(s) URLs.
      const value = (m[1] ?? m[2] ?? m[3] ?? "").replace(/[\t\n\r]/g, "").trim().replace(/\\/g, "/");
      if (/^(?:https?:)?\/\//i.test(value)) {
        found.push(`${lineOf(text, m.index)}: URL on another origin: ${value}`);
      }
    }
  }
  return found;
}

// Returns a "line: message" string for the first problem, or null.
function parseProblem(text) {
  const stack = [];
  const at = (index, msg) => `${lineOf(text, index)}: ${msg}`;
  let i = 0;
  while ((i = text.indexOf("<", i)) !== -1) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) return at(i, "unterminated comment");
      i = end + 3;
    } else if (text.startsWith("<!", i) || text.startsWith("<?", i)) {
      const end = text.indexOf(">", i);
      if (end === -1) return at(i, "unterminated declaration");
      i = end + 1;
    } else if (text.startsWith("</", i)) {
      END_TAG.lastIndex = i;
      const m = END_TAG.exec(text);
      if (!m) return at(i, "malformed end tag");
      const name = m[1].toLowerCase();
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k--;
      if (k < 0) return at(i, `stray </${name}>`);
      for (let j = stack.length - 1; j > k; j--) {
        if (!OPTIONAL_END.has(stack[j].name)) {
          return at(stack[j].index, `<${stack[j].name}> is not closed before </${name}> on line ${lineOf(text, i)}`);
        }
      }
      stack.length = k;
      i += m[0].length;
    } else if (/[A-Za-z]/.test(text[i + 1] ?? "")) {
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(text);
      if (!m) return at(i, "malformed start tag");
      const name = m[1].toLowerCase();
      i += m[0].length;
      if (VOID.has(name)) continue;
      stack.push({ name, index: i - m[0].length });
      if (RAW_TEXT.has(name)) {
        const close = new RegExp(`</${name}[\\s/>]`, "gi");
        close.lastIndex = i;
        const c = close.exec(text);
        if (!c) return at(stack.at(-1).index, `unterminated <${name}>`);
        i = c.index;
      }
    } else {
      i += 1; // a "<" that starts no tag is text
    }
  }
  for (let j = stack.length - 1; j >= 0; j--) {
    if (!OPTIONAL_END.has(stack[j].name)) return at(stack[j].index, `<${stack[j].name}> is never closed`);
  }
  return null;
}

function run(root) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch (e) {
    throw new Blind(`cannot read site root ${root}: ${e.message}`);
  }
  if (!stat.isDirectory()) throw new Blind(`site root ${root} is not a directory`);

  const { files, problems } = collect(root);
  if (!files.some((f) => relative(root, f) === "index.html")) {
    throw new Blind(`no index.html at ${root}: nothing to check`);
  }
  let html = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw new Blind(`cannot read ${relative(root, file)}: ${e.message}`);
    }
    const name = relative(root, file);
    for (const p of offOrigin(text)) problems.push(`${name}:${p}`);
    if (/\.html$/i.test(file)) {
      html += 1;
      const p = parseProblem(text);
      if (p) problems.push(`${name}:${p}`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`check: FAIL, ${problems.length} problem(s) in ${files.length} file(s) under ${root}`);
    return 1;
  }
  console.log(`check: OK, ${html} html and ${files.length - html} css file(s) checked under ${root}`);
  return 0;
}

try {
  process.exitCode = run(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
} catch (e) {
  console.error(`check: could not look, ${e instanceof Blind ? e.message : e.stack}`);
  process.exitCode = 2;
}
