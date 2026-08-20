/**
 * annotations.ts — annotation data model + sidecar persistence.
 *
 * Storage: a human-readable Markdown sidecar. Managed document bundles give it
 * a path-independent canonical location; central and old beside-the-PDF paths
 * remain supported as migration sources. It has a prose list (for skimming /
 * future back-links) AND a fenced ```json block that is the machine source of
 * truth. Geometry is stored in PDF USER-SPACE units (origin bottom-left, y-up)
 * so it is scale-independent and survives zoom / re-render / window resize.
 */
import type { DataAdapter } from "obsidian";
import { debounce, normalizePath } from "obsidian";
import { clampCssAlpha, deriveEmoji, markInkColor, MAX_HIGHLIGHT_ALPHA, parseColor, withAlpha, type Rgba } from "./color";

export interface PdfRect {
  // PDF user space (same convention as viewport.convertToPdfPoint).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The visual STYLE axis, orthogonal to color/meaning. Stored on each mark.
 * Absent on legacy marks → treated as "highlight" (see markStyleOf), so old
 * sidecars stay fully valid without migration.
 */
export type MarkStyle =
  | "highlight" // semi-transparent fill
  | "underline" // solid underline
  | "dashed" // dashed underline
  | "dotted" // dotted underline
  | "strike" // strikethrough
  | "box" // outlined rectangle around the text
  | "comment"; // "naked" note anchored to a span (quiet dotted underline, no fill)

export const MARK_STYLES: MarkStyle[] = [
  "highlight",
  "underline",
  "dashed",
  "dotted",
  "strike",
  "box",
  "comment",
];

/** Human label for menus / prose. */
export const MARK_STYLE_LABELS: Record<MarkStyle, string> = {
  highlight: "Highlight",
  underline: "Underline",
  dashed: "Dashed underline",
  dotted: "Dotted underline",
  strike: "Strikethrough",
  box: "Box",
  comment: "Comment",
};

/** Coerce an unknown/absent style to a valid one (legacy marks default to fill). */
export function markStyleOf(h: { style?: string } | null | undefined): MarkStyle {
  const s = (h?.style ?? "highlight") as MarkStyle;
  return MARK_STYLES.includes(s) ? s : "highlight";
}

export interface Highlight {
  id: string;
  type?: "highlight" | "tag"; // absent on old sidecars => text highlight
  page: number; // 0-based page index
  color: string; // rgba/hex — the COLOR/meaning axis (a palette `fill` value)
  style?: MarkStyle; // the STYLE axis; absent ⇒ "highlight" (backward compatible)
  text: string; // selected / quoted text
  note?: string; // user comment (carried over from legacy import)
  noteContentCJK?: string; // legacy storage key for the optional side note
  rects: PdfRect[]; // one rect per visual line
  tagX?: number; // percentage of page width, for page-note tags
  tagY?: number; // percentage of page height, for page-note tags
  tagColor?: string; // optional tag color; falls back to color
  isPinned?: boolean; // whether the margin card stays expanded / visible
  marginSide?: "left" | "right" | "auto"; // explicit override, otherwise source-based
  /** Quote context, kept for robustness / future re-anchoring. */
  context?: { prefix?: string; suffix?: string };
  created: string; // ISO timestamp
  source?: "manual" | "import";
}

export interface AnnotationDoc {
  version: 1;
  pdf: string; // vault-relative path of the PDF
  fingerprint?: string; // pdf.js document fingerprint (sanity only)
  highlights: Highlight[];
}

export type AnnotationStorageMode = "folder" | "beside-pdf";

/**
 * How a PDF is matched to its annotations.
 *  - "path" (default): the sidecar location is derived from the PDF's vault
 *    path. No hashing at open; annotations survive content edits; renames done
 *    inside Obsidian move the sidecar along.
 *  - "hash": the SHA-256 of the PDF bytes is the identity. Robust against
 *    moves/renames done outside Obsidian, but an edited PDF becomes a new
 *    document and every open reads + hashes the full file.
 */
export type DocumentIdentityMode = "path" | "hash";

export interface AnnotationPathOptions {
  storageMode?: AnnotationStorageMode;
  storageFolder?: string;
  documentIdentity?: DocumentIdentityMode;
}

export const DEFAULT_ANNOTATION_FOLDER = "PDF annotations";

/** The persistent "pen": last used color + style, shared by both PDF modes. */
export interface PenState {
  getColor(): string;
  getStyle(): MarkStyle;
  set(color: string, style: MarkStyle): void;
}

/**
 * The COLOR/meaning palette. Fills should read like real marker/pen colors,
 * while the painted alpha is capped in the renderer so text remains legible.
 * `ink` is a near-opaque darker version used for line styles.
 */
export interface PaletteEntry {
  name: string;
  fill: string; // stored on the mark as `color`
  ink: string; // derived stroke color for line/box styles
  emoji: string;
  cardFill?: string; // optional calmer tint for margin cards
  highlightAlpha?: number; // optional painted alpha for marker-like fills
}

/** Defaults follow Zotero's reader palette, familiar from academic workflows. */
const presetColor = (name: string, fill: string): PaletteEntry =>
  Object.freeze(derivePaletteEntry(name, fill));

export const DEFAULT_PALETTE: readonly PaletteEntry[] = Object.freeze([
  presetColor("yellow", "#ffd400"),
  presetColor("red", "#ff6666"),
  presetColor("green", "#5fb236"),
  presetColor("blue", "#2ea8e5"),
  presetColor("purple", "#a28ae5"),
  presetColor("magenta", "#e56eee"),
  presetColor("orange", "#f19837"),
  presetColor("gray", "#aaaaaa"),
]);

/**
 * The LIVE palette. Kept as one mutable array instance (mutated in place by
 * setActivePalette) so every consumer that iterates PALETTE — swatch rows,
 * renderers, resolvePalette — picks up user-configured colors without any
 * call-site changes. Swatch DOM is rebuilt on every popover open, so changes
 * apply immediately.
 */
export const PALETTE: PaletteEntry[] = DEFAULT_PALETTE.map((p) => ({ ...p }));

/** Replace the live palette in place (settings load / palette edits). */
export function setActivePalette(entries: PaletteEntry[]): void {
  const next = entries.length ? entries : DEFAULT_PALETTE.map((p) => ({ ...p }));
  PALETTE.splice(0, PALETTE.length, ...next);
}

/** Build a full palette entry from just a name + fill (user-defined colors). */
export function derivePaletteEntry(
  name: string,
  fill: string,
  highlightAlpha?: number
): PaletteEntry {
  return {
    name: name.trim() || fill,
    fill,
    ink: markInkColor(fill),
    emoji: deriveEmoji(fill),
    cardFill: withAlpha(fill, 0.5),
    highlightAlpha,
  };
}

export function defaultColor(): string {
  return PALETTE[0].fill;
}

/** Fill color for a highlight: normalized to the palette, alpha-capped so
 * stacked fills can't darken into a muddy patch and text stays readable. */
export function highlightPaintColor(color: string): string {
  const pal = resolvePalette(color);
  const fill = pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  const a = baseHighlightAlpha(c, pal);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(a)})`;
}

export function activeHighlightPaintColor(color: string): string {
  const c = highlightBaseColor(color);
  if (!c) return highlightPaintColor(color);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${activeHighlightAlpha(c)})`;
}

