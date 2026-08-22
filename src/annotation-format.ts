/**
 * annotation-format.ts — pure presentation helpers shared by the custom view,
 * the native overlay, and the annotations side panel. No Obsidian imports so
 * the smoke tests can exercise them headlessly.
 */
import { MARK_STYLE_LABELS, markStyleOf, type Highlight } from "./annotations";

export function annotationTypeOf(h: Highlight): "highlight" | "tag" {
  return h.type === "tag" ? "tag" : "highlight";
}

export function annotationColor(h: Highlight): string {
  return h.tagColor ?? h.color;
}

export function tagPreview(h: Highlight): string {
  const raw = (h.note || h.text || "Note").replace(/\bnote:\s*/gi, " ").replace(/\s+/g, " ").trim();
  const words = raw.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  return words || "Note";
}

export function annotationKindLabel(h: Highlight): string {
  if (annotationTypeOf(h) === "tag") return "tag";
  const st = markStyleOf(h);
  return st === "highlight" ? "highlight" : MARK_STYLE_LABELS[st].toLowerCase();
}

export function shortAnnotationText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  if (max <= 1) return "…";
  // Slice by code POINT: cutting between surrogates emits a lone half that
  // renders as U+FFFD, which any emoji or astral CJK on the boundary triggers.
  let cut = max - 1;
  const code = clean.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return clean.slice(0, cut) + "…";
}

export function rollPrimaryText(h: Highlight): string {
  const text = (h.note || h.noteContentCJK || h.text || tagPreview(h)).replace(/\s+/g, " ").trim();
  return shortAnnotationText(text || "Untitled note", 160);
}

export function rollSecondaryText(h: Highlight): string {
  const chunks: string[] = [];
  if (h.note && h.noteContentCJK) chunks.push(h.noteContentCJK);
  // The quoted words appear as context only when a NOTE is the primary line;
  // without one the primary already IS the quote — never show it twice.
  if (annotationTypeOf(h) === "highlight" && h.text && (h.note || h.noteContentCJK)) {
    chunks.push(h.text);
  }
  return shortAnnotationText(chunks.join("  "), 180);
}

export function normalizeSearch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function annotationMatchesSearch(h: Highlight, query: string): boolean {
  const haystack = [
    `p.${h.page + 1}`,
    String(h.page + 1),
    annotationKindLabel(h),
    h.note,
    h.noteContentCJK,
    h.text,
    tagPreview(h),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return query.split(" ").every((part) => haystack.includes(part));
}
