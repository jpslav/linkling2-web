#!/usr/bin/env node
// The self-test for the two site checks: R-023 (`checks/no-third-party.sh`) and R-021
// (`checks/landing.sh`). It builds each case as a small site under a temp directory, runs
// the real entry point on it, and compares the exit code and the words it printed with what
// the case expects. Every failing case is a control site plus exactly one edit, and the
// control case must stay green, so a red means the edit did it. The output is matched as
// well as the exit code: a fixture that fails for the wrong reason (it does not parse, say)
// would otherwise pass as the red it was meant to be.
//
//   node checks/selftest.mjs            (VERBOSE=1 prints every case, not only mismatches)
//
// Fixtures are generated here and never committed: the demo serves the whole checkout
// (linkling-api docs/adr/0006-hosting-topology.md), and checks/check.mjs reads checks/ like
// any other directory, so a committed .html fixture with an off-origin load would be a page
// on the site.
//
// To see that the self-test is wired to something, point it at a double:
//   NTP=/path/to/no-third-party.sh LANDING=/path/to/landing.sh node checks/selftest.mjs
//
// Exit 0, `selftest: PASS, N cases matched (S skipped)`, when every case matched.
// Exit 1, one MISMATCH block per case and then `selftest: FAIL, ...`, when one did not.
// Exit 2, `selftest: BLIND, ...`, when it could not run the entry points at all (a path
// that does not exist, `sh` that cannot be started) or has two cases of the same name.
// A case that needs a file the process cannot read is skipped when the process is root,
// because chmod 000 does not stop root: skipped cases are counted and printed, never
// silently passed. If node itself is missing, the shell reports 127 and CI is red.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NTP = process.env.NTP ?? join(HERE, "no-third-party.sh");
const LANDING = process.env.LANDING ?? join(HERE, "landing.sh");
const TIMEOUT_MS = 20000;
const MAX_BUFFER = 64 * 1024 * 1024;
const raw = String.raw;

class Blind extends Error {}

// ---------------------------------------------------------------- fixtures

const HEAD = (extra) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>T</title>\n<link rel="stylesheet" href="style.css">\n${extra}</head>\n<body>\n`;
const TAIL = "\n</body>\n</html>\n";
const page = (body, head = "") => HEAD(head) + body + TAIL;
const CSS_OK = "body { margin: 0; background: url(bg.png); }\n";
// A one-page site with a clean stylesheet: the control every failing case is an edit of.
const site = (body, { head = "", css = CSS_OK, extra = {} } = {}) => ({
  "index.html": page(body, head),
  "style.css": css,
  ...extra,
});
// The same, with the edit in the stylesheet.
const cssSite = (css) => site("<p>ok</p>", { css });

// A reason to skip a case that needs a file the process cannot read, or null.
const cannotDenyReads = () =>
  process.platform === "win32" || process.getuid?.() === 0 ? "chmod 000 does not deny reads to this process" : null;
// A landing page: one title, and the body under test.
const lpage = (body, { title = "Linkling", head = "" } = {}) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${head}</head>\n<body>\n${body}${TAIL}`;

// ---------------------------------------------------------------- cases

const CASES = [];
const add = (c) => CASES.push(c);
const countLine = (n) => new RegExp(`no-third-party: PASS, ${n} file\\(s\\) read under`);
const ntpPass = (name, files, count = "1 html and 1 css") => add({ name, tool: NTP, files, exit: 0, out: countLine(count), quiet: true });
const ntpFail = (name, files, out) => add({ name, tool: NTP, files, exit: 1, out });
const ntpBlind = (name, files, out, more = {}) => add({ name, tool: NTP, files, exit: 2, out, ...more });
const lanPass = (name, body, opts) =>
  add({ name, tool: LANDING, files: { "index.html": lpage(body, opts) }, exit: 0, out: /landing: PASS, index\.html names Linkling/, quiet: true });
const lanFail = (name, body, out, opts) => add({ name, tool: LANDING, files: { "index.html": lpage(body, opts) }, exit: 1, out });

const OFF = /URL on another origin: https:\/\/evil\.example/;
const HREF_NOT_A = /URL on another origin: https:\/\/evil\.example\/.*an href may leave the site only on an <a>/;

// ---- R-023 passing: exit 0, and the count of files it read
ntpPass("control-clean", site("<h1>Hi</h1><p>text</p>"));

// Outbound <a href> is allowed (run decision 2026-09-26): every spelling of an <a> and of an
// absolute URL that the failing cases below reject on any other element.
ntpPass("pass-a-href-https", site('<a href="https://github.com/jpslav">x</a>'));
ntpPass("pass-a-href-http", site('<a href="http://example.com/">x</a>'));
ntpPass("pass-a-href-protocol-relative", site('<a href="//example.com/x">x</a>'));
ntpPass("pass-a-href-uppercase-single-quote", site("<A HREF='HTTPS://EXAMPLE.COM/'>x</A>"));
ntpPass("pass-a-href-unquoted", site("<a href=https://example.com/x>x</a>"));
ntpPass("pass-a-href-spaced-equals", site('<a href = "https://example.com/x">x</a>'));
ntpPass("pass-a-href-tag-over-lines", site('<a\n  class="ext"\n  href="https://example.com/">x</a>'));
ntpPass("pass-a-href-after-gt-in-attribute", site('<a title="a>b" href="https://example.com/">x</a>'));
ntpPass("pass-a-href-in-svg", site('<svg viewBox="0 0 1 1"><a href="https://example.com/"><path d="M0 0"/></a></svg>'));
ntpPass("pass-a-xlink-href-in-svg", site('<svg><a xlink:href="https://example.com/"><path d="M0 0"/></a></svg>'));
ntpPass("pass-a-href-many", site(Array.from({ length: 200 }, (_, i) => `<a href="https://example.com/${i}">${i}</a>`).join("\n")));
ntpPass("pass-a-href-and-relative-mix", site('<a href="privacy.html">p</a> <a href="#top">t</a> <a href="mailto:a@b.example">m</a> <img src="/x.png" alt="">'));

