/**
 * anchor.ts — locate a text quote inside a rendered PDF and return its page(s) +
 * PDF-user-space rectangles. Used to migrate legacy obsidian-annotator
 * highlights, which store only quoted text (no coordinates).
 *
 * Approach mirrors hypothes.is text-quote anchoring: build a normalized,
 * whitespace-stripped search string with a char->(page,item,char) map, locate
 * the quote, then reconstruct line rectangles from the participating text items'
 * geometry. We index the whole document into one concatenated string so a
 * selection that spans a page boundary still matches (it is then split back into
 * one rect-set per page). Because the legacy `exact` strings came from a
 * different pdf.js version, long passages can diverge by a character or two
 * (ligatures, curly quotes, hyphenation), so we normalize aggressively and fall
 * back to a head+tail span match when a whole-string match fails.
 *
 * Geometry is emitted in PDF user space (origin bottom-left, y-up), identical to
 * viewport.convertToPdfPoint for live selections, so imported and manual
 * highlights render through one code path.
 */
import type { PdfRect } from "./annotations";

interface ItemBox {
  str: string;
  x: number; // baseline-left x in PDF user space (transform[4])
  y: number; // baseline y in PDF user space (transform[5])
  w: number; // advance width in PDF units
  h: number; // glyph height (font size) in PDF units
}

interface PageData {
  page: number; // 0-based
  items: ItemBox[];
}

interface GPos {
  page: number;
  item: number;
  ch: number;
}

export interface DocIndex {
  pages: PageData[];
  search: string; // normalized, whitespace-stripped text for the whole document
  map: GPos[]; // search index -> (page, item, char-in-item)
}

/** Per-character normalization. Returns "" to drop the char, or 1+ chars. */
export function normChar(c: string): string {
  if (/\s/.test(c)) return "";
  const code = c.charCodeAt(0);
  if (code === 0x00ad || code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff)
    return "";
  // Invisible formatting controls: bidi marks/isolates and the word joiner.
  // A PDF text layer and a copied quote rarely agree on these, and leaving them
  // in makes every RTL or mixed-direction passage fail to anchor.
  if (code === 0x2060 || (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))
    return "";
  if (c === "‘" || c === "’" || c === "‚" || c === "‛" || c === "ʼ") return "'";
  if (c === "“" || c === "”" || c === "„" || c === "‟" || c === "«" || c === "»") return '"';
  // Drop hyphens/dashes: line-break hyphenation differs between pdf.js versions.
  if (c === "-" || c === "‐" || c === "‑" || c === "–" || c === "—" || c === "‒" || c === "―" || c === "−")
    return "";
  // DECOMPOSE (NFKD), never compose, and KEEP the marks.
  //
  // Normalization here is necessarily PER CHARACTER — the index maps each
  // normalized char back to a raw offset — and composition is inherently
  // multi-character: no per-char rule can join "e" + U+0301 into "é". So a
  // quote copied in one composition form never matched a text layer using the
  // other. Decomposition is the direction that DOES work per character:
  // precomposed "é" expands to "e" + U+0301, already-decomposed input stays as
  // it is, and the two sides meet. It generalizes beyond Latin — Japanese
  // dakuten and Hangul jamo decompose the same way — and the K also folds
  // ligatures ("ﬁ" -> "fi").
  //
  // Marks are kept deliberately. Stripping them matches more sloppy text, but
  // it merges genuinely different words — Vietnamese tồi/tôi, Russian мой/мои,
  // French cote/côte — trading "fails to anchor" for "anchors on the WRONG
  // words", which is the worse failure.
  //
  // The second NFKD re-decomposes anything lowercasing recomposed, and NFKD
  // can emit spaces (U+00B4 -> space + combining acute) into a string that is
  // documented whitespace-free, so strip those from the result.
  return c.normalize("NFKD").toLowerCase().normalize("NFKD").replace(/\s/g, "");
}

export function normStr(s: string): string {
  let out = "";
  for (const c of s) out += normChar(c);
  return out;
}

