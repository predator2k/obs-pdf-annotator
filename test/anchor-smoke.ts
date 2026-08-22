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
assert.deepEqual(
  findSelectionInChunks(["abc\u200Edef ghi"], "abcdef"),
  { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 7 },
  "a bidi mark is skipped and raw offsets still cover it"
);
// One raw character can expand to several normalized slots; the map back to raw
// offsets is where that most easily goes wrong.
assert.deepEqual(
  findSelectionInChunks(["\uAC00\uAC01\uAC02"], "\uAC01"),
  { beginIndex: 0, beginOffset: 1, endIndex: 0, endOffset: 2 },
  "Hangul: 1 raw char -> 3 index slots, offsets stay raw"
);
assert.deepEqual(
  findSelectionInChunks(["a\uFB01b"], "afi"),
  { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 2 },
  "a ligature expands to two slots but occupies one raw unit"
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
// Both sides are written with explicit escapes: a literal decomposed string in
// this file gets silently re-composed by editors, which turned these into
// assertions that a value equals itself and passed with normStr stubbed out.
assert.equal(
  normStr("\u304B\u3099"),
  normStr("\u304C"),
  "Japanese dakuten: decomposed か+゛ matches precomposed が"
);
assert.equal(
  normStr("\u1112\u1161\u11AB"),
  normStr("\uD55C"),
  "Hangul: decomposed jamo matches the precomposed syllable"
);
// U+1ED3 is o-with-circumflex-and-grave, so the decomposed form is o + U+0302 + U+0300.
assert.equal(
  normStr("o\u0302\u0300i"),
  normStr("\u1ED3i"),
  "Vietnamese: stacked marks decompose to the same sequence"
);
// NFKD emits a SPACE for some compatibility characters (U+00B4 -> space +
// combining acute); the search string is documented whitespace-free.
assert.equal(normStr("a\u00B4b"), "a\u0301b", "an acute accent character keeps only its mark");

// Compatibility forms decompose INTO characters the rules drop, so the rules
// must run after decomposition, not before.
assert.equal(
  normStr("\u7814\u7A76\uFF0D\u958B\u767A"),
  normStr("\u7814\u7A76-\u958B\u767A"),
  "a fullwidth hyphen is dropped like an ASCII one"
);

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

// A SHORT quote must not anchor onto a span several times its length: the
// allowance has to scale with the quote, not be a flat constant.
assert.equal(
  findSelectionInChunks(
    ["the rate of surplus value is the ratio of unpaid to paid labour in production today"],
    "surplus value in production"
  ),
  null,
  "a 27-character quote does not anchor onto a 65-character span"
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