ntpPass("pass-data-attribute-lookalikes", site('<div data-src="https://example.com/x" data-action="https://example.com/y" x-href="https://example.com/z" my-ping="https://example.com/w"></div>'));
ntpPass("pass-optional-end-tags", site("<ul><li>one<li>two</ul><p>para<p>para two"));
ntpPass("pass-void-tags", site('<br><hr><input disabled/><img src="a.png" alt="">'));
// Raw-text elements hold tag-like text without a parse problem (a <script> is not among the clean
// ones any more: the site runs none).
ntpPass("pass-style-with-tag-text", site("<style>/* </p><div> */ a > b { color: red }</style>"));
ntpPass("pass-textarea-with-tag-text", site("<textarea></p><div> if (1 < 2) {}</textarea>"));
ntpPass("pass-comment-with-tags", site('<!-- <div> not closed, <a href="x"> -->'));
ntpPass("pass-lt-in-text", site("<p>a < b and 3 <4</p>"));
ntpPass("pass-gt-in-attribute", site('<p title="a>b">x</p>'));
ntpPass("pass-uppercase-tags", site("<DIV><P>x</P></DIV>"));
ntpPass("pass-svg-self-closing", site('<svg viewBox="0 0 1 1"><path d="M0 0"/><circle r="1"/></svg>'));
ntpPass("pass-svg-use-fragment", site('<svg><use href="#icon"/></svg>'));
ntpPass("pass-empty-comment-forms", site("<!----> <!--- x --> <!-- y --!> <p>ok</p>"));
ntpPass("pass-lookalike-relative-names", site('<a href="httpsfoo.html">a</a> <a href="http-notes.html">b</a>'));
ntpPass("pass-srcset-relative", site('<img src="a.png" srcset="a.png 1x, a@2x.png 2x" alt="">'));
ntpPass("pass-poster-data-action-formaction-relative", site('<video poster="p.png"></video><object data="x.pdf"></object><form action="/signup" method="post"><button formaction="/other">go</button></form>'));
ntpPass("pass-ping-relative", site('<a href="x.html" ping="/count">x</a>'));
ntpPass("pass-meta-refresh-relative", site("<p>ok</p>", { head: '<meta http-equiv="refresh" content="5; url=other.html">\n' }));
// Only the target of http-equiv=refresh is read: another meta's content is not a load.
ntpPass("pass-meta-content-is-not-refresh", site("<p>ok</p>", { head: '<meta name="description" content="see url=https://example.com/x">\n<meta property="og:url" content="https://example.com/">\n' }));
ntpPass("pass-css-relative-url", cssSite('body { background: url(bg.png); } a { background: url("data:image/png;base64,AAAA"); }'));
ntpPass("pass-css-escaped-quote-relative", cssSite(raw`a { background: url("a\"b.png"); }`));
ntpPass("pass-css-import-relative", cssSite('@import "other.css";\n@import url(other2.css);'));
ntpPass("pass-css-attribute-selectors", cssSite(raw`a[href^="http"]::after { content: " \2197"; } a[href^="https://"] { color: inherit; }`));
ntpPass("pass-css-escape-space-relative", cssSite(raw`a{background:url(\61 .png)} b{background:url( "a.png" )} c{background:url( d.png )}`));
ntpPass("pass-css-not-a-url-function", cssSite("a{background:curly(https://x) ; b: url (https://x)}"));
ntpPass("pass-utf8-bom", { "index.html": "\ufeff" + page("<p>ok</p>"), "style.css": "\ufeffa{color:red}\n" });
ntpPass("pass-non-page-files-ignored", site("<p>ok</p>", { extra: { ".DS_Store": Buffer.from("\0\0junk"), "notes.txt": "src=https://evil.example/x" } }));
ntpPass("pass-skipped-directories", site("<p>ok</p>", { extra: { ".git": "gitdir: /x", ".github/x.html": "<div>", ".claude/x.html": "<div>", "node_modules/x.html": '<img src="https://evil.example/x">' } }));
ntpPass("pass-page-in-subdirectory", site("<p>ok</p>", { extra: { "docs/about.html": page("<p>about</p>") } }), "2 html and 1 css");
// What the check header says it does not cover, pinned so the header stays true: a change
// that closes one of these should move it to the failing cases.
ntpPass("gap-svg-breakout-div-passes", site("<svg><div/></svg>"));
ntpPass("gap-css-image-set-string-passes", cssSite('a{background:image-set("https://evil.example/a.png" 1x)}'));
ntpPass("gap-entity-encoded-src-passes", site('<img src="h&#116;tps://evil.example/a.png" alt="">'));
ntpPass("gap-javascript-url-passes", site('<a href="javascript:void(0)">x</a>'));
// No scripts (the privacy page says so): no <script> element and no on...= event-handler attribute.
const NO_SCRIPT = /index\.html:\d+: <script> element: the site runs no scripts/;
const NO_HANDLER = (name, tag) => new RegExp(`index\\.html:\\d+: ${name} event handler on <${tag}>: the site runs no scripts`);
ntpPass("pass-words-that-look-like-scripts", site('<p>a script, the &lt;script&gt; tag and an onclick="x()" example</p><a href="/scripts/app.js">x</a><div data-script="x" data-onclick="y"></div><noscript>ok</noscript>'));
ntpPass("pass-an-element-named-like-a-script", site("<scripted-widget>ok</scripted-widget>"));
ntpPass("pass-script-in-a-comment", site("<!-- <script>alert(1)</script> -->"));
ntpPass("pass-script-in-a-textarea", site("<textarea><script>alert(1)</script></textarea>"));
ntpPass("pass-handler-look-alikes-in-values-and-names", site('<p data-onclick="x" title="onclick=x" class="onload" aria-onclick="y" id="onerror">ok</p>'));
ntpFail("fail-script-element", site("<script>var a = 1;</script>"), NO_SCRIPT);
ntpFail("fail-script-element-that-fetches", site('<script>fetch("https://evil.example/")</script>'), NO_SCRIPT);
ntpFail("fail-script-element-with-a-same-origin-src", site('<script src="app.js"></script>'), NO_SCRIPT);
ntpFail("fail-script-element-uppercase", site("<SCRIPT>x</SCRIPT>"), NO_SCRIPT);
ntpFail("fail-script-element-json", site('<script type="application/ld+json">{}</script>'), NO_SCRIPT);
ntpFail("fail-script-element-in-the-head", site("<p>ok</p>", { head: "<script>var a = 1;</script>\n" }), NO_SCRIPT);
ntpFail("fail-script-element-in-svg", site("<svg><script>x</script></svg>"), NO_SCRIPT);
ntpFail("fail-script-element-with-tag-text", site('<script>var s = "</p><div>"; if (1 < 2) {}</script>'), NO_SCRIPT);
ntpFail("fail-script-element-in-a-second-page", site("<p>ok</p>", { extra: { "docs/about.html": page("<script>x</script>") } }), /docs\/about\.html:\d+: <script> element/);
ntpFail("fail-onclick-attribute", site('<a href="/x" onclick="go()">x</a>'), NO_HANDLER("onclick", "a"));
ntpFail("fail-onerror-attribute-on-an-img", site('<img src="a.png" alt="" onerror="x()">'), NO_HANDLER("onerror", "img"));
ntpFail("fail-onload-attribute-on-svg", site('<svg onload="x()"></svg>'), NO_HANDLER("onload", "svg"));
ntpFail("fail-handler-attribute-uppercase", site('<p ONCLICK="x()">x</p>'), NO_HANDLER("onclick", "p"));
ntpFail("fail-handler-attribute-unquoted", site("<button onclick=go()>x</button>"), NO_HANDLER("onclick", "button"));
ntpFail("fail-handler-attribute-single-quoted", site("<a href=\"/x\" onmouseover='x()'>x</a>"), NO_HANDLER("onmouseover", "a"));
ntpFail("fail-handler-attribute-without-a-value", site("<p onclick>x</p>"), NO_HANDLER("onclick", "p"));
ntpFail("fail-handler-attribute-after-other-attributes", site('<img alt="a>b" src="a.png" onload="x()">'), NO_HANDLER("onload", "img"));