export function activeHighlightGlossColor(color: string): string {
  const c = highlightBaseColor(color);
  if (!c) return highlightPaintColor(color);
  const a = clampCssAlpha(activeHighlightAlpha(c) * 0.76);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

export function activeHighlightBridgeColor(color: string): string {
  const c = highlightBaseColor(color);
  if (!c) return highlightPaintColor(color);
  // Inter-line connector. Lighter than the text band, but present enough that
  // a multi-line passage reads as one continuous chunk of ink.
  const a = clampCssAlpha(activeHighlightAlpha(c) * 0.5);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function highlightBaseColor(color: string): Rgba | null {
  const pal = resolvePalette(color);
  const fill = pal?.fill ?? color;
  const parsed = parseColor(fill);
  if (!parsed) return null;
  return { ...parsed, a: baseHighlightAlpha(parsed, pal) };
}

function baseHighlightAlpha(color: Rgba, pal: PaletteEntry | null): number {
  return pal?.highlightAlpha ?? Math.min(color.a === 1 ? MAX_HIGHLIGHT_ALPHA : color.a, MAX_HIGHLIGHT_ALPHA);
}

function activeHighlightAlpha(color: Rgba): number {
  // Emphasis is the SAME hue, just denser ink. The highlight layer is
  // multiply-blended, so glyphs stay black at any alpha.
  return clampCssAlpha(Math.min(0.85, Math.max(color.a + 0.2, color.a * 1.4)));
}

/**
 * Accent color for UI chrome bound to a mark (tag dots, card edges, list
 * accents). Light theme wants the darkened ink for contrast on white; dark
 * theme wants the SATURATED color — darkened ink turns to mud there.
 */
export function annotationAccent(color: string): string {
  const dark = typeof document !== "undefined" && document.body.classList.contains("theme-dark");
  const pal = resolvePalette(color);
  if (dark) return withAlpha(pal?.fill ?? color, 0.95);
  return pal?.ink ?? markInkColor(color);
}

/**
 * Stroke color for line/box styles: the SATURATED mark color (Zotero-style),
 * not the darkened `ink` (which is for UI accents on light surfaces). An
 * underline made with yellow must look yellow, not brown.
 */
export function markStrokeColor(color: string): string {
  const pal = resolvePalette(color);
  return withAlpha(pal?.fill ?? color, 0.92);
}

/**
 * Old/pre-refinement fills → current palette name. Lets legacy marks render
 * with the current picker palette WITHOUT rewriting the sidecar: we never
 * mutate the stored string, we only resolve it at paint time.
 */
const LEGACY_FILL_TO_NAME: Record<string, string> = {
  "rgba(255, 214, 0, 0.40)": "yellow",
  "rgba(232, 194, 76, 0.42)": "yellow",
  "rgba(255, 224, 46, 0.52)": "yellow",
  "#FBF719": "yellow",
  "rgba(106, 217, 126, 0.42)": "green",
  "rgba(124, 178, 122, 0.42)": "green",
  "rgba(90, 170, 255, 0.40)": "blue",
  "rgba(72, 158, 255, 0.42)": "blue",
  "rgba(255, 130, 200, 0.42)": "magenta",
  "rgba(255, 76, 174, 0.46)": "magenta",
  "rgba(255, 110, 110, 0.42)": "red",
  "rgba(246, 94, 82, 0.44)": "red",
};

/**
 * Resolve any stored color to a palette entry (current fills, legacy fills, or
 * a normalized key match). Returns null for genuinely custom colors.
 */
export function resolvePalette(color: string): PaletteEntry | null {
  const norm = color.replace(/\s+/g, "");
  for (const p of PALETTE) if (p.fill.replace(/\s+/g, "") === norm) return p;
  const legacyName = LEGACY_FILL_TO_NAME[color] ?? LEGACY_FILL_TO_NAME[norm];
  if (legacyName) return PALETTE.find((p) => p.name === legacyName) ?? null;
  for (const [legacy, name] of Object.entries(LEGACY_FILL_TO_NAME)) {
    if (legacy.replace(/\s+/g, "") === norm) return PALETTE.find((p) => p.name === name) ?? null;
  }
  return null;
}

export function newId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function colorEmoji(color: string): string {
  return resolvePalette(color)?.emoji ?? deriveEmoji(color);
}

function pdfAnnotationStem(pdfVaultPath: string): string {
  return normalizePath(pdfVaultPath).replace(/\.pdf$/i, "");
}

export function normalizeAnnotationStorageFolder(folder: string | null | undefined): string {
  const normalized = normalizePath((folder ?? "").trim() || DEFAULT_ANNOTATION_FOLDER)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || DEFAULT_ANNOTATION_FOLDER;
}

/** Derive the legacy beside-the-PDF sidecar path from a PDF's vault path. */
export function legacySidecarPathFor(pdfVaultPath: string): string {
  return pdfAnnotationStem(pdfVaultPath) + ".annotations.md";
}

/**
 * Derive the active sidecar path from a PDF's vault path and storage settings.
 *
 * Folder mode mirrors the PDF's vault-relative path under the annotation folder:
 * "Books/Novel.pdf" -> "PDF annotations/Books/Novel.annotations.md".
 */
export function sidecarPathFor(
  pdfVaultPath: string,
  options: AnnotationPathOptions = {}
): string {
  if (options.storageMode === "folder") {
    const folder = normalizeAnnotationStorageFolder(options.storageFolder);
    return normalizePath(`${folder}/${pdfAnnotationStem(pdfVaultPath)}.annotations.md`);
  }
  return legacySidecarPathFor(pdfVaultPath);
}

/**
 * Canonical sidecar + rolling-backup locations for PATH identity mode. Always
 * folder-mode: the legacy "beside-pdf" layout stays a migration source only.
 */
export function pathModeSidecarPaths(
  pdfVaultPath: string,
  options: AnnotationPathOptions = {}
): { annotationPath: string; backupPath: string } {
  const annotationPath = sidecarPathFor(pdfVaultPath, {
    storageMode: "folder",
    storageFolder: options.storageFolder,
  });
  return {
    annotationPath,
    backupPath: annotationPath.replace(/\.annotations\.md$/, ".annotations.previous.md"),
  };
}

/** Create every missing parent folder of a file path (adapter-level). */
export async function ensureFolderForFile(adapter: DataAdapter, filePath: string): Promise<void> {
  const parent = normalizePath(filePath).split("/").slice(0, -1).join("/");
  if (!parent) return;

  const parts = parent.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const stat = await adapter.stat(current);
    if (stat?.type === "folder") continue;
    if (stat) throw new Error(`Cannot create annotation folder because ${current} is a file.`);
    try {
      await adapter.mkdir(current);
    } catch (e) {
      const after = await adapter.stat(current);
      if (after?.type !== "folder") throw e;
    }
  }
}

/**
 * PATH mode rename-follow: move the sidecar (and its rolling backup) to the
 * location mirrored from the PDF's new vault path. A file already at the
 * destination is never overwritten — the old sidecar stays as a recovery
 * snapshot and a warning is logged.
 */
export async function moveSidecarsForRename(
  adapter: DataAdapter,
  oldPdfPath: string,
  newPdfPath: string,
  options: AnnotationPathOptions = {}
): Promise<void> {
  const from = pathModeSidecarPaths(oldPdfPath, options);
  const to = pathModeSidecarPaths(newPdfPath, options);
  if (from.annotationPath === to.annotationPath) return;

  // A sidecar already at the destination belongs to a DIFFERENT document that
  // once lived at the new path. It must not stay there (the renamed PDF's
  // store will save there next), and it must not be overwritten silently —
  // set it aside as a timestamped conflict snapshot.
  try {
    if (
      (await adapter.exists(from.annotationPath)) &&
      (await adapter.exists(to.annotationPath))
    ) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const aside = to.annotationPath.replace(
        /\.annotations\.md$/,
        `.annotations.conflict-${stamp}.md`
      );
      await adapter.rename(to.annotationPath, aside);
      console.warn(
        `[local-pdf-annotator] a different document's sidecar occupied ${to.annotationPath}; preserved it as ${aside}`
      );
    }
    if ((await adapter.exists(from.backupPath)) && (await adapter.exists(to.backupPath))) {
      // Rolling backups are disposable; the incoming one wins.
      await adapter.remove(to.backupPath);
    }
  } catch (e) {
    console.error("[local-pdf-annotator] failed to set aside conflicting sidecar", e);
  }

  const moves: Array<[string, string]> = [
    [from.annotationPath, to.annotationPath],
    [from.backupPath, to.backupPath],
  ];
  for (const [src, dst] of moves) {
    try {
      if (!(await adapter.exists(src))) continue;
      if (await adapter.exists(dst)) continue; // set-aside failed; leave both
      await ensureFolderForFile(adapter, dst);
      await adapter.rename(src, dst);
    } catch (e) {
      console.error(`[local-pdf-annotator] failed to move sidecar ${src} -> ${dst}`, e);
    }
  }
}

