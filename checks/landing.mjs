#!/usr/bin/env node
// The engine of the check for R-021: the landing page says what Linkling is. Run it
// through its entry point, `checks/landing.sh`, which turns "node or this file is missing"
// into exit 2 instead of a shell error.
//
//   sh checks/landing.sh [site-root]      (default: the repo root)
//
// It reads index.html, drops everything a visitor does not read as page copy (comments,
// <script>, <style>, <title>, <textarea> and every tag with its attributes), and looks in
// what is left for three statements:
//   - it names Linkling;
//   - it says what Linkling is: a "link shortener";
//   - it says clicks are not tracked: "nobody" or "no one" and "tracked" in one sentence
//     ("Nobody who clicks a short link is tracked beyond a daily count."), or "tracks
//     nobody", or "not tracked" or "never tracked".
// It is a tripwire on the promise's wording, not proof that the promise is kept: the
// service's own tests (R-009, R-020) and the privacy page's check (R-022) do that. Text
// hidden by CSS or by an attribute still counts as text.
//
// Exit 0, `landing: PASS, ...`, when all three are there.
// Exit 1, `landing: FAIL, ...` after one line per missing statement, when one is not, or
// when the root exists and holds no index.html: the page R-021 asks for is not there.
// Exit 2, `landing: BLIND, ...`, when the root or index.html cannot be read, index.html
// is not a regular file, or its bytes are not UTF-8 text (NUL bytes, or a UTF-16 byte
// order mark): nothing was looked at, which is not the same as nothing being wrong.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

class Blind extends Error {}

const STATEMENTS = [
  ["index.html never names Linkling in its text", /\blinkling\b/],
  ['index.html never says what Linkling is (looked for "link shortener")', /\blink[ -]shortener\b/],
  [
    'index.html never says clicks are not tracked (looked for "nobody who clicks ... is tracked", "tracks nobody" or "not tracked")',
    // The one tracked is the one who clicks: "nobody (who clicks ...) is tracked", "tracks nobody",
    // "are not tracked". "Nobody likes being tracked" and "whether or not tracked" are not it.
    /\b(?:nobody|no[ -]one)\b(?: who [^.!?]*)? (?:is|gets|will be) (?:ever )?tracked\b|\btracks (?:nobody|no[ -]one)\b|\b(?:are|is|be|being|were)(?: not|n['’]t| never) tracked\b/,
  ],
];
// Elements whose content is not page copy: the parser reads it as raw text, or the browser
// shows it somewhere other than in the page.
const HIDDEN = new Set(["script", "style", "title", "textarea", "noscript", "template"]);

// One pass, no backtracking. A comment ends at the first "-->", an unterminated one runs to
// the end of the file; a tag ends at the first ">" outside quotes; a hidden element ends at
// its end tag, or at the end of the file.
function visibleText(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt) + " ";
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (!/[A-Za-z\/!?]/.test(next)) {
      out += "<"; // a "<" that starts no tag is text
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
    const name = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt, lt + 40))?.[1]?.toLowerCase();
    i = j + 1;
    if (name && HIDDEN.has(name)) {
      // HTML ignores a "/" in these start tags, so <title/> is still open.
      const close = new RegExp(`</${name}(?=[ \\t\\n\\f\\r/>])`, "gi");
      close.lastIndex = i;
      const c = close.exec(html);
      const gt = c ? html.indexOf(">", c.index) : -1;
      i = gt === -1 ? html.length : gt + 1;
    }
  }
  return out.replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/\s+/g, " ").toLowerCase();
}

function run(root) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch (e) {
    throw new Blind(`cannot read site root ${root}: ${e.message}`);
  }
  if (!stat.isDirectory()) throw new Blind(`site root ${root} is not a directory`);

  const file = join(root, "index.html");
  try {
    if (!lstatSync(file).isFile()) throw new Blind(`${file} is not a regular file`);
  } catch (e) {
    if (e instanceof Blind) throw e;
    if (e.code === "ENOENT") {
      console.error(`landing: no index.html at ${root}`);
      console.error(`landing: FAIL, the landing page is not there (1 problem under ${root})`);
      return 1;
    }
    throw new Blind(`cannot read ${file}: ${e.message}`);
  }
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new Blind(`cannot read ${file}: ${e.message}`);
  }
  const bom = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (bom || bytes.includes(0)) {
    throw new Blind(`${file} is not UTF-8 text (NUL bytes or a UTF-16 byte order mark), so it cannot be read`);
  }

  const text = visibleText(bytes.toString("utf8"));
  const missing = STATEMENTS.filter(([, re]) => !re.test(text)).map(([what]) => what);
  if (missing.length > 0) {
    for (const what of missing) console.error(`landing: ${what}`);
    console.error(`landing: FAIL, ${missing.length} of ${STATEMENTS.length} statements missing from ${file}`);
    return 1;
  }
  console.log(`landing: PASS, index.html names Linkling, says it is a link shortener and says clicks are not tracked (${file})`);
  return 0;
}

try {
  process.exitCode = run(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
} catch (e) {
  console.error(`landing: BLIND, ${e instanceof Blind ? e.message : e.stack}`);
  process.exitCode = 2;
}
