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
assert.equal(safeUrl("app://local/x.png"), true, "Obsidian resource URLs pass");

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

console.log("html sanitize smoke test passed");
