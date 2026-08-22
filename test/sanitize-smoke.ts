/**
 * sanitize-smoke.ts — the HTML reader's security boundary.
 *
 * Every case here is a bypass that a previous denylist sanitizer let through.
 * The reader renders into Obsidian's live Electron renderer, so a pass here is
 * the difference between a highlight and arbitrary local code execution.
 */
import assert from "node:assert";
import {
  attributeIsUnsafe,
  sanitizeDocument,
  FORBIDDEN_ELEMENTS,
  safeSrcset,
  safeUrl,
} from "../src/sanitize-html";

// --- scheme normalization -------------------------------------------------
// The URL parser drops ASCII whitespace/control chars from inside a scheme, so
// these all navigate exactly like "javascript:".
assert.equal(safeUrl("javascript:alert(1)"), false, "plain javascript: is blocked");
assert.equal(safeUrl("java\tscript:alert(1)"), false, "tab inside the scheme is blocked");
assert.equal(safeUrl("java\nscript:alert(1)"), false, "newline inside the scheme is blocked");
assert.equal(safeUrl("java\rscript:alert(1)"), false, "CR inside the scheme is blocked");
assert.equal(safeUrl("java\0script:alert(1)"), false, "NUL inside the scheme is blocked");
assert.equal(safeUrl("  JaVaScRiPt:alert(1)"), false, "leading space + mixed case is blocked");
assert.equal(safeUrl("vbscript:msgbox(1)"), false, "unknown schemes are blocked by default");

// Safe forms still pass — the reader must stay useful.
assert.equal(safeUrl("https://example.com/a.png"), true, "https passes");
assert.equal(safeUrl("images/fig1.png"), true, "relative paths pass");
assert.equal(safeUrl("#section-2"), true, "fragments pass");
assert.equal(safeUrl("mailto:someone@example.com"), true, "mailto passes");
// app:/blob: are deliberately NOT allowed: the reader writes the app:// path
// for local images itself, after sanitization, so any that reach the sanitizer
// were author-written — and app:// can address absolute local paths.
assert.equal(safeUrl("app://local/etc/passwd"), false, "author-written app: URLs are blocked");
assert.equal(safeUrl("blob:https://x/y"), false, "author-written blob: URLs are blocked");

// data: is raster-only — data:text/html and data:image/svg+xml are scriptable.
assert.equal(safeUrl("data:image/png;base64,iVBORw0KGgo="), true, "data raster passes");
assert.equal(safeUrl("data:text/html,<script>alert(1)</script>"), false, "data:text/html blocked");
assert.equal(safeUrl("data:image/svg+xml,<svg onload=alert(1)>"), false, "data svg blocked");

// --- srcset: every candidate is checked, not just the first ---------------
assert.equal(safeSrcset("a.png 1x, b.png 2x"), true, "all-relative srcset passes");
// srcset separates the URL from its descriptor on ASCII whitespace, so a
// candidate can never carry an embedded tab; what matters is that a LATER
// candidate is checked at all, not just the first.
assert.equal(
  safeSrcset("a.png 1x, javascript:alert(1) 2x"),
  false,
  "a poisoned later srcset candidate is caught"
);
// Tokenizing on whitespace (as the real parser does) keeps comma-bearing data
// URLs intact instead of splitting them into nonsense.
assert.equal(
  safeSrcset("data:image/png;base64,iVBORw0KGgo= 1x"),
  true,
  "a data URL containing a comma is one candidate, not two"
);

// --- attribute filtering ---------------------------------------------------
assert.equal(attributeIsUnsafe("onclick", "onclick", "alert(1)"), true, "on* handlers removed");
assert.equal(attributeIsUnsafe("ONCLICK", "ONCLICK", "alert(1)"), true, "on* is case-insensitive");
assert.equal(
  attributeIsUnsafe("xlink:href", "href", "java\tscript:alert(1)"),
  true,
  "namespaced href is filtered by LOCAL name"
);
assert.equal(
  attributeIsUnsafe("xl:href", "href", "javascript:alert(1)"),
  true,
  "any xlink prefix is covered"
);
assert.equal(attributeIsUnsafe("ping", "ping", "https://tracker.example"), false, "ping http ok");
assert.equal(attributeIsUnsafe("href", "href", "notes/other.html"), false, "relative href kept");
assert.equal(attributeIsUnsafe("title", "title", "javascript:"), false, "non-URL attrs untouched");