export function serializeAnnotations(doc: AnnotationDoc, pdfBasename: string): string {
  const ordered = [...doc.highlights].sort(
    (a, b) => a.page - b.page || a.created.localeCompare(b.created)
  );
  const lines: string[] = [];
  lines.push("---");
  lines.push("lpa-annotations: 1");
  lines.push(`pdf: ${JSON.stringify(doc.pdf)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Annotations — ${pdfBasename}`);
  lines.push("");
  lines.push(
    "<!-- Managed by PDF Annotator. The ```json block at the bottom is the " +
      "source of truth; the list above is for reading. Editing the prose is safe; " +
      "keep the json block intact. -->"
  );
  lines.push("");
  if (ordered.length === 0) {
    lines.push("_No highlights yet._");
  } else {
    for (const h of ordered) {
      const isTag = h.type === "tag";
      const text = (h.note || h.text || "Page note").replace(/\s+/g, " ").trim();
      const short = text.length > 220 ? text.slice(0, 217) + "…" : text;
      const st = markStyleOf(h);
      const styleTag = isTag
        ? " _(tag)_"
        : st === "highlight"
          ? ""
          : ` _(${MARK_STYLE_LABELS[st].toLowerCase()})_`;
      let line = `- **p.${h.page + 1}** ${colorEmoji(h.tagColor ?? h.color)}${styleTag} ^${h.id} — "${short}"`;
      if (!isTag && h.note && h.note.trim()) line += `\n  - 📝 ${h.note.replace(/\s+/g, " ").trim()}`;
      if (h.noteContentCJK && h.noteContentCJK.trim()) line += `\n  - ${h.noteContentCJK.replace(/\s+/g, " ").trim()}`;
      lines.push(line);
    }
  }
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(doc, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/** Extract the last ```json fenced block and parse it. Tolerant of missing/garbled files. */
export function parseAnnotations(content: string): AnnotationDoc | null {
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(content)) !== null) last = match[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.highlights)) return null;
    return parsed as AnnotationDoc;
  } catch {
    return null;
  }
}