/** Build a whole-document index. `onProgress(done,total)` is optional. */
export async function buildDocIndex(
  pdfDoc: any,
  onProgress?: (done: number, total: number) => void
): Promise<DocIndex> {
  const total: number = pdfDoc.numPages;
  const pages: PageData[] = [];
  let search = "";
  const map: GPos[] = [];
  for (let p = 0; p < total; p++) {
    const page = await pdfDoc.getPage(p + 1);
    const tc = await page.getTextContent();
    const items: ItemBox[] = [];
    for (const it of tc.items) {
      if (typeof it.str !== "string") continue;
      const t = it.transform as number[];
      const itemIndex = items.length;
      items.push({ str: it.str, x: t[4], y: t[5], w: it.width, h: it.height });
      let ch = 0;
      for (const c of it.str) {
        const n = normChar(c);
        for (let k = 0; k < n.length; k++) {
          search += n[k];
          map.push({ page: p, item: itemIndex, ch });
        }
        ch += c.length;
      }
    }
    pages.push({ page: p, items });
    // NOTE: do NOT call page.cleanup() — these PDFPageProxy objects are shared
    // with the view (same document); cleaning them corrupts the view's cached
    // and in-flight canvas renders.
    if (onProgress) onProgress(p + 1, total);
  }
  return { pages, search, map };
}

function itemHRange(b: ItemBox, fromCh: number, toChInclusive: number): [number, number] {
  const len = b.str.length || 1;
  // Positions inside a text run are PROPORTIONAL estimates (no per-glyph
  // metrics), so partial boundaries carry error on long runs. Bias them
  // outward by half a character: a highlight may overshoot slightly but
  // never cuts characters the user actually selected.
  const pad = 0.5;
  // `toChInclusive` is the code-unit offset where the last selected character
  // STARTS; an astral character occupies two units, so advancing by one would
  // stop half a surrogate pair short and visibly cut the final glyph.
  const lastCp = b.str.codePointAt(toChInclusive);
  const endUnit = toChInclusive + (lastCp !== undefined && lastCp > 0xffff ? 2 : 1);
  const f = Math.max(0, Math.min(1, (fromCh === 0 ? 0 : fromCh - pad) / len));
  const t = Math.max(0, Math.min(1, (endUnit + (endUnit >= len ? 0 : pad)) / len));
  return [b.x + f * b.w, b.x + t * b.w];
}

/** Reconstruct line rects (PDF space) for an item range within a single page. */
function rectsFromRange(
  items: ItemBox[],
  startItem: number,
  startCh: number,
  endItem: number,
  endCh: number
): PdfRect[] {
  const rects: PdfRect[] = [];
  let cur: { x1: number; x2: number; top: number; bottom: number; y: number; h: number } | null = null;
  const flush = () => {
    if (cur) rects.push({ x1: cur.x1, y1: cur.bottom, x2: cur.x2, y2: cur.top });
    cur = null;
  };
  for (let i = startItem; i <= endItem; i++) {
    const b = items[i];
    if (!b || !b.str) continue;
    const from = i === startItem ? startCh : 0;
    const to = i === endItem ? endCh : b.str.length - 1;
    const [x1, x2] = itemHRange(b, from, to);
    const top = b.y + b.h * 0.9;
    const bottom = b.y - b.h * 0.18;
    if (cur && Math.abs(b.y - cur.y) <= b.h * 0.6) {
      cur.x1 = Math.min(cur.x1, x1);
      cur.x2 = Math.max(cur.x2, x2);
      cur.top = Math.max(cur.top, top);
      cur.bottom = Math.min(cur.bottom, bottom);
    } else {
      flush();
      cur = { x1, x2, top, bottom, y: b.y, h: b.h };
    }
  }
  flush();
  return rects;
}

export interface AnchorResult {
  page: number;
  rects: PdfRect[];
}

/** Split a global match span [gStart,gEnd] into one rect-set per page covered. */
function resultsFromSpan(doc: DocIndex, gStart: number, gEnd: number): AnchorResult[] {
  const out: AnchorResult[] = [];
  let i = gStart;
  while (i <= gEnd) {
    const page = doc.map[i].page;
    let j = i;
    while (j + 1 <= gEnd && doc.map[j + 1].page === page) j++;
    const items = doc.pages[page].items;
    const rects = rectsFromRange(items, doc.map[i].item, doc.map[i].ch, doc.map[j].item, doc.map[j].ch);
    if (rects.length) out.push({ page, rects });
    i = j + 1;
  }
  return out;
}

/** How much stored context to weigh. Matches what selectionContext captures. */
const CONTEXT_WINDOW = 32;

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * How well the text around a candidate occurrence matches the context recorded
 * when the mark was made. The score is the NUMBER OF CONTEXT CHARACTERS that
 * line up, so a candidate agreeing on 25 characters outranks one agreeing on 12.
 *
 * The previous version compared only the innermost 12 characters and scored a
 * flat 2. That threw away most of the 32 characters actually stored, and any
 * two occurrences sharing a short tail (", section two, ") tied — which then
 * read as "ambiguous" or, worse, picked whichever came first.
 */