// ---- R-023 failing: exit 1, and why. Each is site() plus one edit.
ntpFail("fail-img-src-https", site('<img src="https://evil.example/a.png" alt="">'), OFF);
ntpFail("fail-img-src-http", site('<img src="http://evil.example/a.png" alt="">'), /URL on another origin: http:\/\/evil\.example/);
ntpFail("fail-src-protocol-relative", site('<img src="//evil.example/a.png" alt="">'), /URL on another origin: \/\/evil\.example/);
ntpFail("fail-src-uppercase-single-quote", site("<IMG SRC='HTTPS://EVIL.EXAMPLE/a.png'>"), /URL on another origin: HTTPS:\/\/EVIL\.EXAMPLE/);
ntpFail("fail-src-unquoted", site("<script src=https://evil.example/x.js></script>"), OFF);
ntpFail("fail-iframe-src", site('<iframe src="https://evil.example/"></iframe>'), OFF);
ntpFail("fail-source-src", site('<video><source src="https://evil.example/v.mp4"></video>'), OFF);
ntpFail("fail-src-backslash-form", site(raw`<img src="\\evil.example/x.png" alt="">`), /URL on another origin: \/\/evil\.example/);
ntpFail("fail-src-tab-in-scheme", site('<img src="ht\ttps://evil.example/a.png" alt="">'), OFF);
ntpFail("fail-src-c0-control-prefix", site('<img src="\u0001//evil.example/a.png" alt="">'), /URL on another origin: \/\/evil\.example/);
ntpFail("fail-src-scheme-without-slashes", site('<img src="http:evil.example/a.png" alt="">'), /URL on another origin: http:evil\.example/);
ntpFail("fail-src-scheme-one-slash", site('<img src="https:/evil.example/a.png" alt="">'), /URL on another origin: https:\/evil\.example/);
ntpFail("fail-a-src", site('<a src="https://evil.example/x">x</a>'), OFF);

// href is allowed off the site on an <a> and nowhere else.
ntpFail("fail-link-stylesheet-href", site("<p>ok</p>", { head: '<link rel="stylesheet" href="https://evil.example/x.css">\n' }), HREF_NOT_A);
ntpFail("fail-link-preconnect-href", site("<p>ok</p>", { head: '<link rel="preconnect" href="https://evil.example/">\n' }), HREF_NOT_A);
ntpFail("fail-link-canonical-href", site("<p>ok</p>", { head: '<link rel="canonical" href="https://evil.example/">\n' }), HREF_NOT_A);
ntpFail("fail-base-href", site("<p>ok</p>", { head: '<base href="https://evil.example/">\n' }), HREF_NOT_A);
ntpFail("fail-area-href", site('<map name="m"><area href="https://evil.example/"></map>'), HREF_NOT_A);
ntpFail("fail-svg-use-href", site('<svg><use href="https://evil.example/s.svg#i"/></svg>'), HREF_NOT_A);
ntpFail("fail-svg-use-xlink-href", site('<svg><use xlink:href="https://evil.example/s.svg#i"/></svg>'), HREF_NOT_A);
ntpFail("fail-svg-image-href", site('<svg><image href="https://evil.example/a.png"/></svg>'), HREF_NOT_A);
ntpFail("fail-abbr-href-is-not-an-a", site('<abbr href="https://evil.example/">x</abbr>'), HREF_NOT_A);
ntpFail("fail-custom-element-a-b-href", site('<a-b href="https://evil.example/">x</a-b>'), HREF_NOT_A);
// The exemption ends with the <a> start tag it is in.
ntpFail("fail-link-right-after-an-a", site('<a href="/ok">ok</a><link rel="stylesheet" href="https://evil.example/x.css">'), HREF_NOT_A);
ntpFail("fail-a-href-in-comment", site('<!-- <a href="https://evil.example/"> -->'), OFF);
ntpFail("fail-a-href-in-script-text", site(`<script>var a = '<a href="https://evil.example/">';</script>`), OFF);
ntpFail("fail-a-href-in-textarea", site('<textarea><a href="https://evil.example/"></textarea>'), OFF);
ntpFail("fail-href-in-prose", site("<p>href=https://evil.example/</p>"), OFF);
ntpFail("fail-css-attribute-selector-href", cssSite('a[href="https://evil.example/"] { color: red }'), OFF);

// CSS: url(), including the escapes the LL-001 reviewers found, and @import.
ntpFail("fail-inline-style-url", site('<div style="background: url(https://evil.example/x.png)"></div>'), OFF);
ntpFail("fail-style-element-url", site("<style>a{background:url(https://evil.example/x.png)}</style>"), OFF);
ntpFail("fail-css-url-http", cssSite("body { background: url(http://evil.example/x.png); }"), /URL on another origin: http:\/\/evil\.example/);
ntpFail("fail-css-url-protocol-relative", cssSite("body { background: url(//evil.example/x.png); }"), /URL on another origin: \/\/evil\.example/);
ntpFail("fail-css-url-quoted-spaces", cssSite('body { background: url( "https://evil.example/x.png" ); }'), OFF);
ntpFail("fail-css-url-uppercase", cssSite("a{background:URL(https://evil.example/a.png)}"), OFF);
ntpFail("fail-css-url-escaped-name", cssSite(raw`a{background:u\72l(https://evil.example/a.png)}`), OFF);
ntpFail("fail-css-url-hex-escape", cssSite(raw`a{background:url(\68ttps://evil.example/a.png)}`), OFF);
ntpFail("fail-css-url-hex-escape-space", cssSite(raw`a{background:url(\68 ttps://evil.example/a.png)}`), OFF);
ntpFail("fail-css-url-escaped-quote", cssSite(raw`a{background:url("https://evil.example/a\"b.png")}`), OFF);
ntpFail("fail-css-url-unterminated-quote", cssSite('a{background:url("https://evil.example/x.png'), OFF);
ntpFail("fail-css-url-bad-string-hides-next", cssSite('a{background:url("\n) }\nb{background:url("https://evil.example/x.png") }'), OFF);
ntpFail("fail-css-url-padded-300-spaces", cssSite(`a{background:url("${" ".repeat(300)}https://evil.example/a.png")}`), OFF);
ntpFail("fail-css-url-line-continuation-lf", cssSite('a{background:url("ht\\\ntps://evil.example/a.png")}'), OFF);
ntpFail("fail-css-import-string-double", cssSite('@import "https://evil.example/x.css";'), OFF);
ntpFail("fail-css-import-string-single", cssSite("@import 'https://evil.example/x.css';"), OFF);
ntpFail("fail-css-import-string-protocol-relative", cssSite('@import "//evil.example/x.css";'), /URL on another origin: \/\/evil\.example/);
ntpFail("fail-css-import-string-escaped", cssSite(raw`@import "\68ttps://evil.example/x.css";`), OFF);
ntpFail("fail-css-import-url", cssSite("@import url(https://evil.example/x.css);"), OFF);
ntpFail("fail-style-element-import-string", site('<style>@import "https://evil.example/x.css";</style>'), OFF);

