import assert from "node:assert/strict";
import {
  DEFAULT_PALETTE,
  PALETTE,
  defaultColor,
  derivePaletteEntry,
  resolvePalette,
  setActivePalette,
} from "../src/annotations";
import { deriveEmoji, markInkColor } from "../src/color";

function main(): void {
  // Derived entries compute ink/emoji/cardFill from the fill alone.
  const teal = derivePaletteEntry("teal", "#00b3a4");
  assert.equal(teal.name, "teal");
  assert.equal(teal.ink, markInkColor("#00b3a4"));
  assert.equal(teal.emoji, deriveEmoji("#00b3a4"));
  assert.ok(teal.cardFill?.startsWith("rgba("));

  // Emoji derivation lands in sane hue buckets.
  assert.equal(deriveEmoji("#ff0000"), "🟥");
  assert.equal(deriveEmoji("#fbf719"), "🟨");
  assert.equal(deriveEmoji("#2277ff"), "🟦");
  assert.equal(deriveEmoji("#22cc44"), "🟩");
  assert.equal(deriveEmoji("#a28ae5"), "🟪", "Zotero purple buckets as purple");
  assert.equal(deriveEmoji("#2ea8e5"), "🟦", "Zotero blue buckets as blue");
  assert.equal(deriveEmoji("#aaaaaa"), "⬜", "Zotero gray buckets as light neutral");

  // The live palette swaps in place; resolvePalette and defaultColor follow.
  setActivePalette([teal, derivePaletteEntry("plum", "#8844aa")]);
  assert.equal(PALETTE.length, 2);
  assert.equal(defaultColor(), "#00b3a4");
  assert.equal(resolvePalette("#00b3a4")?.name, "teal");
  assert.equal(resolvePalette(DEFAULT_PALETTE[1].fill), null, "removed colors resolve as custom");

  // Legacy fills only resolve while a same-named entry exists.
  setActivePalette([]);
  assert.equal(PALETTE.length, DEFAULT_PALETTE.length, "empty palette restores defaults");
  assert.equal(resolvePalette("rgba(255, 214, 0, 0.40)")?.name, "yellow", "legacy fill maps to yellow");
  assert.equal(defaultColor(), DEFAULT_PALETTE[0].fill);

  console.log("palette smoke test passed");
}

main();
