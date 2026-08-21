/**
 * pdf-link.ts — locate a highlight's quoted text inside a page's text-item
 * chunks and express it as Obsidian's NATIVE PDF link subpath:
 *
 *   #page=N&selection=beginIndex,beginOffset,endIndex,endOffset
 *
 * beginIndex/endIndex are indices into the rendered text layer's item array
 * (the caller supplies `chunks` with matching indices — holes and empty
 * strings preserve positions); offsets are raw character offsets into the
 * item's string; endOffset is EXCLUSIVE, matching DOM Range semantics.
 *
 * Core Obsidian resolves these links (scroll + flash highlight) with no
 * plugin installed, which is the whole point: a citation that outlives us.
 *
 * Pure module — no Obsidian imports — so the smoke tests run headless.
 */
import { contextScore, findBestMatch, normChar, normStr } from "./anchor";

export interface SelectionSubpath {
  beginIndex: number;
  beginOffset: number;
  endIndex: number;
  endOffset: number; // exclusive
}

interface ChunkPos {
  chunk: number;
  ch: number; // raw char offset of the source character within its chunk
}

function buildSearch(chunks: string[]): { search: string; map: ChunkPos[] } {
  let search = "";
  const map: ChunkPos[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const str = chunks[idx] ?? "";
    let ch = 0;
    for (const c of str) {
      const n = normChar(c);
      for (let k = 0; k < n.length; k++) {
        search += n[k];
        map.push({ chunk: idx, ch });
      }
      ch += c.length;
    }
  }
  return { search, map };
}

/** Exclusive end offset for the raw character starting at `ch` in `chunk`. */
function rawCharEnd(chunk: string, ch: number): number {
  const cp = chunk.codePointAt(ch);
  return ch + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

function spanToSubpath(
  chunks: string[],
  map: ChunkPos[],
  start: number,
  end: number
): SelectionSubpath | null {
  const first = map[start];
  const last = map[end];
  if (!first || !last) return null;
  // A selection subpath cannot express a cross-page span; a cross-CHUNK span
  // on one page is fine, that's what begin/end indices are for.
  return {
    beginIndex: first.chunk,
    beginOffset: first.ch,
    endIndex: last.chunk,
    endOffset: rawCharEnd(chunks[last.chunk] ?? "", last.ch),
  };
}

/**
 * Locate `exact` inside the chunks, disambiguating repeated passages with
 * prefix/suffix context. Whole-string match first; then a head+tail span match
 * that tolerates internal extraction drift (ligatures, hyphenation). Returns
 * null when no confident match exists — the caller should then fall back to a
 * page-only link rather than risk a wrong one.
 */
export function findSelectionInChunks(
  chunks: string[],
  exact: string,
  prefix?: string,
  suffix?: string
): SelectionSubpath | null {
  const { search, map } = buildSearch(chunks);
  const needle = normStr(exact);
  if (needle.length < 2) return null;
  const nPrefix = prefix ? normStr(prefix) : undefined;
  const nSuffix = suffix ? normStr(suffix) : undefined;

  // --- Pass 1: whole-string match, best disambiguated occurrence ---
  const best = findBestMatch(search, needle, nPrefix, nSuffix);
  if (best) return spanToSubpath(chunks, map, best.start, best.end);

  // --- Pass 2: head + tail span fallback (handles internal drift) ---
  const hlen = Math.min(40, Math.max(12, Math.floor(needle.length * 0.35)));
  if (needle.length < hlen) return null;
  const head = needle.slice(0, hlen);
  const tail = needle.slice(-hlen);
  const lo = needle.length * 0.6;
  const hi = needle.length * 1.6;
  let fb: { start: number; end: number; score: number } | null = null;
  let from = 0;
  for (;;) {
    const h = search.indexOf(head, from);
    if (h < 0) break;
    const t = search.indexOf(tail, h + head.length - 1);
    if (t >= 0) {
      const end = t + tail.length - 1;
      const span = end - h + 1;
      if (span >= lo && span <= hi) {
        const score = contextScore(search, h, end, nPrefix, nSuffix);
        if (!fb || score > fb.score) fb = { start: h, end, score };
      }
    }
    from = h + 1;
  }
  if (fb) return spanToSubpath(chunks, map, fb.start, fb.end);

  return null;
}

/** Obsidian-native subpath: page-only when no selection could be anchored. */
export function subpathForHighlight(page0: number, sel: SelectionSubpath | null): string {
  const page = `#page=${page0 + 1}`;
  if (!sel) return page;
  return `${page}&selection=${sel.beginIndex},${sel.beginOffset},${sel.endIndex},${sel.endOffset}`;
}

/**
 * Obsidian-native subpath for a free-form page note: an XYZ scroll destination
 * (`offset=left,top,zoom`; zoom 0 keeps the reader's current zoom). Inputs are
 * the note's position as PERCENTAGES of the page box (x right, y down from the
 * top-left, as stored on tags) plus the page size in PDF points.
 */
export function subpathForPageNote(
  page0: number,
  tagXPct: number,
  tagYPct: number,
  pageWidthPts: number,
  pageHeightPts: number
): string {
  const left = Math.round((tagXPct / 100) * pageWidthPts);
  // XYZ destinations measure `top` in PDF user space (y-up from the bottom).
  const top = Math.round((1 - tagYPct / 100) * pageHeightPts);
  return `#page=${page0 + 1}&offset=${left},${top},0`;
}