// The other attributes that load from, or send to, another origin.
ntpFail("fail-srcset", site('<img src="a.png" srcset="https://evil.example/a.png 2x" alt="">'), OFF);
ntpFail("fail-srcset-second-candidate", site('<img src="a.png" srcset="a.png 1x, https://evil.example/b.png 2x" alt="">'), OFF);
ntpFail("fail-srcset-no-space-after-comma", site('<img src="a.png" srcset="a.png 1x,https://evil.example/b.png 2x" alt="">'), OFF);
ntpFail("fail-imagesrcset", site("<p>ok</p>", { head: '<link rel="preload" as="image" imagesrcset="https://evil.example/a.png 1x">\n' }), OFF);
ntpFail("fail-poster", site('<video poster="https://evil.example/p.png"></video>'), OFF);
ntpFail("fail-object-data", site('<object data="https://evil.example/x.swf"></object>'), OFF);
ntpFail("fail-form-action", site('<form action="https://evil.example/collect"><button>go</button></form>'), OFF);
ntpFail("fail-button-formaction", site('<form action="/x"><button formaction="https://evil.example/collect">go</button></form>'), OFF);
ntpFail("fail-a-ping", site('<a href="x.html" ping="https://evil.example/t">x</a>'), OFF);
ntpFail("fail-a-ping-second-url", site('<a href="x.html" ping="/count https://evil.example/t">x</a>'), OFF);
ntpFail("fail-meta-refresh-url", site("<p>ok</p>", { head: '<meta http-equiv="refresh" content="0;url=https://evil.example/">\n' }), OFF);
ntpFail("fail-meta-refresh-bare-url", site("<p>ok</p>", { head: '<meta http-equiv="refresh" content="0; https://evil.example/">\n' }), OFF);
ntpFail("fail-meta-refresh-quoted-url", site("<p>ok</p>", { head: `<meta http-equiv="refresh" content="0; url='https://evil.example/'">\n` }), OFF);
ntpFail("fail-meta-refresh-uppercase", site("<p>ok</p>", { head: '<META HTTP-EQUIV=REFRESH CONTENT="0;URL=https://evil.example/">\n' }), OFF);
ntpFail("fail-meta-refresh-content-before-http-equiv", site("<p>ok</p>", { head: '<meta content="0;url=https://evil.example/" http-equiv="refresh">\n' }), OFF);

// Where a page can hide from the walk.
ntpFail("fail-checks-directory-is-read", site("<p>ok</p>", { extra: { "checks/page.html": page('<img src="https://evil.example/a.png" alt="">') } }), /checks\/page\.html:.*URL on another origin/);
ntpFail("fail-page-in-subdirectory", site("<p>ok</p>", { extra: { "docs/about.html": page('<script src="https://evil.example/a.js"></script>') } }), /docs\/about\.html:.*URL on another origin/);
ntpFail("fail-page-in-dot-directory", site("<p>ok</p>", { extra: { ".well-known/x.html": page('<script src="https://evil.example/a.js"></script>') } }), /\.well-known\/x\.html:.*URL on another origin/);
add({ name: "fail-symlink", tool: NTP, files: site("<p>ok</p>", { extra: { "link.html": { symlink: "index.html" } } }), exit: 1, out: /link\.html: symlink, not followed and so not checked/ });
ntpFail("fail-many-findings", site('<img src="//evil.example/x" alt="">\n'.repeat(5000)), /no-third-party: FAIL, 5000 problem\(s\)/);

// Well-formedness: the walk that finds the <a> tags has to be able to trust the page.
ntpFail("fail-unterminated-comment", site("<!-- oops"), /unterminated comment/);
ntpFail("fail-unclosed-div", site("<div>never closed"), /<div> is not closed before <\/body>/);
ntpFail("fail-stray-end-tag", site("<p>x</p></span>"), /stray <\/span>/);
ntpFail("fail-unclosed-before-parent-end", site("<div><span>x</div>"), /<span> is not closed before <\/div>/);
ntpFail("fail-malformed-start-tag", site('<a href="x>text</a>'), /malformed start tag/);
ntpFail("fail-unterminated-script", site("<script>var a = 1;"), /unterminated <script>/);
ntpFail("fail-unterminated-style", site("<style>a { color: red }"), /unterminated <style>/);
ntpFail("fail-unterminated-textarea", site("<textarea>text"), /unterminated <textarea>/);
ntpFail("fail-unterminated-title", site("<title>oops"), /unterminated <title>/);
ntpFail("fail-unterminated-tag-at-eof", site("<div"), /malformed start tag/);
ntpFail("fail-html-div-self-closing", site("<div/>"), /<div> is not closed before <\/body>/);
ntpFail("fail-empty-comment-form-hides-a-div", site("<!--> <div> <!-- x -->"), /<div> is not closed before <\/body>/);
ntpFail("fail-comment-ending-bang-hides-a-div", site("<!-- a --!> <div> <!-- b -->"), /<div> is not closed before <\/body>/);
ntpFail("gap-script-double-escape-is-a-stray-end-tag", site("<script>\n<!--\n<script>x</script>\n-->\n</script>"), /stray <\/script>/);