/**
 * In-memory annotation store with debounced autosave to the sidecar.
 */
export class AnnotationStore {
  doc: AnnotationDoc;
  /** Fired on every store mutation (single choke point: markDirty). */
  onChange: (() => void) | null = null;
  private dirty = false;
  private flushDebounced: () => void;

  constructor(
    private adapter: DataAdapter,
    private sidecarPath: string,
    private pdfBasename: string,
    pdfVaultPath: string,
    fingerprint?: string,
    private loadFallbackPaths: string[] = [],
    private migrateFallbackOnLoad = false,
    private sidecarBackupPath?: string
  ) {
    this.doc = { version: 1, pdf: pdfVaultPath, fingerprint, highlights: [] };
    this.flushDebounced = debounce(() => void this.flush(), 600, true);
  }

  async load(): Promise<void> {
    const paths = [this.sidecarPath, ...this.loadFallbackPaths].filter(
      (path, index, all) => path && all.indexOf(path) === index
    );
    for (const path of paths) {
      let parsed: AnnotationDoc | null = null;
      try {
        if (!(await this.adapter.exists(path))) continue;
        const content = await this.adapter.read(path);
        parsed = parseAnnotations(content);
      } catch {
        /* try the next candidate path */
      }
      if (!parsed) continue;
      if (parsed.fingerprint && this.doc.fingerprint && parsed.fingerprint !== this.doc.fingerprint) {
        console.warn(
          `[local-pdf-annotator] sidecar ${path} was written for a different PDF fingerprint — ` +
            "keeping it attached (path identity tolerates content edits)."
        );
      }
      this.doc.highlights = parsed.highlights;
      if (parsed.fingerprint) this.doc.fingerprint = parsed.fingerprint;
      // Managed bundles use a stable canonical sidecar. When annotations are
      // first found in an old path-derived sidecar, copy them into the bundle
      // immediately instead of waiting for the next user edit. A failed copy
      // is deliberately surfaced; silently showing an empty document would be
      // much more dangerous. The legacy file remains a recovery snapshot.
      if (this.migrateFallbackOnLoad && path !== this.sidecarPath) {
        this.dirty = true;
        await this.flush();
      }
      return;
    }
  }