// Inline styles: remote fetches and app-covering overlays are dropped.
assert.equal(
  attributeIsUnsafe("style", "style", "background-image:url(https://evil.example/t.png)"),
  true,
  "url() in inline style is dropped (silent tracking beacon)"
);
assert.equal(
  attributeIsUnsafe("style", "style", "position:fixed;top:0;left:0;width:100vw;height:100vh"),
  true,
  "fixed-position overlay is dropped (clickjacking over Obsidian's own UI)"
);
assert.equal(
  attributeIsUnsafe("style", "style", "color: #c678dd; font-weight: bold"),
  false,
  "ordinary inline styling survives"
);

// --- elements that can write attributes at runtime -------------------------
// SMIL can animate a javascript: URL into an href AFTER sanitization, so the
// serialized markup never contains a filterable value.
for (const el of ["animate", "set", "animatetransform", "animatemotion", "discard"]) {
  assert.ok(FORBIDDEN_ELEMENTS.has(el), `<${el}> is removed (can write href at runtime)`);
}
for (const el of ["script", "style", "iframe", "object", "embed", "link", "base", "form"]) {
  assert.ok(FORBIDDEN_ELEMENTS.has(el), `<${el}> is removed`);
}
for (const el of ["use", "foreignobject"]) {
  assert.ok(FORBIDDEN_ELEMENTS.has(el), `<${el}> is removed (pulls in referenced content)`);
}


// --- sanitizeDocument itself ------------------------------------------------
// The suite previously only tested the decision helpers, so swapping localName
// for tagName, or dropping the removeAttributeNode call, stayed green. Drive
// the real function through a minimal DOM standing in for the parsed document.
class FakeAttr {
  constructor(public name: string, public value: string) {}
  get localName(): string {
    return this.name.includes(":") ? this.name.split(":")[1] : this.name;
  }
}
class FakeEl {
  attributes: FakeAttr[] = [];
  children: FakeEl[] = [];
  removed = false;
  constructor(public localName: string, attrs: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(attrs)) this.attributes.push(new FakeAttr(k, v));
  }
  remove(): void {
    this.removed = true;
  }
  removeAttributeNode(attr: FakeAttr): void {
    this.attributes = this.attributes.filter((a) => a !== attr);
  }
  setAttribute(name: string, value: string): void {
    const found = this.attributes.find((a) => a.name === name);
    if (found) found.value = value;
    else this.attributes.push(new FakeAttr(name, value));
  }
  attr(name: string): string | undefined {
    return this.attributes.find((a) => a.name === name)?.value;
  }
}

const els = [
  new FakeEl("p", { style: "color:#333", title: "javascript:not-a-url" }),
  new FakeEl("script", {}),
  new FakeEl("SET", { attributeName: "href", to: "javascript:alert(1)" }),
  new FakeEl("a", { href: "java\tscript:alert(1)" }),
  new FakeEl("a", { "xlink:href": "javascript:alert(1)" }),
  new FakeEl("img", { src: "pic.png", onerror: "alert(1)" }),
];
const fakeDoc = {
  querySelectorAll: () => els,
  // The CSSOM re-check needs a probe element; without a real one the style
  // attribute is simply left to the text-regex verdict.
  createElement: () => {
    throw new Error("no CSSOM in the test DOM");
  },
} as unknown as Document;

sanitizeDocument(fakeDoc);

assert.equal(els[1].removed, true, "<script> is removed");
assert.equal(els[2].removed, true, "<SET> is removed case-insensitively by local name");
assert.equal(els[0].removed, false, "ordinary elements survive");
assert.equal(els[3].attr("href"), undefined, "tab-in-scheme href is stripped");
assert.equal(els[4].attr("xlink:href"), undefined, "namespaced href is stripped by local name");
assert.equal(els[5].attr("onerror"), undefined, "event handler attribute is stripped");
assert.equal(els[5].attr("src"), "pic.png", "a safe relative src survives");
assert.equal(els[0].attr("title"), "javascript:not-a-url", "non-URL attributes are untouched");
assert.equal(
  els[0].attr("style"),
  undefined,
  "an unverifiable style is dropped rather than trusted"
);

console.log("html sanitize smoke test passed");
