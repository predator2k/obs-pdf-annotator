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

/**
 * Per-character normalization. Returns "" to drop the char, or 1+ chars.
 *
 * DECOMPOSE (NFKD) first, then apply the drop/fold rules to the RESULT.
 *
 * Order matters: the compatibility forms decompose INTO the characters we mean
 * to drop or fold. U+FF0D (the fullwidth hyphen used in Japanese and Chinese
 * typesetting) becomes "-", U+207B becomes "−", U+0149 becomes a modifier
 * apostrophe — so checking the input character alone let all of them through
 * and "研究－開発" stopped matching "研究-開発".
 *
 * Decomposition is also the only direction that works per character: no
 * per-char rule can COMPOSE "e" + U+0301 into "é", so a quote copied in one
 * composition form never matched a text layer using the other. Expanding both
 * sides makes them meet, and it generalizes past Latin (Japanese dakuten,
 * Hangul jamo). Marks are KEPT — stripping them merges genuinely different
 * words (Vietnamese tồi/tôi, Russian мой/мои, French cote/côte), which trades a
 * failed match for a WRONG one.
 */
const normCharMemo = new Map<string, string>();

export function normChar(c: string): string {
  // Prose reuses a few dozen distinct characters, so this memo turns the two
  // normalize() calls per character into a map hit; indexing a 600-page book
  // was measured at roughly 3x faster with it.
  const hit = normCharMemo.get(c);
  if (hit !== undefined) return hit;
  const out = computeNormChar(c);
  // Bound it: pathological input must not grow this without limit.
  if (normCharMemo.size < 4096) normCharMemo.set(c, out);
  return out;
}

function computeNormChar(c: string): string {
  if (/\s/.test(c)) return "";
  // toLowerCase never composes, so a second NFKD afterwards is a proven no-op
  // (verified across every Unicode scalar value).
  const decomposed = c.normalize("NFKD").toLowerCase();
  let out = "";
  for (const ch of decomposed) {
    if (/\s/.test(ch)) continue; // NFKD emits spaces: U+00B4 -> space + acute
    const code = ch.charCodeAt(0);
    if (code === 0x00ad || code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff)
      continue;
    // Invisible formatting controls: bidi marks/isolates and the word joiner.
    // A PDF text layer and a copied quote rarely agree on these, and leaving
    // them in makes every RTL or mixed-direction passage fail to anchor.
    if (
      code === 0x2060 ||
      code === 0x061c ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      continue;
    }
    if (ch === "\u2018" || ch === "\u2019" || ch === "\u201a" || ch === "\u201b" || ch === "\u02bc") {
      out += "'";
      continue;
    }
    if (
      ch === "\u201c" || ch === "\u201d" || ch === "\u201e" || ch === "\u201f" ||
      ch === "\u00ab" || ch === "\u00bb"
    ) {
      out += '"';
      continue;
    }
    // Drop hyphens/dashes: line-break hyphenation differs between pdf.js versions.
    if (
      ch === "-" || ch === "\u2010" || ch === "\u2011" || ch === "\u2012" || ch === "\u2013" ||
      ch === "\u2014" || ch === "\u2015" || ch === "\u2212"
    ) {
      continue;
    }
    out += ch;
  }
  return out;
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

/** Score lead the best occurrence needs before a link may commit to it. */
const AMBIGUITY_MARGIN = 4;

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
  let before = 0;
  let after = 0;
  if (nPrefix) {
    const tail = nPrefix.slice(-CONTEXT_WINDOW);
    before = commonSuffixLen(tail, search.slice(Math.max(0, start - tail.length), start));
  }
  if (nSuffix) {
    const head = nSuffix.slice(0, CONTEXT_WINDOW);
    after = commonPrefixLen(head, search.slice(end + 1, end + 1 + head.length));
  }
  // Agreement on BOTH sides beats a long run on one side. Plain addition let a
  // candidate matching 32 characters of prefix and nothing after (32) outrank
  // one corroborated 9 characters in each direction (18) — the second is far
  // more likely to be the passage the mark was made on. Weight the weaker side
  // double so two-sided support dominates.
  return Math.min(before, after) * 2 + Math.max(before, after);
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
  let runnerUp = -1;
  let from = 0;
  for (;;) {
    const at = search.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length - 1;
    const score = contextScore(search, at, end, nPrefix, nSuffix);
    if (!best || score > best.score) {
      best = { start: at, end, score };
      runnerUp = best.score > score ? best.score : runnerUp;
      ties = 1;
    } else if (score === best.score) {
      ties++;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
    // NO early exit on a "good enough" score: stopping at the first strong
    // match cannot know whether a later occurrence scores the same, and that
    // is exactly what `ambiguous` has to report. Quitting early made the
    // ambiguity guard silently useless for the case it exists for — two
    // occurrences with equally matching context.
    from = at + 1;
  }
  if (!best) return null;
  // Ambiguous when nothing meaningful separates the winner from the next
  // candidate. An EXACT tie is not the only unsafe case: a one-character margin
  // is noise, since extraction routinely drops a glyph from the context.
  //
  // The exception is a candidate that matches ALL the context we stored — there
  // is no stronger evidence available, so a close runner-up does not make it a
  // coin flip. Without this, an occurrence agreeing on every one of its 8
  // recorded suffix characters would be discarded because another agreed on 5.
  const available = (str: string | undefined) => (str ? Math.min(str.length, CONTEXT_WINDOW) : 0);
  const p = available(nPrefix);
  const q = available(nSuffix);
  const maxScore = Math.min(p, q) * 2 + Math.max(p, q);
  const decisive = maxScore > 0 && best.score === maxScore && ties === 1;
  const margin = best.score - Math.max(runnerUp, 0);
  const ambiguous = !decisive && (ties > 1 || (runnerUp >= 0 && margin < AMBIGUITY_MARGIN));
  return { start: best.start, end: best.end, ambiguous };
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
  // Head and tail must be INDEPENDENT anchors. Below 2*hlen they overlap (at
  // needle length 12 they are the same 12 characters), so "both ends matched"
  // means nothing and the span is free to run far past the quote.
  if (needle.length < hlen * 2) return null;

  // The span may exceed the quote by an allowance that GROWS WITH THE QUOTE but
  // is capped.
  //
  // What lands between a matched head and tail is page furniture: a running
  // header and folio sitting in the concatenated document string where a quote
  // crosses a page boundary — the case this module exists to handle. A pure
  // ratio is too tight for short quotes and too loose for long ones; a pure
  // fixed allowance is the opposite, and let a 24-character quote anchor onto a
  // 54-character span, citing words the user never selected.
  const gap = Math.min(64, Math.max(16, Math.round(needle.length * 0.4)));
  const lo = needle.length * 0.8;
  const hi = needle.length + gap;

  let fb: { start: number; end: number; score: number } | null = null;
  let from = 0;
  for (;;) {
    const h = search.indexOf(head, from);
    if (h < 0) break;
    // Search for the tail ONLY inside the window the span could legally end in.
    // Scanning the rest of the document per head occurrence is O(heads x
    // length): on a 1.7M-character book index a common 12-character head
    // (which is what a short quote's head is) took seconds of blocked UI, once
    // per imported annotation and once per mobile selection commit.
    const windowEnd = Math.min(search.length, h + hi);
    const t = search.slice(h, windowEnd).indexOf(tail, head.length - 1);
    if (t >= 0) {
      const end = h + t + tail.length - 1;
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