  byPage(page: number): Highlight[] {
    return this.doc.highlights.filter((h) => h.page === page);
  }

  get(id: string): Highlight | undefined {
    return this.doc.highlights.find((h) => h.id === id);
  }

  add(h: Highlight): void {
    this.doc.highlights.push(h);
    this.markDirty();
  }

  addMany(hs: Highlight[]): void {
    this.doc.highlights.push(...hs);
    this.markDirty();
  }

  remove(id: string): void {
    const i = this.doc.highlights.findIndex((h) => h.id === id);
    if (i >= 0) {
      this.doc.highlights.splice(i, 1);
      this.markDirty();
    }
  }

  update(id: string, patch: Partial<Highlight>): void {
    const h = this.get(id);
    if (h) {
      Object.assign(h, patch);
      this.markDirty();
    }
  }

  /** Keep human-readable metadata current after a vault rename. In hash mode
   * the sidecar itself is stable; in path mode setSidecarPath follows it. */
  setPdfPath(pdfVaultPath: string, pdfBasename: string): void {
    if (this.doc.pdf === pdfVaultPath && this.pdfBasename === pdfBasename) return;
    this.doc.pdf = pdfVaultPath;
    this.pdfBasename = pdfBasename;
    this.markDirty();
  }

  /** Point future saves at a new sidecar location (path-mode rename-follow). */
  setSidecarPath(path: string, backupPath?: string): void {
    this.sidecarPath = path;
    this.sidecarBackupPath = backupPath;
  }

  private markDirty(): void {
    this.dirty = true;
    this.flushDebounced();
    this.onChange?.();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const out = serializeAnnotations(this.doc, this.pdfBasename);
    try {
      await this.ensureParentFolder(this.sidecarPath);
      if (this.sidecarBackupPath && (await this.adapter.exists(this.sidecarPath))) {
        const current = await this.adapter.read(this.sidecarPath);
        // Never replace the last-known-good recovery copy with a corrupt or
        // partially-written canonical sidecar.
        if (parseAnnotations(current)) {
          await this.ensureParentFolder(this.sidecarBackupPath);
          await this.adapter.write(this.sidecarBackupPath, current);
        }
      }
      await this.adapter.write(this.sidecarPath, out);
      this.dirty = false;
    } catch (error) {
      // Keep the in-memory document retryable after transient adapter/iCloud
      // failures instead of falsely treating an unsuccessful write as saved.
      this.dirty = true;
      throw error;
    }
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    await ensureFolderForFile(this.adapter, filePath);
  }
}