export function contextScore(search: string, start: number, end: number, nPrefix?: string, nSuffix?: string): number {
  let score = 0;
  if (nPrefix) {
    const tail = nPrefix.slice(-CONTEXT_WINDOW);
    const before = search.slice(Math.max(0, start - tail.length), start);
    score += commonSuffixLen(tail, before);
  }
  if (nSuffix) {
    const head = nSuffix.slice(0, CONTEXT_WINDOW);
    const after = search.slice(end + 1, end + 1 + head.length);
    score += commonPrefixLen(head, after);
  }
  return score;
}

/**
 * Best occurrence of a normalized `needle` inside normalized `search`,
 * disambiguated by prefix/suffix context. Shared by PDF quote anchoring,
 * selection-link building, and the HTML view's mark anchoring.
 */
export function findBestMatch(
  search: string,
  needle: string,
  nPrefix?: string,
  nSuffix?: string
): { start: number; end: number; ambiguous: boolean } | null {
  // `"abc".indexOf("", n)` clamps to the string length instead of returning -1,
  // so an empty needle makes the scan below a fixed point and hangs the UI
  // thread. Callers each guard this today; the shared function must not rely
  // on that.
  if (!needle) return null;
  let best: { start: number; end: number; score: number } | null = null;
  // How many occurrences tie for the top score: with no distinguishing context
  // the "best" match is just the first one found, which callers that build
  // durable links need to know about.
  let ties = 0;
  let from = 0;
  for (;;) {
    const at = search.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length - 1;
    const score = contextScore(search, at, end, nPrefix, nSuffix);
    if (!best || score > best.score) {
      best = { start: at, end, score };
      ties = 1;
    } else if (score === best.score) {
      ties++;
    }
    // NO early exit on a "good enough" score: stopping at the first strong
    // match cannot know whether a later occurrence scores the same, and that
    // is exactly what `ambiguous` has to report. Quitting early made the
    // ambiguity guard silently useless for the case it exists for — two
    // occurrences with equally matching context.
    from = at + 1;
  }
  return best ? { start: best.start, end: best.end, ambiguous: ties > 1 } : null;
}

/**
 * Head+tail span fallback for passages with internal extraction drift
 * (ligatures, hyphenation): match the needle's head and tail and accept a
 * span of plausible length between them. Shared by quote anchoring and
 * selection-link building.
 */
export function findDriftSpan(
  search: string,
  needle: string,
  nPrefix?: string,
  nSuffix?: string
): { start: number; end: number } | null {
  const hlen = Math.min(40, Math.max(12, Math.floor(needle.length * 0.35)));
  if (needle.length < hlen) return null;
  const head = needle.slice(0, hlen);
  const tail = needle.slice(-hlen);
  // The span may exceed the quote by a FIXED allowance, not a percentage.
  //
  // What actually lands between a matched head and tail is page furniture: a
  // running header and folio sitting in the concatenated document string where
  // a quote crosses a page boundary — which is the case this module exists to
  // handle. That interstitial is roughly constant (tens of characters), so a
  // ratio is the wrong shape: 1.2x is generous for a long quote and far too
  // tight for a short one, and it rejected ordinary cross-page selections.
  //
  // A fixed allowance still refuses the failure this guard is for — a head and
  // tail matched paragraphs apart, swallowing sentences the user never
  // selected. Note the drift this fallback was named for is length-neutral
  // after normalization (ligatures, hyphens, curly quotes all collapse on both
  // sides), so the allowance is spent entirely on inserted material.
  const lo = needle.length * 0.8;
  const hi = needle.length + 48;
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
  return fb ? { start: fb.start, end: fb.end } : null;
}

/**
 * Locate `exact` in the document, disambiguating duplicates with prefix/suffix.
 * Tries a whole-string match first, then a head+tail span match for passages
 * with minor extraction drift. Returns one result per page covered (a cross-page
 * selection yields multiple), or [] if not found.
 */
export function anchorQuote(
  doc: DocIndex,
  exact: string,
  prefix?: string,
  suffix?: string
): AnchorResult[] {
  const search = doc.search;
  const needle = normStr(exact);
  if (needle.length < 2) return [];
  const nPrefix = prefix ? normStr(prefix) : undefined;
  const nSuffix = suffix ? normStr(suffix) : undefined;

  // --- Pass 1: whole-string match, best disambiguated occurrence ---
  const best = findBestMatch(search, needle, nPrefix, nSuffix);
  if (best) return resultsFromSpan(doc, best.start, best.end);

  // --- Pass 2: head + tail span fallback (handles internal drift) ---
  const fb = findDriftSpan(search, needle, nPrefix, nSuffix);
  if (fb) return resultsFromSpan(doc, fb.start, fb.end);

  return [];
}
