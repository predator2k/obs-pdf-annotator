import assert from "node:assert/strict";
import { findSelectionInChunks, subpathForHighlight, subpathForPageNote } from "../src/pdf-link";

function main(): void {
  // Match inside a single chunk; offsets are raw (whitespace dropped only in
  // the normalized search space, never in the reported offsets).
  {
    const sel = findSelectionInChunks(["Hello world, this is fine."], "world, this");
    assert.deepEqual(sel, { beginIndex: 0, beginOffset: 6, endIndex: 0, endOffset: 17 });
  }

  // Match spanning two chunks.
  {
    const sel = findSelectionInChunks(["The quick brown ", "fox jumps"], "brown fox");
    assert.deepEqual(sel, { beginIndex: 0, beginOffset: 10, endIndex: 1, endOffset: 3 });
  }

  // Empty chunks preserve indices (holes stand for non-string text items).
  {
    const sel = findSelectionInChunks(["alpha", "", "beta"], "alpha beta");
    assert.deepEqual(sel, { beginIndex: 0, beginOffset: 0, endIndex: 2, endOffset: 4 });
  }

  // Line-break hyphenation differences are normalized away.
  {
    const sel = findSelectionInChunks(["exam-", "ple text"], "example text");
    assert.deepEqual(sel, { beginIndex: 0, beginOffset: 0, endIndex: 1, endOffset: 8 });
  }

  // Duplicate passages disambiguated by prefix/suffix context.
  {
    const chunks = ["the cat sat on the mat. ", "later, the cat sat on the chair."];
    const first = findSelectionInChunks(chunks, "the cat sat", undefined, "on the mat");
    assert.equal(first?.beginIndex, 0);
    const second = findSelectionInChunks(chunks, "the cat sat", "later, ", "on the chair");
    assert.equal(second?.beginIndex, 1);
    assert.equal(second?.beginOffset, 7);
  }

  // Astral (surrogate-pair) characters keep raw offsets; exclusive end covers
  // the full pair when the match ends on one.
  {
    const endOnAstral = findSelectionInChunks(["a\u{1D4B3}b"], "a\u{1D4B3}");
    assert.deepEqual(endOnAstral, { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 3 });
    const startAfterAstral = findSelectionInChunks(["a\u{1D4B3}b"], "\u{1D4B3}b");
    assert.deepEqual(startAfterAstral, { beginIndex: 0, beginOffset: 1, endIndex: 0, endOffset: 4 });
  }

  // CJK text (no whitespace) matches with exact offsets.
  {
    const sel = findSelectionInChunks(["深度学习", "模型训练"], "学习模型");
    assert.deepEqual(sel, { beginIndex: 0, beginOffset: 2, endIndex: 1, endOffset: 2 });
  }

  // Head+tail fallback bridges internal extraction drift.
  {
    const stored = "The committee recommended immediate adoption of the framework across departments";
    const drifted = ["The committee recommended immed. adoption of the framework across departments"];
    const sel = findSelectionInChunks(drifted, stored);
    assert.ok(sel, "drifted passage still anchors via head+tail");
    assert.equal(sel!.beginIndex, 0);
    assert.equal(sel!.beginOffset, 0);
  }

  // No match and too-short needles return null instead of guessing.
  assert.equal(findSelectionInChunks(["some page text"], "entirely absent passage"), null);
  assert.equal(findSelectionInChunks(["some page text"], "s"), null);
  assert.equal(findSelectionInChunks([], "anything at all"), null);

  // Subpath formatting: 1-based page, exclusive end offset, page-only fallback.
  assert.equal(subpathForHighlight(4, null), "#page=5");
  assert.equal(
    subpathForHighlight(0, { beginIndex: 2, beginOffset: 1, endIndex: 3, endOffset: 7 }),
    "#page=1&selection=2,1,3,7"
  );

  // Free-form page notes link via XYZ scroll destinations: percentages of the
  // page box become PDF points, with top measured y-up from the page bottom.
  assert.equal(subpathForPageNote(2, 50, 25, 612, 792), "#page=3&offset=306,594,0");
  assert.equal(subpathForPageNote(0, 0, 0, 612, 792), "#page=1&offset=0,792,0");
  assert.equal(subpathForPageNote(0, 100, 100, 612, 792), "#page=1&offset=612,0,0");

  console.log("pdf link smoke test passed");
}

main();