// Where the walk and a browser could disagree about where a tag ends. HTML whitespace is
// space, tab, LF, FF and CR; NBSP and VT are part of a name or a value, so a tag that a
// loose \s would end early must not hide the <link> that follows it.
const LINK_ITEM = '<link rel=stylesheet href=https://evil.example/x.css>';
ntpFail("fail-tag-nbsp-before-quote-does-not-hide-a-link", site(`<a x= ">${LINK_ITEM}">x</a>`), HREF_NOT_A);
ntpFail("fail-tag-vt-before-quote-does-not-hide-a-link", site(`<a x=\u000b">${LINK_ITEM}">x</a>`), HREF_NOT_A);
ntpFail("fail-script-end-tag-with-nbsp-is-not-an-end-tag", site(`<script></script ><a title="</script>${LINK_ITEM}">x</a>`), HREF_NOT_A);
// A quote that never closes in prose must not swallow the tags after it and their attributes.
ntpFail("fail-unclosed-quote-in-prose-does-not-hide-a-link", site("<p>ok</p>", { head: `<meta name="description" content="Tip: set data='">\n${LINK_ITEM}\n<meta name="author" content="O'Brien">\n` }), HREF_NOT_A);
ntpFail("fail-unclosed-quote-after-src-does-not-hide-a-link", site("<p>ok</p>", { head: `<meta name="description" content="see src='">\n${LINK_ITEM}\n<meta name="author" content="O'Brien">\n` }), HREF_NOT_A);
ntpFail("fail-attributionsrc", site('<img src="a.png" attributionsrc="https://evil.example/r" alt="">'), OFF);
ntpFail("fail-attributionsrc-second-url", site('<a href="x.html" attributionsrc="/r https://evil.example/r">x</a>'), OFF);
ntpFail("fail-css-import-escaped-keyword", site('<style>@\\69mport "https://evil.example/x.css";</style>'), OFF);
ntpFail("fail-css-import-uppercase-keyword", cssSite('@IMPORT "https://evil.example/x.css";'), OFF);
// A value inside a start tag is opaque: an allowed link, or a same-origin URL, may carry an
// absolute URL in its query. The scan goes on after the value, but never past the tag's end.
ntpPass("pass-a-href-query-carries-a-src-url", site('<a href="https://a.example/embed?src=https://b.example/v.mp4">b</a>'));
ntpPass("pass-a-href-query-carries-a-data-url", site('<a href="https://a.example/x?data=https://b.example/d.json">b</a>'));
ntpPass("pass-a-href-query-carries-an-action-url", site('<a href="https://a.example/x?action=https://b.example/go">b</a>'));
ntpPass("pass-relative-src-query-carries-an-absolute-url", site('<img src="/proxy?src=https://b.example/x.png" alt="">'));
ntpFail("fail-real-src-after-an-a-with-a-src-query", site('<a href="https://a.example/e?src=https://b.example/v.mp4">b</a><img src="https://evil.example/a.png" alt="">'), OFF);
ntpFail("fail-quote-inside-a-tag-value-cannot-carry-the-scan-past-the-tag", site(`<p title="src='">${LINK_ITEM}<p title='x'>ok</p>`), HREF_NOT_A);
// The attributes of a start tag are read from the tag, so a value that ends in a name from the list
// (alt="x src=") cannot make the scan take its closing quote for an opening one and step over the
// real attribute that follows. Each of these passed the check at one earlier commit or another.
ntpFail("fail-alt-ending-in-src-does-not-hide-the-src", site('<img alt="x src=" src="https://evil.example/a.png">'), OFF);
ntpFail("fail-placeholder-ending-in-data-does-not-hide-formaction", site('<form><input placeholder="?data=" formaction="https://evil.example/go"></form>'), OFF);
ntpFail("fail-title-ending-in-data-does-not-hide-srcset", site('<img title="data=" srcset="https://evil.example/a.png 2x" src="a.png" alt="">'), OFF);
ntpFail("fail-title-ending-in-src-does-not-hide-ping", site('<a href="/" title="Share as ?src=" ping="https://evil.example/p">x</a>'), OFF);
ntpFail("fail-title-ending-in-data-does-not-hide-a-font-link", site("<p>ok</p>", { head: '<link rel="stylesheet" title="data=" href="https://fonts.example/css">\n' }), /URL on another origin: https:\/\/fonts\.example\/css \(an href may leave the site only on an <a>\)/);
ntpFail("fail-duplicate-src-second-is-off-origin", site('<img src="a.png" src="https://evil.example/a.png" alt="">'), OFF);
ntpFail("fail-valueless-attribute-before-src", site('<img ismap src="https://evil.example/a.png" alt="">'), OFF);
ntpFail("fail-src-after-an-unquoted-value", site('<img alt=x src=https://evil.example/a.png>'), OFF);
ntpFail("fail-meta-refresh-with-content-text-in-another-attribute", site("<p>ok</p>", { head: '<meta http-equiv="refresh" name="x content=5" content="0;url=https://evil.example/">\n' }), OFF);
// A value is opaque: absolute URLs after the names inside a value are not attributes.
ntpPass("pass-names-and-absolute-urls-inside-a-value", site('<a href="/x" title="see src=https://b.example/x and href=https://b.example/y">x</a>'));
// A browser decodes &quot; and &#39; in an attribute value, so a style attribute can hold them around a url().
ntpFail("fail-style-attribute-url-in-quot-entities", site('<div style="background-image: url(&quot;https://evil.example/x.png&quot;);"></div>'), OFF);
ntpFail("fail-style-attribute-url-in-numeric-apostrophe-entities", site("<div style=\"background-image: url(&#39;https://evil.example/x.png&#39;);\"></div>"), OFF);
ntpFail("fail-style-attribute-url-in-hex-quote-entities", site('<div style="background-image: url(&#x22;https://evil.example/x.png&#x22;);"></div>'), OFF);
ntpPass("pass-style-attribute-relative-url-in-quot-entities", site('<div style="background-image: url(&quot;bg.png&quot;);"></div>'));
// What the header still says it does not cover, pinned like the other gaps.
ntpPass("gap-css-import-with-a-comment-passes", cssSite('@import/**/"https://evil.example/x.css";'));
ntpPass("gap-meta-refresh-entity-encoded-passes", site("<p>ok</p>", { head: '<meta http-equiv="&#114;efresh" content="0;url=https://evil.example/">\n' }));

