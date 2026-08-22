/**
 * anchor-smoke.ts — the shared text-anchoring core.
 *
 * These functions decide where a highlight lands and which words a copied link
 * points at, so a wrong answer here is silently wrong data, not a crash.
 */
import assert from "node:assert";
import { findBestMatch, findDriftSpan, normChar, normStr } from "../src/anchor";
import { findSelectionInChunks } from "../src/pdf-link";

// --- normalization ---------------------------------------------------------
assert.equal(normStr("The  quick\nbrown"), "thequickbrown", "whitespace is dropped");
assert.equal(normStr("co-\noperate"), "cooperate", "line-break hyphenation is dropped");
assert.equal(normStr("“quoted”"), '"quoted"', "curly quotes fold to ASCII");
assert.equal(normChar("­"), "", "soft hyphen dropped");

// Invisible bidi/format controls must not block a match: a PDF text layer and
// a copied quote rarely agree on them.
assert.equal(normChar("‎"), "", "LRM dropped");
assert.equal(normChar("‏"), "", "RLM dropped");
assert.equal(normChar("‪"), "", "LRE dropped");
assert.equal(normChar("⁦"), "", "LRI dropped");
assert.equal(normChar("⁠"), "", "word joiner dropped");
assert.equal(normStr("abc‎def"), "abcdef", "a bidi mark mid-word still anchors");
assert.ok(
  findSelectionInChunks(["abc‎def ghi"], "abcdef"),
  "text containing a bidi mark is locatable"
);

// --- composition forms must match each other -------------------------------
// The same word can reach us precomposed (U+00E9) or decomposed (e + U+0301)
// depending on how the PDF was produced and how the quote was copied.
const precomposed = "café résumé";
const decomposed = "café résumé";
assert.equal(normStr(precomposed), normStr(decomposed), "both composition forms normalize alike");
assert.ok(
  findSelectionInChunks([decomposed], precomposed),
  "a precomposed quote anchors in decomposed page text"
);
assert.ok(
  findSelectionInChunks([precomposed], decomposed),
  "a decomposed quote anchors in precomposed page text"
);

// --- empty needle must not hang the UI thread ------------------------------
// "abcabc".indexOf("", 7) clamps to 6 instead of returning -1, which makes the
// occurrence scan a fixed point.
assert.equal(findBestMatch("abcabc", ""), null, "empty needle returns null, not a hang");
assert.equal(findDriftSpan("abcabc", ""), null, "empty needle has no drift span");

// --- repeated passages are reported as ambiguous ---------------------------
const repeated = findBestMatch("alphabetagamma.filler.alphabetagamma", "alphabetagamma");
assert.ok(repeated, "a repeated passage still matches");
assert.equal(repeated!.ambiguous, true, "two equally-scored occurrences are flagged ambiguous");
assert.equal(
  findSelectionInChunks(["alpha beta gamma. filler. alpha beta gamma."], "alpha beta gamma"),
  null,
  "an ambiguous quote degrades to a page link instead of guessing an occurrence"
);

// Context resolves the ambiguity, and then the link is emitted.
const disambiguated = findSelectionInChunks(
  ["alpha beta gamma. filler. alpha beta gamma."],
  "alpha beta gamma",
  "filler. "
);
assert.ok(disambiguated, "prefix context picks an occurrence");
assert.equal(disambiguated!.beginOffset, 26, "and it is the SECOND occurrence, not the first");

// A unique quote is never ambiguous.
const unique = findBestMatch("onlyoncehere", "once");
assert.ok(unique && !unique.ambiguous, "a single occurrence is unambiguous");

// --- the drift fallback must not swallow unselected material ---------------
const quote =
  "In the second chapter the author develops a theory of value that explains " +
  "how labour time becomes the measure of exchange in a market society";
const inserted =
  "In the second chapter the author develops a theory of value that explains " +
  " XXXXXXXXXX INSERTED DRIFT MATERIAL THAT WAS NEVER SELECTED XXXXXXXXXX " +
  "how labour time becomes the measure of exchange in a market society";
assert.equal(
  findSelectionInChunks([inserted], quote),
  null,
  "a head/tail pair separated by unselected material is rejected, not linked"
);

// Genuine minor drift (a ligature expanding) still anchors through the fallback.
const drifted = "the ﬁrst deﬁnition of the term appears in the preface";
const asTyped = "the first definition of the term appears in the preface";
assert.ok(findSelectionInChunks([drifted], asTyped), "ligature drift still anchors");

console.log("anchor smoke test passed");
