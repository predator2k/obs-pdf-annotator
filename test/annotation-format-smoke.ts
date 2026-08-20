import assert from "node:assert/strict";
import {
  annotationColor,
  annotationKindLabel,
  annotationMatchesSearch,
  annotationTypeOf,
  normalizeSearch,
  rollPrimaryText,
  rollSecondaryText,
  shortAnnotationText,
  tagPreview,
} from "../src/annotation-format";
import type { Highlight } from "../src/annotations";

function mark(overrides: Partial<Highlight>): Highlight {
  return {
    id: "h1",
    page: 4,
    color: "#FBF719",
    text: "the quoted passage",
    rects: [],
    created: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function main(): void {
  assert.equal(annotationTypeOf(mark({})), "highlight");
  assert.equal(annotationTypeOf(mark({ type: "tag" })), "tag");
  assert.equal(annotationColor(mark({ tagColor: "#123456" })), "#123456");
  assert.equal(annotationColor(mark({})), "#FBF719");

  assert.equal(annotationKindLabel(mark({})), "highlight");
  assert.equal(annotationKindLabel(mark({ style: "underline" })), "underline");
  assert.equal(annotationKindLabel(mark({ type: "tag" })), "tag");

  assert.equal(shortAnnotationText("  a   b  ", 10), "a b");
  assert.equal(shortAnnotationText("abcdefghij", 5), "abcd…");

  assert.equal(tagPreview(mark({ note: "one two three four five six" })), "one two three four five");
  assert.equal(tagPreview(mark({ note: "", text: "" })), "Note");

  assert.equal(rollPrimaryText(mark({ note: "my note" })), "my note");
  assert.equal(rollPrimaryText(mark({})), "the quoted passage");
  assert.equal(
    rollSecondaryText(mark({ note: "my note" })),
    "the quoted passage",
    "quoted source shows as secondary when a note exists"
  );
  assert.equal(
    rollSecondaryText(mark({})),
    "",
    "no note means the primary line is the quote — never repeat it"
  );

  assert.equal(normalizeSearch("  Foo   BAR "), "foo bar");
  assert.ok(annotationMatchesSearch(mark({ note: "Kant on synthesis" }), "kant p.5"));
  assert.ok(!annotationMatchesSearch(mark({ note: "Kant on synthesis" }), "hegel"));

  console.log("annotation format smoke test passed");
}

main();