// ---- R-023 blind: exit 2, could not look
const ONE_PAGE = () => ({ "index.html": page("<p>ok</p>") });
add({ name: "blind-root-missing", tool: NTP, files: {}, root: (_r, dir) => join(dir, "does-not-exist"), exit: 2, out: /no-third-party: BLIND, cannot read site root/ });
add({ name: "blind-root-is-a-file", tool: NTP, files: { afile: "x" }, root: (r) => join(r, "afile"), exit: 2, out: /no-third-party: BLIND, site root .* is not a directory/ });
ntpBlind("blind-empty-root", {}, /no-third-party: BLIND, no index\.html at/);
ntpBlind("blind-no-index-html", { "other.html": page("<p>x</p>") }, /no-third-party: BLIND, no index\.html at/);
ntpBlind("blind-index-only-in-subdirectory", { "docs/index.html": page("<p>x</p>") }, /no-third-party: BLIND, no index\.html at/);
ntpBlind("blind-index-htm", { "index.htm": page("<p>x</p>") }, /no-third-party: BLIND, no index\.html at/);
ntpBlind("blind-utf16-byte-order-mark", { "index.html": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(page("<p>x</p>"), "utf16le")]) }, /no-third-party: BLIND, index\.html is not UTF-8 text/);
ntpBlind("blind-nul-bytes", { "index.html": Buffer.from("<p>a\0b</p>") }, /no-third-party: BLIND, index\.html is not UTF-8 text/);
ntpBlind("blind-nul-bytes-in-css", { ...ONE_PAGE(), "style.css": Buffer.from("a{color:red}\0") }, /no-third-party: BLIND, style\.css is not UTF-8 text/);
ntpBlind("blind-unreadable-index", ONE_PAGE(), /no-third-party: BLIND, cannot read index\.html/, {
  skipIf: cannotDenyReads,
  setup: (r) => chmodSync(join(r, "index.html"), 0o000),
  after: (r) => chmodSync(join(r, "index.html"), 0o644),
});
ntpBlind("blind-unreadable-subdirectory", { ...ONE_PAGE(), "sub/a.html": page("<p>y</p>") }, /no-third-party: BLIND, cannot read directory/, {
  skipIf: cannotDenyReads,
  setup: (r) => chmodSync(join(r, "sub"), 0o000),
  after: (r) => chmodSync(join(r, "sub"), 0o755),
});
// The two dependencies of the shell entry point, each made absent: an empty PATH has no node,
// and a copy of the script on its own has no check.mjs beside it.
const withoutNode = ({ tool, target, dir }) => {
  const empty = join(dir, "empty-path");
  mkdirSync(empty);
  return spawnSync("/bin/sh", [tool, target], { encoding: "utf8", env: { PATH: empty }, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
};
const withoutEngine = ({ tool, target, dir }) => {
  const lone = join(dir, "lone");
  mkdirSync(lone);
  const copy = join(lone, basename(tool));
  copyFileSync(tool, copy);
  return spawnSync("sh", [copy, target], { encoding: "utf8", env: nodeEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
};
ntpBlind("blind-node-absent", ONE_PAGE(), /no-third-party: BLIND, node is not on PATH/, { spawn: withoutNode });
ntpBlind("blind-engine-absent", ONE_PAGE(), /no-third-party: BLIND, .*check\.mjs is missing or unreadable/, { spawn: withoutEngine });
// The engine is there but does not say what it found: an entry point passes on an exit code
// only when the engine's last word agrees with it. `source` gets the entry point's prefix.
const withEngine = (source) => ({ tool, target, dir }) => {
  const lone = join(dir, "lone");
  mkdirSync(lone);
  const copy = join(lone, basename(tool));
  copyFileSync(tool, copy);
  const landing = basename(tool) === "landing.sh";
  writeFileSync(join(lone, landing ? "landing.mjs" : "check.mjs"), source(landing ? "landing" : "no-third-party"));
  return spawnSync("sh", [copy, target], { encoding: "utf8", env: nodeEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
};
const SILENT_ENGINES = {
  empty: [() => "", 0],
  "syntax-error": [() => "this is not javascript (\n", 1],
  "says-pass-but-exits-1": [(w) => `console.log("${w}: PASS, x"); process.exitCode = 1;\n`, 1],
  "says-fail-but-exits-0": [(w) => `console.error("${w}: FAIL, x"); process.exitCode = 0;\n`, 0],
  "says-blind-but-exits-1": [(w) => `console.error("${w}: BLIND, x"); process.exitCode = 1;\n`, 1],
  killed: [() => 'process.kill(process.pid, "SIGKILL");\n', 137],
};
for (const [label, [source, rc]] of Object.entries(SILENT_ENGINES)) {
  for (const [prefix, tool, word, engine] of [["blind", NTP, "no-third-party", "check"], ["blind-landing", LANDING, "landing", "landing"]]) {
    add({ name: `${prefix}-engine-${label}`, tool, files: ONE_PAGE(), exit: 2, out: new RegExp(`${word}: BLIND, ${engine}\\.mjs exited ${rc} without saying`), spawn: withEngine(source) });
  }
}

// ---- Speed: the LL-001 reviewers found inputs that took seconds to minutes. Each must finish.
const perfSite = (css, body = "<p>ok</p>") => site(body, { css });
ntpPass("perf-css-url-and-spaces", perfSite(("a{b:url(" + " ".repeat(20000) + "\n").repeat(5)));
ntpPass("perf-css-url-chain", perfSite("a{b:" + "url(".repeat(300000) + "}\n"));
ntpPass("perf-deep-nesting-and-br", site("<div>".repeat(60000) + "<br/>".repeat(60000) + "</div>".repeat(60000)));
ntpPass("perf-deep-svg-self-closing", site("<svg>" + "<g>".repeat(60000) + "<path/>".repeat(60000) + "</g>".repeat(60000) + "</svg>"));
ntpPass("perf-many-anchors", site('<a href="https://example.com/x">x</a>\n'.repeat(20000)));

// ---- R-021 passing: exit 0
const GOOD = "<h1>Linkling</h1><p>A small link shortener a team runs for itself. Nobody who clicks a short link is tracked beyond a daily count.</p>";
lanPass("pass-landing-the-three-statements", GOOD);
lanPass("pass-landing-tracks-nobody", "<p>Linkling is a link shortener for teams. Linkling tracks nobody who clicks.</p>");
lanPass("pass-landing-not-tracked", "<p>Linkling: a link-shortener. Clicks are not tracked.</p>");
lanPass("pass-landing-never-tracked", "<p>Linkling, a link shortener. Clicks are never tracked.</p>");
lanPass("pass-landing-uppercase", "<H1>LINKLING</H1><P>A LINK SHORTENER. NOBODY WHO CLICKS IS TRACKED.</P>");
lanPass("pass-landing-words-split-by-tags-and-lines", "<p>Linkling is a <strong>link\nshortener</strong>. <em>No one</em> who clicks\n a short link is <b>tracked</b>.</p>");
lanPass("pass-landing-lt-in-text", "<p>Linkling 1 < 2 is a link shortener. Nobody who clicks is tracked.</p>");
lanPass("pass-landing-gt-in-attribute", '<p title="a>b">Linkling is a link shortener. Nobody who clicks is tracked.</p>');
lanPass("pass-landing-in-link-text", '<p>Linkling is a link shortener. <a href="https://example.com/">Nobody who clicks is tracked</a>.</p>');
lanPass("pass-landing-arent-tracked", "<p>Linkling is a link shortener. Clicks aren't tracked.</p>");
lanPass("pass-landing-gets-tracked", "<p>Linkling is a link shortener. No one who clicks a short link gets tracked.</p>");
lanPass("pass-landing-ever-tracked", "<p>Linkling is a link shortener. Nobody is ever tracked.</p>");
lanPass("pass-landing-non-breaking-spaces", "<p>Linkling is a link&nbsp;shortener. Nobody who clicks&nbsp;is tracked.</p>");
lanPass("pass-landing-non-breaking-space-with-leading-zeros", "<p>Linkling is a link&#x00A0;shortener. Nobody who clicks&#0160;is tracked.</p>");
lanPass("pass-landing-is-being-tracked", "<p>Linkling is a link shortener. No one who clicks is being tracked.</p>");
lanPass("pass-landing-nobody-is-tracked", "<p>Linkling is a link shortener. Nobody is tracked.</p>");
lanPass("pass-landing-clicks-are-not-being-tracked", "<p>Linkling is a link shortener. Clicks are not being tracked.</p>");
lanPass("pass-landing-you-are-not-tracked", "<p>Linkling is a link shortener. When you follow a short link, you are not tracked.</p>");

// ---- R-021 failing: exit 1, and which statement is missing
const NAMES = /landing: index\.html never names Linkling in its text/;
const WHAT = /landing: index\.html never says what Linkling is/;
const CLAIM = /landing: index\.html never says clicks are not tracked/;
lanFail("fail-landing-does-not-name-linkling-only-the-title-does", "<p>A link shortener. Nobody who clicks is tracked.</p>", NAMES);
lanFail("fail-landing-does-not-say-what-it-is", "<p>Linkling. Nobody who clicks is tracked.</p>", WHAT);
lanFail("fail-landing-says-nothing-about-tracking", "<p>Linkling is a link shortener.</p>", CLAIM);
lanFail("fail-landing-promise-only-in-a-comment", "<p>Linkling is a link shortener.</p><!-- Nobody who clicks is tracked -->", CLAIM);
lanFail("fail-landing-promise-only-in-a-script", '<p>Linkling is a link shortener.</p><script>var s = "Nobody who clicks is tracked";</script>', CLAIM);
lanFail("fail-landing-promise-only-in-a-style", "<p>Linkling is a link shortener.</p><style>/* Nobody who clicks is tracked */</style>", CLAIM);
lanFail("fail-landing-promise-only-in-the-title", "<p>Linkling is a link shortener.</p>", CLAIM, { title: "Linkling: nobody who clicks is tracked" });
lanFail("fail-landing-promise-only-in-an-attribute", '<p>Linkling is a link shortener.</p><img src="a.png" alt="Nobody who clicks is tracked">', CLAIM);
lanFail("fail-landing-promise-only-in-the-meta-description", "<p>Linkling is a link shortener.</p>", CLAIM, { head: '<meta name="description" content="Nobody who clicks is tracked">\n' });
lanFail("fail-landing-promise-only-in-a-textarea", "<p>Linkling is a link shortener.</p><textarea>Nobody who clicks is tracked</textarea>", CLAIM);
lanFail("fail-landing-unterminated-comment-swallows-the-promise", "<p>Linkling is a link shortener.</p><!-- <p>Nobody who clicks is tracked.</p>", CLAIM);
lanFail("fail-landing-the-opposite-claim", "<p>Linkling is a link shortener. Everyone who clicks is tracked.</p>", CLAIM);
lanFail("fail-landing-nobody-and-tracked-in-different-sentences", "<p>Linkling is a link shortener. Nobody is asked to sign in. Every click is tracked.</p>", CLAIM);
// Sentences that use the words and promise the opposite, or nothing.
lanFail("fail-landing-nobody-likes-being-tracked", "<p>Linkling is a link shortener with a stats page that shows who clicked each link.</p><p>Nobody likes being tracked, so we keep those stats private to your team.</p>", CLAIM);
lanFail("fail-landing-nobody-wants-to-be-tracked", "<p>Linkling is a link shortener. Nobody wants to be tracked, but every click is.</p>", CLAIM);
lanFail("fail-landing-whether-or-not-tracked", "<p>Linkling is a link shortener. Whether or not tracked by us, every click is logged by the host.</p>", CLAIM);
// The words of the promise, followed by a second clause that promises the opposite.
lanFail("fail-landing-opposite-promise-after-a-comma", "<h1>Linkling</h1><p>A link shortener. Nobody who clicks needs an account, and every click is tracked with IP and browser.</p>", CLAIM);
lanFail("fail-landing-opposite-promise-after-a-semicolon", "<h1>Linkling</h1><p>A link shortener. Nobody who clicks is asked to sign in; every click is tracked.</p>", CLAIM);
lanFail("fail-landing-opposite-promise-after-and", "<h1>Linkling</h1><p>A link shortener. Nobody who clicks needs an account and every click is tracked.</p>", CLAIM);
lanFail("fail-landing-opposite-promise-after-but", "<h1>Linkling</h1><p>A link shortener. No one who clicks pays but everyone is tracked.</p>", CLAIM);
lanFail("fail-landing-who-clause-is-not-about-clicking", "<h1>Linkling</h1><p>A link shortener. Nobody who cares is tracked less than the rest.</p>", CLAIM);
// Not the promise: links are not the ones being tracked.
lanFail("fail-landing-links-not-tracked-is-not-the-promise", "<h1>Linkling</h1><p>A link shortener. Expired links are not tracked. Every other click is logged with its IP address.</p>", CLAIM);
// What a regex cannot tell from the promise, pinned so the header stays true: a qualifier or a second
// sentence after "tracked", a negated wrapper, or a subject that is not the one who clicks.
lanPass("gap-landing-qualifier-and-a-contradiction-after-tracked-passes", "<h1>Linkling</h1><p>A link shortener. Nobody is tracked by name, but every click is logged with its IP address and browser.</p>");
lanPass("gap-landing-negated-wrapper-passes", "<h1>Linkling</h1><p>A link shortener. We can not promise that nobody is tracked.</p>");
lanPass("gap-landing-you-clause-with-a-contradiction-after-a-semicolon-passes", "<h1>Linkling</h1><p>A link shortener. If you opt out, you are not tracked; otherwise every click is logged with its IP address.</p>");
lanPass("gap-landing-subject-who-uses-the-dashboard-passes", "<h1>Linkling</h1><p>A link shortener. Nobody who uses the dashboard is tracked. Every click is logged with its IP address.</p>");
// Text a visitor does not see as page copy.
lanFail("fail-landing-promise-only-in-a-noscript", "<p>Linkling is a link shortener.</p><noscript>Nobody who clicks is tracked.</noscript>", CLAIM);
lanFail("fail-landing-promise-only-in-a-template", "<p>Linkling is a link shortener.</p><template><p>Nobody who clicks is tracked.</p></template>", CLAIM);
// </script followed by NBSP is not an end tag, so the promise below it is still script text.
lanFail("fail-landing-script-end-tag-with-nbsp-is-not-an-end-tag", "<p>Linkling is a link shortener.</p><script>var a=1;</script ><p>Nobody who clicks is tracked.</p><script>var b=2;</script>", CLAIM);
add({ name: "fail-landing-empty-index", tool: LANDING, files: { "index.html": "" }, exit: 1, out: /landing: FAIL, 3 of 3 statements missing/ });
add({ name: "fail-landing-no-index-html", tool: LANDING, files: { "other.html": page(GOOD) }, exit: 1, out: /landing: no index\.html at .*\n.*landing: FAIL, the landing page is not there/ });
add({ name: "fail-landing-empty-root", tool: LANDING, files: {}, exit: 1, out: /landing: FAIL, the landing page is not there/ });

// ---- R-021 blind: exit 2
add({ name: "blind-landing-root-missing", tool: LANDING, files: {}, root: (_r, dir) => join(dir, "does-not-exist"), exit: 2, out: /landing: BLIND, cannot read site root/ });
add({ name: "blind-landing-root-is-a-file", tool: LANDING, files: { afile: "x" }, root: (r) => join(r, "afile"), exit: 2, out: /landing: BLIND, site root .* is not a directory/ });
add({ name: "blind-landing-index-is-a-directory", tool: LANDING, files: { "index.html": null }, exit: 2, out: /landing: BLIND, .*index\.html is not a regular file/ });
add({ name: "blind-landing-index-is-a-symlink", tool: LANDING, files: { "real.html": page(GOOD), "index.html": { symlink: "real.html" } }, exit: 2, out: /landing: BLIND, .*index\.html is not a regular file/ });
add({ name: "blind-landing-utf16-byte-order-mark", tool: LANDING, files: { "index.html": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(page(GOOD), "utf16le")]) }, exit: 2, out: /landing: BLIND, .*index\.html is not UTF-8 text/ });
add({ name: "blind-landing-nul-bytes", tool: LANDING, files: { "index.html": Buffer.from("<p>Linkling\0</p>") }, exit: 2, out: /landing: BLIND, .*index\.html is not UTF-8 text/ });
add({
  name: "blind-landing-unreadable-index",
  tool: LANDING,
  files: { "index.html": page(GOOD) },
  exit: 2,
  out: /landing: BLIND, cannot read .*index\.html/,
  skipIf: cannotDenyReads,
  setup: (r) => chmodSync(join(r, "index.html"), 0o000),
  after: (r) => chmodSync(join(r, "index.html"), 0o644),
});
add({ name: "blind-landing-node-absent", tool: LANDING, files: { "index.html": page(GOOD) }, exit: 2, out: /landing: BLIND, node is not on PATH/, spawn: withoutNode });
add({ name: "blind-landing-engine-absent", tool: LANDING, files: { "index.html": page(GOOD) }, exit: 2, out: /landing: BLIND, .*landing\.mjs is missing or unreadable/, spawn: withoutEngine });

// ---------------------------------------------------------------- runner

// The node that runs this file is the one the entry points use, wherever PATH points.
function nodeEnv() {
  return { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? "") };
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (content === null) mkdirSync(path, { recursive: true });
    else if (typeof content === "object" && !Buffer.isBuffer(content)) symlinkSync(content.symlink, path);
    else writeFileSync(path, content);
  }
}

function execute(c, work) {
  const dir = join(work, c.name);
  const root = join(dir, "site");
  mkdirSync(root, { recursive: true });
  writeTree(root, c.files);
  try {
    c.setup?.(root);
    const target = c.root ? c.root(root, dir) : root;
    const args = { tool: c.tool, target, dir };
    return c.spawn ? c.spawn(args) : spawnSync("sh", [c.tool, target], { encoding: "utf8", env: nodeEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  } finally {
    c.after?.(root);
  }
}

function main() {
  for (const tool of [NTP, LANDING]) {
    if (!existsSync(tool)) throw new Blind(`${tool} does not exist, so no case could run`);
  }
  const seen = new Set();
  for (const c of CASES) {
    if (seen.has(c.name)) throw new Blind(`two cases are called ${c.name}`);
    seen.add(c.name);
  }

  const work = mkdtempSync(join(tmpdir(), "linkling-web-selftest-"));
  const mismatches = [];
  let skipped = 0;
  let ran = 0;
  try {
    for (const c of CASES) {
      const why = c.skipIf?.() ?? null;
      if (why) {
        skipped += 1;
        console.log(`  skipped ${c.name}: ${why}`);
        continue;
      }
      const r = execute(c, work);
      if (r.error && r.error.code !== "ETIMEDOUT") throw new Blind(`could not run ${c.name}: ${r.error.message}`);
      ran += 1;
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const problems = [];
      if (r.error) problems.push(`timed out after ${TIMEOUT_MS} ms`);
      else if (r.status !== c.exit) problems.push(`exit ${r.status}, wanted ${c.exit}`);
      if (!r.error && !c.out.test(output)) problems.push(`output does not match ${c.out}`);
      // The entry points merge the engine's stderr into what they print, so a warning shows
      // up as a second line: a passing run says exactly one thing, on stdout.
      if (!r.error && c.quiet && ((r.stderr ?? "") !== "" || (r.stdout ?? "").split("\n").filter(Boolean).length !== 1)) {
        problems.push("a passing run must print exactly one line, and nothing on stderr");
      }
      if (problems.length > 0) {
        mismatches.push(c.name);
        console.log(`MISMATCH ${c.name}: ${problems.join("; ")}`);
        for (const line of output.split("\n").filter(Boolean).slice(0, 3)) console.log(`      ${line.slice(0, 200)}`);
      } else if (process.env.VERBOSE) {
        console.log(`  ok ${c.name} (exit ${r.status})`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (mismatches.length > 0) {
    console.log(`selftest: FAIL, ${mismatches.length} of ${ran} cases did not match (${skipped} skipped)`);
    return 1;
  }
  console.log(`selftest: PASS, ${ran} cases matched (${skipped} skipped)`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.log(`selftest: BLIND, ${e instanceof Blind ? e.message : e.stack}`);
  process.exitCode = 2;
}
