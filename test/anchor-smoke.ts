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

// --- accents distinguish words, they are not folded away -------------------
// Folding marks would merge genuinely different words. These must NOT match.
assert.notEqual(normStr("côte"), normStr("cote"), "French côte/cote stay distinct");
assert.notEqual(normStr("tồi"), normStr("tôi"), "Vietnamese tồi/tôi stay distinct");
assert.notEqual(normStr("мой"), normStr("мои"), "Russian мой/мои stay distinct");
// Keeping the marks also keeps the link PRECISE: "côte" resolves to the
// accented occurrence rather than colliding with "cote" earlier in the line.
const homograph = findSelectionInChunks(
  ["la cote du marche baisse, mais la côte est belle"],
  "côte"
);
assert.ok(homograph, "an accented word still links");
assert.equal(homograph!.beginOffset, 34, "and it points at the accented occurrence");

// Non-Latin composition forms must also meet, since macOS hands over NFD.
assert.equal(normStr("が"), normStr("が"), "Japanese dakuten: both forms normalize alike");
assert.equal(normStr("한"), normStr("한"), "Hangul: precomposed and jamo normalize alike");

// --- context disambiguates when the tail alone cannot ----------------------
// Both occurrences share ", section two, " — only the earlier words differ, so
// a scorer that looks at just the innermost characters ties and guesses.
const chapters = [
  "see chapter one, section two, the theory of value, and note the caveat. " +
    "see chapter two, section two, the theory of value, and note the caveat.",
];
const wanted = findSelectionInChunks(
  chapters,
  "the theory of value",
  "see chapter two, section two, ",
  ", and note"
);
assert.ok(wanted, "a quote with distinguishing context still links");
assert.ok(
  wanted!.beginOffset > 60,
  "and it resolves to the SECOND occurrence, the one the context describes"
);

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

// A ligature is length-neutral after normalization, so this matches in pass 1
// (it does NOT exercise the drift fallback — normalization already handles it).
const drifted = "the ﬁrst deﬁnition of the term appears in the preface";
const asTyped = "the first definition of the term appears in the preface";
assert.equal(normStr(drifted), normStr(asTyped), "ligatures normalize to the same string");
assert.ok(findSelectionInChunks([drifted], asTyped), "ligature drift still anchors");

// The real job of the drift fallback: a quote broken by page furniture. The
// running header and folio land between the halves in the document string.
const crossPage =
  "the argument developed in the preceding section now requires " +
  "347 The Journal of Philosophy " +
  "a considerably more careful statement than it has so far received";
const quoted =
  "the argument developed in the preceding section now requires " +
  "a considerably more careful statement than it has so far received";
assert.ok(
  findSelectionInChunks([crossPage], quoted),
  "a quote split by a running header still anchors through the drift fallback"
);

console.log("anchor smoke test passed");
