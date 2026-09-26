#!/usr/bin/env node
// The engine of the public site's CI check for R-023: the site loads nothing from any
// other origin. Dependency-free on purpose: the site has no build step and no package
// manager (linkling-api docs/adr/0007-repo-layout.md). Run it through its entry point,
// `checks/no-third-party.sh`, the name linkling-api docs/adr/0008-third-party-services.md
// gives: the script turns "node or this file is missing" into exit 2 instead of a shell
// error. `node checks/check.mjs [site-root]` is the same check without that guard.
//
//   sh checks/no-third-party.sh [site-root]      (default: the repo root)
//
// It is a tripwire for accidents (a pasted font @import, an analytics snippet, a
// mailing-list form), not a defence against an author trying to hide a load.
//
// Exit 0, and `no-third-party: PASS, N html and M css file(s) read under ROOT`, when
// nothing below is wrong.
//
// Exit 1, one `file:line: problem` line each and then `no-third-party: FAIL, ...`, when
//   - the text of an .html or .css file holds one of the attributes src, srcset,
//     imagesrcset, poster, data, action, formaction, ping or href, followed by a value
//     that starts with http: or https: (with or without the //) or is protocol-relative
//     (//host). For srcset, imagesrcset and ping every whitespace or comma separated
//     item counts. The site's own origin is not known yet, so every absolute URL counts as
//     another origin (ADR-0008: the site loads nothing from any other origin);
//   - that attribute is href and it is not an attribute of an <a> start tag. Outbound
//     <a href> links are allowed (products/linkling/DECISIONS.md, 2026-09-26, "May the
//     public site link out to other sites?"): a link loads nothing and tells nobody
//     anything until someone follows it. The href of a <link>, <base>, <area>, <use> or
//     <image> is a load or changes where other URLs point, so it counts;
//   - a url(...) or an @import "..." string in CSS (in a .css file, a <style> element or
//     a style attribute) has a value of that shape, or the target of a
//     <meta http-equiv="refresh"> has;
//   - an .html file is not well-formed enough to parse: an unterminated comment, tag,
//     <script>, <style>, <textarea> or <title>; a start tag that does not fit the tag
//     grammar; a stray end tag; or an element left open (elements whose end tag HTML
//     lets you omit, such as p, li and td, are excepted). One parse problem per file,
//     the first, since everything after it is parsed from an unreliable state. The parse
//     walk is also what finds the <a> tags above, so an href after a parse problem is not
//     recognised as an <a> href and counts;
//   - a symlink sits in the tree: it would be skipped, and skipped means unchecked.
// The scan reads raw text, so a match in a comment, a script or prose counts, and so does
// a canonical link. The one exemption is an href inside an <a> start tag that the parse
// walk saw at its real position in the document.
//
// Exit 2 (`no-third-party: BLIND, ...`: could not look) when the root or a file cannot be
// read, a file is not UTF-8 text (NUL bytes, or a UTF-16 byte order mark), or there is no
// index.html at the root: zero pages checked is "never looked", not "all fine".
//
// Every directory is walked except .git, .github, .claude and node_modules. checks/ is
// walked on purpose: the demo serves the whole checkout (ADR-0006), so a page committed
// there is a page on the site. That is why the self-test builds its fixtures in a temp
// directory and commits none. A page under a skipped directory would be served and not
// read.
//
// Not covered here: image-set("url") and the other CSS functions that take a string
// (cross-fade(), image(), src()); the obsolete URL attributes background, manifest,
// codebase, archive and classid; entity-encoded URLs (h&#116;tps://); scripts, inline
// event handlers and javascript: URLs (a script can reach any origin and nothing here
// can see that; PRODUCT.md's Tech says the site has none); .htm files; and everything
// about the privacy page's content. Two parse gaps: an HTML element that breaks out of
// svg or math (<svg><div/></svg>) is treated as if it stayed inside, and the legacy
// <script><!-- <script> ... </script> --> </script> form is reported as a stray end
// tag.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", ".github", ".claude", "node_modules"]);
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
  "source", "track", "wbr",
]);
const OPTIONAL_END = new Set([
  "html", "head", "body", "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody",
  "tfoot", "option", "optgroup", "colgroup", "caption", "rt", "rp",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
// HTML's whitespace is these five characters. JavaScript's \s also takes NBSP, VT and more,
// which a browser reads as part of a name or a value, so it would end a tag somewhere else.
const WS = "[ \\t\\n\\f\\r]";
const NOT_WS = " \\t\\n\\f\\r";
const START_TAG = new RegExp(
  `<([A-Za-z][A-Za-z0-9-]*)((?:${WS}+[^${NOT_WS}"'<>/=]+(?:${WS}*=${WS}*(?:"[^"]*"|'[^']*'|[^${NOT_WS}"'=<>\`]+))?)*)${WS}*(/?)>`,
  "y",
);
const END_TAG = new RegExp(`</([A-Za-z][A-Za-z0-9-]*)${WS}*>`, "y");

class Blind extends Error {}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const isForeign = (name) => name === "svg" || name === "math";

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
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && /\.(html|css)$/i.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return { files, problems };
}

const isBlank = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
// Only the start of a URL decides whether it is on another origin, so a value is read
// no further than this many characters that a browser would keep. Characters it drops
// (leading control characters and spaces, tabs and newlines), whether written plainly
// or as an escape, are not counted. The cap also keeps a run of "url(url(url(..." from
// going quadratic.
const MAX_URL_READ = 256;

// The CSS tokenizer compares the function name to "url" after decoding its escapes
// (CSS Syntax 3, 4.3.4 "Consume an ident-like token"), so u\72l( and \55RL( are url( too:
// each letter may be itself, a backslash and itself, or a hex escape.
const cssLetter = (c) => {
  const hex = [c, c.toUpperCase()].map((x) => x.charCodeAt(0).toString(16)).join("|");
  return `(?:${c}|\\\\${c}|\\\\0{0,4}(?:${hex})(?:\\r\\n|[ \\t\\n\\r\\f])?)`;
};
const URL_OPEN = new RegExp([..."url"].map(cssLetter).join("") + "\\(", "gi");

// The value of a url(...) whose contents start at `i`, read following the CSS tokenizer
// on escapes, quotes, line continuations and end of file: a backslash escape is up to
// six hex digits plus one optional whitespace, or any one character, and a backslash
// before a newline (CR, LF, CRLF or FF) inside quotes is a line continuation that keeps
// nothing. A quoted value ends at its closing quote,
// at a raw newline or at the end of the file; an unquoted one at ")" or whitespace, or
// at a backslash-newline, which makes the url unusable. What was read before a break
// still counts: a reader that gave up there would pass what it never looked at.
function readCssUrl(text, i) {
  while (isBlank(text[i])) i += 1;
  const quote = text[i] === '"' || text[i] === "'" ? text[i++] : "";
  let out = "";
  const keep = (ch) => {
    if (ch === "\t" || ch === "\n" || ch === "\r" || (out === "" && ch <= " ")) return;
    out += ch;
  };
  while (i < text.length && out.length < MAX_URL_READ) {
    const c = text[i];
    if (c === "\\") {
      const hex = /^([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?/.exec(text.slice(i + 1, i + 9));
      const next = text[i + 1];
      if (hex) {
        keep(String.fromCodePoint(Math.min(parseInt(hex[1], 16), 0x10ffff)));
        i += 1 + hex[0].length;
      } else if (next === "\n" || next === "\r" || next === "\f") {
        if (!quote) break;
        i += next === "\r" && text[i + 2] === "\n" ? 3 : 2;
      } else {
        if (next !== undefined) keep(next);
        i += 2;
      }
    } else if (quote ? c === quote || c === "\n" : c === ")" || isBlank(c)) {
      break;
    } else {
      keep(c);
      i += 1;
    }
  }
  return out;
}

// The attributes whose value the browser loads or submits to, and href, which is a load
// everywhere except on <a>. Two readers use the same names:
//  - Inside a start tag the walk saw, offOrigin reads the tag's attributes one by one from the
//    tag grammar (ATTR), so a value is opaque: an allowed link may carry ?src=https://... in
//    its query, and an alt="x src=" cannot make the next real attribute look like a value.
//  - Everywhere else (prose, a comment, a script, a stylesheet, whatever follows a parse
//    problem) URL_ATTR scans the raw text. A name that follows a word character or "-"
//    (data-src) is a different attribute, and xlink:href still matches. The value is read in
//    a lookahead, so a match ends at the "=" and a quote that never closes (prose such as
//    data=') cannot swallow the tags after it.
const URL_NAMES = "src|srcset|imagesrcset|poster|data|action|formaction|ping|attributionsrc|href";
const URL_ATTR = new RegExp(`(?<![\\w-])(${URL_NAMES})\\s*=\\s*(?=(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+)))`, "gi");
// One attribute of a start tag START_TAG has matched: a name, and maybe a value.
const ATTR = new RegExp(`([^${NOT_WS}"'<>/=]+)(?:${WS}*=${WS}*(?:"([^"]*)"|'([^']*)'|([^${NOT_WS}"'=<>\`]+)))?`, "g");
// An attribute name that is one of URL_NAMES, with or without a namespace (xlink:href).
const URL_NAME = new RegExp(`(?:^|:)(${URL_NAMES})$`);
// These hold several URLs, separated by whitespace and commas.
const URL_LIST = new Set(["srcset", "imagesrcset", "ping", "attributionsrc"]);
// @import, spelled the way the CSS tokenizer reads a keyword: escapes decoded, any case.
const IMPORT_OPEN = new RegExp("@" + [..."import"].map(cssLetter).join(""), "gi");

// The span of the sorted list of disjoint [start, end) spans that contains index, or undefined.
function spanAt(spans, index) {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index < spans[mid][0]) hi = mid - 1;
    else if (index >= spans[mid][1]) lo = mid + 1;
    else return spans[mid];
  }
  return undefined;
}

// A browser decodes &quot; and &#39; in an attribute value, so a style attribute can carry
// url(&quot;https://...&quot;). Only the character reference at the front of a URL is undone:
// full decoding of attribute values is not attempted.
const QUOTE_ENTITY = /^(?:&(?:quot|apos);?|&#0*(?:34|39);?|&#x0*(?:22|27);?)/i;

// Where a <meta http-equiv="refresh"> content value sends the browser: what follows the
// delay, its separator, an optional url= and an optional quote. Null when it has no URL.
function refreshTarget(content) {
  return /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?["']?\s*(.*)$/is.exec(content)?.[1] || null;
}

// `tags` are the start tags parseHtml saw at their real place in the document, each
// [start, end, name, attribute text, where the attribute text starts]; a .css file has none.
function offOrigin(text, tags = []) {
  const found = [];
  const add = (index, raw, note = "") => {
    // Browsers strip leading C0 controls and spaces, drop tabs and newlines inside a URL,
    // and read a backslash as a slash in http(s) URLs.
    const value = raw.replace(QUOTE_ENTITY, "").replace(/^[\u0000- ]+/, "").replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
    if (/^(?:https?:|\/\/)/i.test(value)) {
      found.push(`${lineOf(text, index)}: URL on another origin: ${value.slice(0, 200)}${note}`);
    }
  };
  // One attribute: `name` is one of URL_NAMES; an href is allowed off the site on an <a> only.
  const check = (name, value, index, onAnchor) => {
    if (name === "href") {
      if (!onAnchor) add(index, value, " (an href may leave the site only on an <a>)");
    } else if (URL_LIST.has(name)) {
      for (const item of value.split(/[\s,]+/)) add(index, item);
    } else {
      add(index, value);
    }
  };

  // Outside every start tag the walk saw: the raw text.
  const raw = new RegExp(URL_ATTR.source, URL_ATTR.flags);
  for (let m = raw.exec(text); m !== null; m = raw.exec(text)) {
    if (!spanAt(tags, m.index)) check(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4], m.index, false);
  }
  // Inside them: the attributes of the tag.
  for (const [, , name, attrs, attrsAt] of tags) {
    let refresh = false;
    const contents = [];
    for (const a of attrs.matchAll(ATTR)) {
      const value = a[2] ?? a[3] ?? a[4];
      if (value === undefined) continue;
      const attrName = a[1].toLowerCase();
      const url = URL_NAME.exec(attrName)?.[1];
      if (url) check(url, value, attrsAt + a.index, name === "a");
      if (name === "meta" && attrName === "http-equiv" && value.trim().toLowerCase() === "refresh") refresh = true;
      if (name === "meta" && attrName === "content") contents.push([attrsAt + a.index, value]);
    }
    // <meta http-equiv="refresh" content="5; url=..."> sends the browser there by itself.
    if (refresh) {
      for (const [index, content] of contents) {
        const target = refreshTarget(content);
        if (target) add(index, target);
      }
    }
  }
  for (const m of text.matchAll(URL_OPEN)) add(m.index, readCssUrl(text, m.index + m[0].length));
  for (const m of text.matchAll(IMPORT_OPEN)) add(m.index, readCssUrl(text, m.index + m[0].length));
  return found;
}

// Walks the document once: `problem` is a "line: message" string for the first parse
// problem, or null; `tags` is what offOrigin needs. A tag inside a comment or a script is
// not at a real place in the document, so it is not in it.
function parseHtml(text) {
  const out = { problem: null, tags: [] };
  out.problem = walk(text, out);
  return out;
}

function walk(text, out) {
  const stack = [];
  let foreign = 0; // how many svg and math elements are open on the stack
  const at = (index, msg) => `${lineOf(text, index)}: ${msg}`;
  let i = 0;
  while ((i = text.indexOf("<", i)) !== -1) {
    if (text.startsWith("<!--", i)) {
      // A comment ends at --> or --!>, and <!--> and <!---> are already complete.
      if (text.startsWith(">", i + 4)) {
        i += 5;
      } else if (text.startsWith("->", i + 4)) {
        i += 6;
      } else {
        const end = /--!?>/g;
        end.lastIndex = i + 4;
        const c = end.exec(text);
        if (!c) return at(i, "unterminated comment");
        i = c.index + c[0].length;
      }
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
      for (let j = k; j < stack.length; j++) if (isForeign(stack[j].name)) foreign -= 1;
      stack.length = k;
      i += m[0].length;
    } else if (/[A-Za-z]/.test(text[i + 1] ?? "")) {
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(text);
      if (!m) return at(i, "malformed start tag");
      const name = m[1].toLowerCase();
      const start = i;
      i += m[0].length;
      out.tags.push([start, i, name, m[2], start + 1 + m[1].length]);
      // Inside inline SVG and MathML, "/>" closes an element (<path/>); in HTML it is ignored.
      if (VOID.has(name) || (m[3] === "/" && (isForeign(name) || foreign > 0))) continue;
      stack.push({ name, index: start });
      if (isForeign(name)) foreign += 1;
      if (RAW_TEXT.has(name)) {
        const close = new RegExp(`</${name}[ \\t\\n\\f\\r/>]`, "gi");
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
    const name = relative(root, file);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (e) {
      throw new Blind(`cannot read ${name}: ${e.message}`);
    }
    const bom = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
    if (bom || bytes.includes(0)) {
      throw new Blind(`${name} is not UTF-8 text (NUL bytes or a UTF-16 byte order mark), so it cannot be read`);
    }
    const text = bytes.toString("utf8");
    const isHtml = /\.html$/i.test(file);
    const parsed = isHtml ? parseHtml(text) : undefined;
    for (const p of offOrigin(text, parsed?.tags)) problems.push(`${name}:${p}`);
    if (isHtml) {
      html += 1;
      if (parsed.problem) problems.push(`${name}:${parsed.problem}`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`no-third-party: FAIL, ${problems.length} problem(s) in ${files.length} file(s) under ${root}`);
    return 1;
  }
  console.log(`no-third-party: PASS, ${html} html and ${files.length - html} css file(s) read under ${root}`);
  return 0;
}

try {
  process.exitCode = run(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
} catch (e) {
  console.error(`no-third-party: BLIND, ${e instanceof Blind ? e.message : e.stack}`);
  process.exitCode = 2;
}
