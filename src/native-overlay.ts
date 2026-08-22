/**
 * native-overlay.ts — EXPERIMENTAL annotation mode layered onto Obsidian's
 * NATIVE PDF view (view type "pdf"), instead of replacing it.
 *
 * Approach / isolation guarantees:
 *  - We never call leaf.setViewState, never patch Obsidian internals, and never
 *    touch the native viewer's pdf.js objects. The ONLY native surface we rely
 *    on is stable pdf.js DOM (".page[data-page-number]", ".textLayer",
 *    ".canvasWrapper") plus Obsidian's ".pdf-toolbar" for control injection
 *    (with a ".view-actions" fallback).
 *  - Coordinate mapping is done with OUR bundled pdf.js: the overlay opens the
 *    same file (geometry only, nothing rendered) and converts DOM fractions of
 *    a native page box through a scale-1 viewport → PDF user space. This yields
 *    the exact same sidecar geometry the custom annotator view produces, so
 *    both modes read/write one format.
 *  - Marks are positioned in % of the page box, so native zoom keeps them
 *    aligned even between repaints; a MutationObserver re-attaches our layers
 *    whenever the native viewer re-renders a page.
 *  - Margin note cards (the custom view's side-annotation UX) live in a
 *    ".lpa-native-margins" overlay pinned to the native scroller's box: cards
 *    are anchored beside the visible pages and re-laid-out on scroll, resize,
 *    zoom, and native re-renders. Cards only use margin space that already
 *    exists — the overlay never changes the native zoom level itself.
 *  - Everything injected is namespaced "lpa-native-*" and removed when the
 *    mode is toggled off, the leaf changes file or closes, or the plugin
 *    unloads.
 *
 * Known limitation: pages rotated by the user inside the native viewer can't be
 * mapped reliably (the native view does not expose its rotation publicly), so
 * painting/creating marks is skipped on aspect-mismatched pages instead of
 * placing them wrong.
 */
import { App, Menu, Notice, Platform, Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { pdfjsLib, initPdfEngine, createDedicatedWorker, LOG_TAG } from "./pdf-engine";
import {
  AnnotationStore,
  defaultColor,
  PALETTE,
  resolvePalette,
  MARK_STYLES,
  MARK_STYLE_LABELS,
  activeHighlightBridgeColor,
  activeHighlightGlossColor,
  activeHighlightPaintColor,
  activeHighlightPaintColorDark,
  highlightPaintColorDark,
  annotationAccent,
  highlightPaintColor,
  markStrokeColor,
  markStyleOf,
  newId,
  pathModeSidecarPaths,
  type AnnotationPathOptions,
  type Highlight,
  type MarkStyle,
  type PenState,
  type PdfRect,
} from "./annotations";
import { buildDocIndex, anchorQuote } from "./anchor";
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
} from "./annotation-format";
import { bindPopoverAction, buildSelectionStyleRow, openAnnotationEditor, popoverEdgeInsets, selectionContext } from "./annotation-popover";
import { copyHighlightLink } from "./copy-link";
import { clampCssAlpha, markInkColor, MAX_HIGHLIGHT_ALPHA, parseColor, withAlpha } from "./color";
import { mayHandleDocumentKeys, type AnnotationHub } from "./annotation-hub";
import { parseLegacyNote, targetBasename, type LegacyAnnotation } from "./legacy-import";
import { fallbackAnnotationBinding, PdfBundleManager } from "./bundles";
import { copyPdfDataForWorker } from "./pdf-data";

/** Toolbar-injection retry budget (x350ms). A backstop, not a deadline. */
/**
 * Plugin-owned UI that can sit over the page. A selection anchored inside any
 * of it is ours, not the document's — including `.lpa-panel`, the workspace
 * sidebar panel, whose drawer overlays the content area on phones.
 */
const OWN_UI_SELECTOR =
  ".lpa-selection-popover, .lpa-mark-popover, .lpa-native-controls, .lpa-native-roll, " +
  ".lpa-native-margins, .lpa-sidebar-annotations, .lpa-panel";

const TOOLBAR_RETRY_LIMIT = 24;
import {
  fitFoldedMarginCardHeights,
  layoutPageBoundedCardTops,
  marginCardSourceText,
  syncMarginCardPresentation,
} from "./margin-card";

/** DOM that belongs to us; mutations inside it must not re-trigger syncing. */
const OWN_DOM_SELECTOR =
  ".lpa-native-hl-layer, .lpa-native-note-layer, .lpa-native-roll, .lpa-native-controls, .lpa-native-margins, .lpa-sidebar-annotations";
/** Below this rail width cards are unreadable — skip the side entirely. */
const RAIL_HIDE_WIDTH = 42;
/** Keep right-rail cards clear of the native scrollbar. */
const RAIL_SCROLLBAR_GUTTER = 14;

interface PageGeom {
  vp1: any; // pdf.js viewport at scale 1 (the page's own /Rotate applied)
  w: number;
  h: number;
}

interface BaseRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PaintRect extends BaseRect {
  color: string;
  order: number;
  ids: Set<string>;
  notes: Set<string>;
}

interface LineMetrics {
  weight: number;
  dash: number;
  dashGap: number;
  dot: number;
  dotGap: number;
}

interface PageBox {
  idx: number;
  pageEl: HTMLElement;
  box: DOMRect;
}

/** Anchor of one annotation in the margin-rail overlay's coordinate space. */
interface NativeAnchor {
  side: "left" | "right";
  sourceX: number;
  sourceY: number;
  idealY: number;
  pageTopY: number;
  pageBottomY: number;
  pageLeftX: number;
  pageRightX: number;
}

interface RailEntry {
  h: Highlight;
  anchor: NativeAnchor;
}

function nativeViewFile(leaf: WorkspaceLeaf): TFile | null {
  const file = (leaf.view as { file?: unknown }).file;
  return file instanceof TFile && file.extension === "pdf" ? file : null;
}

/**
 * Owns the per-leaf toggle buttons in native PDF toolbars and the lifecycle of
 * the active overlays. `refresh()` is cheap and idempotent; the plugin calls it
 * on layout-change / active-leaf-change / file-open.
 */
export class NativeOverlayManager {
  private overlays = new Map<WorkspaceLeaf, NativePdfOverlay>();
  private attaching = new Set<WorkspaceLeaf>();
  private optedOut = new WeakSet<WorkspaceLeaf>();
  /** leaf → file path whose attach failed; retried only after the file changes
   * or an explicit toggle, never in an event-driven loop. */
  private attachFailedFor = new WeakMap<WorkspaceLeaf, string>();
  private retryTimer: number | null = null;
  private retryCount = 0;
  /** Set by disable(): the plugin is going away, start nothing new. */
  /** Latched by shutdown() only — the plugin is unloading, start nothing new. */
  private disabled = false;

  constructor(
    private plugin: Plugin,
    private enabled: () => boolean,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private bundleManager?: PdfBundleManager,
    private getShowMarginCards: () => boolean = () => false,
    private pen?: PenState,
    private hub?: AnnotationHub,
    private getMobileSelectionDelay: () => number = () => 3000
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  refresh(): void {
    if (this.disabled) return;
    if (!this.enabled()) {
      this.disable();
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const live = new Set(leaves);

    // GC overlays whose leaf closed, changed view type, or changed file.
    for (const [leaf, overlay] of Array.from(this.overlays)) {
      const file = live.has(leaf) ? nativeViewFile(leaf) : null;
      if (!file || file.path !== overlay.file.path) {
        overlay.destroy();
        this.overlays.delete(leaf);
      }
    }

    let missingBar = false;
    for (const leaf of leaves) {
      if (!nativeViewFile(leaf)) continue;
      // Annotation mode is always on: attach as soon as a PDF opens, unless
      // this leaf was explicitly toggled off.
      const file = nativeViewFile(leaf);
      if (
        !this.overlays.has(leaf) &&
        !this.attaching.has(leaf) &&
        !this.optedOut.has(leaf) &&
        this.attachFailedFor.get(leaf) !== file?.path
      ) {
        void this.attach(leaf);
      }
      if (!this.ensureControls(leaf)) missingBar = true;
    }
    // The native toolbar renders asynchronously after file-open; retry briefly.
    this.scheduleRetry(missingBar);
  }

  /** Tear everything down (setting turned off / plugin unload). */
  /**
   * Permanent teardown for plugin unload. Unlike disable(), which the settings
   * toggle uses and must stay reversible, this latches so an attach still in
   * flight cannot re-inject listeners, observers and a worker that nothing owns.
   */
  shutdown(): void {
    this.disabled = true;
    this.disable();
  }

  disable(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const overlay of this.overlays.values()) overlay.destroy();
    this.overlays.clear();
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      leaf.view.containerEl
        .querySelectorAll<HTMLElement>(".lpa-native-controls")
        .forEach((el) => el.remove());
    }
    this.app.workspace.containerEl
      .querySelectorAll<HTMLElement>(".lpa-native-controls")
      .forEach((el) => el.remove());
  }

  /** Re-apply UI-affecting settings on live overlays (e.g. margin cards toggled). */
  refreshUi(): void {
    for (const overlay of this.overlays.values()) overlay.refreshUi();
  }

  /** Settle pending debounced saves for this file (rename-follow). */
  async flushAnnotations(file: TFile): Promise<void> {
    for (const overlay of this.overlays.values()) {
      if (overlay.file.path === file.path) await overlay.flushAnnotations();
    }
  }

  overlayFor(leaf: WorkspaceLeaf | null): NativePdfOverlay | null {
    return leaf ? this.overlays.get(leaf) ?? null : null;
  }

  activeOverlay(): NativePdfOverlay | null {
    return this.overlayFor(this.app.workspace.activeLeaf);
  }

  async toggle(leaf: WorkspaceLeaf): Promise<void> {
    const existing = this.overlays.get(leaf);
    if (existing) {
      this.optedOut.add(leaf);
      existing.destroy();
      this.overlays.delete(leaf);
      this.refresh();
      return;
    }
    this.optedOut.delete(leaf);
    this.attachFailedFor.delete(leaf);
    await this.attach(leaf);
  }

  private async attach(leaf: WorkspaceLeaf): Promise<void> {
    const file = nativeViewFile(leaf);
    if (!file || this.overlays.has(leaf) || this.attaching.has(leaf)) return;
    this.attaching.add(leaf);
    const overlay = new NativePdfOverlay(
      this.plugin,
      leaf,
      file,
      this.getAnnotationPathOptions,
      this.bundleManager,
      this.getShowMarginCards,
      this.pen,
      this.hub,
      this.getMobileSelectionDelay
    );
    this.overlays.set(leaf, overlay);
    try {
      // Inside the try: refresh() reaches into Obsidian's toolbar DOM, and a
      // throw here used to escape before `attaching` was cleared — pinning the
      // leaf in that set forever, so it could never attach again and the toggle
      // command silently did nothing.
      this.refresh();
      await overlay.init();
      // disable() may have run during init(): tearing the overlay down here is
      // what stops an in-flight attach from re-injecting listeners, observers
      // and a pdf.js worker that nothing owns any more.
      if (this.disabled) {
        overlay.destroy();
        if (this.overlays.get(leaf) === overlay) this.overlays.delete(leaf);
        return;
      }
      this.attachFailedFor.delete(leaf);
    } catch (e) {
      if (!overlay.isDestroyed) {
        // A real failure: back off (retried on file change or via the
        // command). A destroyed overlay is OUR teardown (leaf switched
        // files mid-init) — that must not poison future attaches.
        console.error(`${LOG_TAG} native overlay attach failed`, e);
        new Notice(
          "PDF Annotator: could not attach the annotation overlay (see console). " +
            "Run “Toggle annotation mode on the native PDF view” to retry."
        );
        this.attachFailedFor.set(leaf, file.path);
      }
      overlay.destroy();
      if (this.overlays.get(leaf) === overlay) this.overlays.delete(leaf);
    } finally {
      this.attaching.delete(leaf);
    }
    this.refresh();
  }

  syncPdfPath(file: TFile): void {
    for (const overlay of this.overlays.values()) overlay.syncPdfPath(file);
  }

  /** Inject/sync the control group in one native PDF leaf. False if no bar yet. */
  private ensureControls(leaf: WorkspaceLeaf): boolean {
    const container = leaf.view.containerEl;
    const toolbar = container.querySelector<HTMLElement>(".pdf-toolbar");
    const bar =
      toolbar ??
      container.querySelector<HTMLElement>(".view-header .view-actions, .view-actions");
    if (!bar) return false;

    let group =
      Array.from(container.querySelectorAll<HTMLElement>(".lpa-native-controls")).find(
        (el) => el.parentElement === bar
      ) ?? null;
    // Sweep strays left behind if the native toolbar was rebuilt around us.
    container.querySelectorAll<HTMLElement>(".lpa-native-controls").forEach((el) => {
      if (el !== group) el.remove();
    });

    if (!group) {
      group = bar.ownerDocument.createElement("div");
      group.className = "lpa-native-controls";
      if (toolbar) {
        // Centered between the native left and right toolbar sections.
        const right = toolbar.querySelector<HTMLElement>(".pdf-toolbar-right");
        if (right) toolbar.insertBefore(group, right);
        else toolbar.appendChild(group);
      } else {
        bar.insertBefore(group, bar.firstChild);
      }
    }

    this.overlays.get(leaf)?.ensureToolbarButtons(group);
    // Controls are placed either way, but a fallback placement still counts as
    // "no toolbar yet" so the retry keeps polling and migrates them the moment
    // the real one appears. Making this return true unconditionally silently
    // disabled the retry; making it return false WITHOUT placing them left the
    // user with no controls at all for seconds. Do both.
    return !!toolbar;
  }

  private scheduleRetry(needed: boolean): void {
    if (!needed) {
      this.retryCount = 0;
      return;
    }
    // The budget is a backstop against spinning forever on a view that will
    // never grow a toolbar, not a deadline for slow ones. A cold vault or a
    // large PDF on mobile can take several seconds, and running out used to
    // mean the swatches never appeared at all until an unrelated workspace
    // event happened to re-enter refresh().
    if (this.retryTimer !== null || this.retryCount >= TOOLBAR_RETRY_LIMIT) return;
    this.retryCount++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.refresh();
    }, 350);
  }
}

/**
 * One active annotation overlay bound to (leaf, file). Reads/writes the same
 * managed document bundle as the custom annotator view.
 */
export class NativePdfOverlay {
  private destroyed = false;
  private store: AnnotationStore | null = null;
  private pdfDoc: any | null = null;
  private pageLabelsPromise: Promise<string[] | null> | null = null;
  private pdfWorker: any | null = null;
  private geoms = new Map<number, PageGeom>();
  private geomPromises = new Map<number, Promise<PageGeom | null>>();
  private contentRoot: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private syncQueued = false;
  private cleanups: Array<() => void> = [];

  private currentColor = defaultColor();
  private currentStyle: MarkStyle = "highlight";
  private tagMode = false;
  private warnedRotated = false;

  private pendingSelection: {
    text: string;
    byPage: Map<number, PdfRect[]>;
    context?: { prefix?: string; suffix?: string };
  } | null = null;
  private selectionPopoverEl: HTMLElement | null = null;
  private editPopoverCleanup: (() => void) | null = null;

  private toolbarSwatchesEl: HTMLElement | null = null;
  private fitWidthBtn: HTMLElement | null = null;
  private sidebarViewEl: HTMLElement | null = null;
  /** Unsubscribes the ONE live `sidebarviewchanged` handler (see ensureSidebarTab). */
  private sidebarBusOff: (() => void) | null = null;
  /** Obsidian's sidebar content element, if WE gave it `position: relative`. */
  private sidebarPositionPatched: HTMLElement | null = null;
  private sidebarActive = false;
  /** The user's CHOICE of the Annotations sidebar view, which has to outlive a
   * toolbar rebuild — `sidebarActive` only tracks whether the DOM is live. */
  private sidebarWanted = false;
  private sidebarMenuTriggerEl: HTMLElement | null = null;
  private suppressSidebarViewEvents = 0;
  private toolbarStylesEl: HTMLElement | null = null;
  private tagBtn: HTMLButtonElement | null = null;
  private listBtn: HTMLButtonElement | null = null;
  private countEl: HTMLElement | null = null;
  private listPanelEl: HTMLElement | null = null;
  private listSearchQuery = "";

  // Margin-rail overlay (side note cards beside the native pages).
  private marginsEl: HTMLElement | null = null;
  private leftRailEl: HTMLElement | null = null;
  private rightRailEl: HTMLElement | null = null;
  private connectionSvg: SVGSVGElement | null = null;
  private railResizeObserver: ResizeObserver | null = null;
  private scroller: HTMLElement | null = null;
  private railScrollTarget: HTMLElement | null = null;
  private readonly railScrollHandler = () => this.onNativeScroll();
  private railWidths = { left: 0, right: 0 };
  private railRaf: number | null = null;
  private pointerRaf: number | null = null;
  private lastPointer: { x: number; y: number; pageEl: HTMLElement | null } | null = null;
  private hoverId: string | null = null;
  private activeId: string | null = null;
  private hoverClearTimer: number | null = null;
  private scrollSettleTimer: number | null = null;
  private mobileSelectionTimer: number | null = null;
  private darkPages = false;
  private docIndexPromise: Promise<any> | null = null;

  constructor(
    private plugin: Plugin,
    private leaf: WorkspaceLeaf,
    readonly file: TFile,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private bundleManager?: PdfBundleManager,
    private getShowMarginCards: () => boolean = () => false,
    private pen?: PenState,
    private hub?: AnnotationHub,
    private getMobileSelectionDelay: () => number = () => 3000
  ) {
    this.hubKey = `overlay-${newId()}`;
    if (pen) {
      this.currentColor = pen.getColor();
      this.currentStyle = pen.getStyle();
    }
  }

  private readonly hubKey: string;

  private get app(): App {
    return this.plugin.app;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  async init(): Promise<void> {
    initPdfEngine();
    const container = this.leaf.view.containerEl;
    this.contentRoot = container.querySelector<HTMLElement>(".view-content") ?? container;
    // Marks this leaf as ours, so the stylesheet can scope its rules to PDF
    // views the plugin actually attached to instead of restyling every native
    // PDF view in the app (including ones with annotation mode turned off).
    this.contentRoot.addClass("lpa-native-host");

    // Geometry-only document via OUR bundled pdf.js (no rendering, no globals).
    const data = await this.app.vault.readBinary(this.file);
    if (this.destroyed) return;
    this.pdfWorker = createDedicatedWorker();
    const params: any = { data: copyPdfDataForWorker(data), useSystemFonts: true };
    if (this.pdfWorker) params.worker = this.pdfWorker;
    this.pdfDoc = await pdfjsLib.getDocument(params).promise;
    if (this.destroyed) {
      this.releasePdf();
      return;
    }

    const fingerprint = Array.isArray(this.pdfDoc.fingerprints)
      ? this.pdfDoc.fingerprints[0]
      : this.pdfDoc.fingerprint;
    const pathOptions = this.getAnnotationPathOptions();
    let binding = fallbackAnnotationBinding(this.file.path, pathOptions);
    if (this.bundleManager) {
      try {
        binding = await this.bundleManager.resolveBinding(this.file, data, fingerprint, pathOptions);
      } catch (e: any) {
        console.error(`${LOG_TAG} could not resolve annotation storage`, e);
        if (pathOptions.documentIdentity === "hash") {
          // Falling back here would fork the annotations away from the bundle.
          throw e;
        }
        new Notice("PDF Annotator: annotation storage lookup failed — using the sidecar folder directly.");
      }
    }
    this.store = new AnnotationStore(
      this.app.vault.adapter,
      binding.annotationPath,
      this.file.basename,
      this.file.path,
      fingerprint,
      binding.fallbackPaths,
      binding.migrateFallback,
      binding.annotationBackupPath
    );
    this.store.onWriteError = (e) => {
      console.error(`${LOG_TAG} failed to save annotations`, e);
      new Notice(
        "PDF Annotator: annotations could not be saved. Check that the annotation " +
          "folder is writable — see the console for details."
      );
    };
    await this.store.load();
    if (this.destroyed) return;
    this.notifyStoreChanged();

    const doc = this.contentRoot.ownerDocument;
    // Pointer events cover mouse AND touch; Obsidian's native viewer stopped
    // emitting mouseup reliably after 1.8 (see PDF++'s workaround history).
    this.listen(this.contentRoot, "pointerup", (evt) => this.onMouseUp(evt as MouseEvent));
    this.listen(this.contentRoot, "click", (evt) => this.onClick(evt as MouseEvent));
    this.listen(this.contentRoot, "contextmenu", (evt) => this.onContextMenu(evt as MouseEvent));
    this.listen(
      this.contentRoot,
      "pointermove",
      (evt) => this.onPointerMove(evt as MouseEvent),
      { passive: true }
    );
    this.listen(doc, "selectionchange", () => this.onSelectionChange());
    this.listen(doc, "keydown", (evt) => this.onKeyDown(evt as KeyboardEvent));

    this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    this.observer.observe(this.contentRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-loaded"],
    });

    this.initMarginRail();
    this.scheduleSync();

    if (this.hub && this.store) {
      const store = this.store;
      this.hub.register({
        key: this.hubKey,
        file: this.file,
        store,
        reveal: (id) => this.revealAnnotation(id),
        activeId: () => this.activeId,
        remove: (id) => {
          const page = store.get(id)?.page;
          store.remove(id);
          if (page !== undefined) this.repaintPage(page);
          this.notifyStoreChanged();
        },
        copyLink: (id) => this.copyAnnotationLink(id),
        ownsLeaf: (leaf) => leaf === this.leaf,
      });
    }
    console.log(`${LOG_TAG} native annotation overlay attached: ${this.file.path}`);
  }

  syncPdfPath(file: TFile): void {
    if (this.file !== file && this.file.path !== file.path) return;
    this.store?.setPdfPath(file.path, file.basename);
    const options = this.getAnnotationPathOptions();
    if (options.documentIdentity !== "hash") {
      const paths = pathModeSidecarPaths(file.path, options);
      this.store?.setSidecarPath(paths.annotationPath, paths.backupPath);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hub?.unregister(this.hubKey);

    this.closeEditPopover();
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    this.closeListPanel();
    this.contentRoot?.removeClass("lpa-native-tag-mode");

    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }

    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.railRaf !== null) {
      win.cancelAnimationFrame(this.railRaf);
      this.railRaf = null;
    }
    if (this.pointerRaf !== null) {
      win.cancelAnimationFrame(this.pointerRaf);
      this.pointerRaf = null;
    }
    this.lastPointer = null;
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    if (this.scrollSettleTimer !== null) {
      win.clearTimeout(this.scrollSettleTimer);
      this.scrollSettleTimer = null;
    }
    if (this.mobileSelectionTimer !== null) {
      win.clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = null;
    }
    this.marginsEl?.remove();
    this.marginsEl = null;
    this.leftRailEl = null;
    this.rightRailEl = null;
    this.connectionSvg = null;
    this.scroller = null;

    this.contentRoot?.removeClass("lpa-dark-pages");
    this.contentRoot?.removeClass("lpa-native-host");
    this.contentRoot
      ?.querySelectorAll<HTMLElement>(
        ".lpa-native-hl-layer, .lpa-native-note-layer, .lpa-native-margins"
      )
      .forEach((el) => el.remove());
    this.removeToolbarButtons();

    const store = this.store;
    this.store = null;
    if (store) {
      void store.flush().catch((e) => console.error(`${LOG_TAG} failed to save annotations`, e));
    }
    this.releasePdf();
    this.geoms.clear();
    this.geomPromises.clear();
    this.contentRoot = null;
  }

  private releasePdf(): void {
    try {
      this.pdfDoc?.destroy();
    } catch {}
    try {
      this.pdfWorker?.destroy();
    } catch {}
    this.pdfDoc = null;
    this.pageLabelsPromise = null;
    this.pdfWorker = null;
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (evt: Event) => void,
    options?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /** Whole-document text index from OUR pdf.js, for glyph-accurate anchoring
   * of selections whose DOM rects cannot be trusted (mobile text layer). */
  private getDocIndex(): Promise<any> {
    if (!this.docIndexPromise) {
      this.docIndexPromise = buildDocIndex(this.pdfDoc).catch((e) => {
        this.docIndexPromise = null;
        throw e;
      });
    }
    return this.docIndexPromise;
  }

  /** Obsidian's internal viewer (documented by community typings): gives the
   * pdf.js sidebar, toolbar element refs, and scale control. Everything using
   * it is defensive — when a future Obsidian changes the shape, features
   * degrade (floating list panel, no fit-width) instead of breaking. */
  private nativeViewer(): any {
    return (this.leaf.view as any)?.viewer?.child?.pdfViewer ?? null;
  }

  // ---- toolbar controls (inside the manager-owned group) -------------------

  ensureToolbarButtons(group: HTMLElement): void {
    if (this.destroyed) return;

    // Decide FIRST whether the swatch group has to be rebuilt, and if so clear
    // the old one before building anything else.
    //
    // Ordering matters more than it looks: removeToolbarButtons() also drops
    // the fit-width button and the sidebar Annotations tab. Running it after
    // those were (re)created destroyed them in the same call — closing an open
    // annotations list and leaving no way back to it, because the fallback list
    // button was skipped on the strength of a sidebar that had just been torn
    // down.
    const groupIsCurrent =
      !!this.tagBtn && this.tagBtn.isConnected && this.tagBtn.parentElement === group;
    if (!groupIsCurrent) this.removeToolbarButtons();

    this.ensureFitWidthButton();
    // BOTH pieces must exist before the list button may disappear: the
    // in-sidebar view AND the menu entry that opens it.
    const sidebarOk = this.ensureSidebarTab() && this.ensureSidebarMenuIntercept();
    // The list lives in the sidebar-options menu; the standalone button exists
    // only as a fallback while the native sidebar internals are unavailable
    // (they can appear a beat after the toolbar — drop the button then).
    if (sidebarOk && this.listBtn) {
      this.listBtn.remove();
      this.listBtn = null;
      // Leave an OPEN floating panel alone: the sidebar becoming available
      // mid-session is our business, not a reason to shut something the user
      // deliberately opened and may be reading.
    }
    if (groupIsCurrent) {
      this.syncToolbarState();
      return;
    }

    // Colors: click to ARM (selections then highlight instantly); click the
    // armed color again to disarm and get the popover-on-selection flow back.
    this.toolbarSwatchesEl = group.createDiv({ cls: "lpa-toolbar-swatches" });
    for (const p of PALETTE) {
      const sw = this.toolbarSwatchesEl.createEl("button", {
        cls: "lpa-swatch lpa-toolbar-swatch",
        attr: { type: "button", "aria-label": p.name, title: `${p.name} — click to highlight selections instantly` },
      });
      sw.setCssProps({ background: p.fill });
      sw.dataset.color = p.fill;
      sw.onclick = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const armedHere = this.pen?.getArmed() && this.currentColor === p.fill;
        this.currentColor = p.fill;
        this.pen?.set(this.currentColor, this.currentStyle);
        this.pen?.setArmed(!armedHere);
        this.syncToolbarState();
      };
    }

    this.toolbarStylesEl = group.createDiv({ cls: "lpa-toolbar-styles" });
    buildSelectionStyleRow(
      this.toolbarStylesEl,
      () => this.currentStyle,
      () => this.currentColor,
      (st) => {
        this.currentStyle = st;
        this.pen?.set(this.currentColor, this.currentStyle);
      }
    );

    this.tagBtn = group.createEl("button", {
      cls: "lpa-native-btn clickable-icon",
      attr: { type: "button", "aria-label": "Place a page note tag", title: "Place a page note tag" },
    });
    setIcon(this.tagBtn, "sticky-note");
    this.tagBtn.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.setTagMode(!this.tagMode);
    };

    if (!sidebarOk) {
      this.listBtn = group.createEl("button", {
        cls: "lpa-native-btn clickable-icon",
        attr: { type: "button", "aria-label": "Show annotations", title: "Show annotations" },
      });
      setIcon(this.listBtn, "list");
      this.listBtn.onclick = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (this.ensureSidebarTab()) {
          this.setSidebarAnnotationsActive(!this.sidebarActive);
        } else {
          this.toggleListPanel();
        }
      };
    }

    this.syncToolbarState();
  }

  /** "Fit width" beside the native zoom-in control. */
  private ensureFitWidthButton(): void {
    if (this.fitWidthBtn?.isConnected) return;
    this.fitWidthBtn?.remove();
    this.fitWidthBtn = null;
    const zoomInEl = this.nativeViewer()?.toolbar?.zoomInEl as HTMLElement | undefined;
    if (!zoomInEl?.isConnected) return;
    const btn = zoomInEl.ownerDocument.createElement("button");
    btn.className = "lpa-native-btn lpa-fit-width-btn clickable-icon";
    btn.setAttribute("type", "button");
    btn.setAttribute("aria-label", "Fit page width");
    btn.setAttribute("title", "Fit page width");
    setIcon(btn, "move-horizontal");
    btn.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const raw = this.nativeViewer()?.pdfViewer;
      if (raw && "currentScaleValue" in raw) raw.currentScaleValue = "page-width";
    };
    zoomInEl.insertAdjacentElement("afterend", btn);
    this.fitWidthBtn = btn;
    // NOTE: the native chevron next to this is Obsidian's zoom/layout menu —
    // it also carries the odd/even spread options, so it stays visible.
  }

  /** Annotations as a third native-sidebar choice: this prepares the
   * in-sidebar view; ensureSidebarMenuIntercept provides the menu entry.
   * Returns availability; callers fall back to the floating panel without
   * it. */
  private ensureSidebarTab(): boolean {
    if (this.destroyed) return false;
    if (this.sidebarViewEl?.isConnected) return true;
    const v = this.nativeViewer();
    const sidebar = v?.pdfSidebar;
    const content = (sidebar?.thumbnailView as HTMLElement | undefined)?.parentElement;
    if (!sidebar || !content) return false;

    this.sidebarViewEl?.remove();

    // Our tab view overlays the whole content area; anchor it to the
    // container even when the native DOM leaves it statically positioned.
    const win = content.ownerDocument.defaultView ?? window;
    if (win.getComputedStyle(content).position === "static") {
      // Obsidian's own element: remember that WE changed it so teardown can put
      // it back, instead of leaving the sidebar's containing block altered for
      // as long as the leaf lives.
      content.style.position = "relative";
      this.sidebarPositionPatched = content;
    }
    const view = content.createDiv({ cls: "lpa-sidebar-annotations" });
    this.buildListBody(view, false);
    this.sidebarViewEl = view;

    const bus = v?.eventBus;
    if (bus?.on) {
      // The tab is rebuilt whenever the toolbar group is recreated, and each
      // rebuild used to add ANOTHER subscription while the old one stayed live.
      // Two handlers then share one suppression counter: the first consumes it,
      // the second sees zero and immediately switches the panel we just opened
      // back off — leaving a list that looks active but never updates.
      this.detachSidebarBus();
      const onViewChanged = () => {
        // Opening the sidebar ourselves ALSO fires this event (the native
        // viewer restores its remembered view) — only a real user choice of
        // Thumbnails/Outline may take the panel back. Consume the suppression
        // on receipt; the timer merely clears a never-delivered one.
        if (this.suppressSidebarViewEvents > 0) {
          this.suppressSidebarViewEvents--;
          return;
        }
        if (this.sidebarActive) this.setSidebarAnnotationsActive(false);
      };
      bus.on("sidebarviewchanged", onViewChanged);
      this.sidebarBusOff = () => bus.off?.("sidebarviewchanged", onViewChanged);
    }
    // Re-activate from the remembered CHOICE: removeToolbarButtons() clears
    // sidebarActive, so keying off it meant a rebuilt toolbar dropped the user
    // back to thumbnails with the menu entry unchecked.
    if (this.sidebarWanted) this.setSidebarAnnotationsActive(true);
    return true;
  }

  /**
   * Obsidian shows the sidebar options as a NATIVE OS menu on some platforms —
   * no DOM exists to extend (verified on macOS). Take over the trigger: a
   * capture-phase listener suppresses the native menu and shows an identical
   * Obsidian menu with Annotations as the third choice.
   */
  private ensureSidebarMenuIntercept(): boolean {
    const trigger = this.nativeViewer()?.toolbar?.sidebarOptionsEl as HTMLElement | undefined;
    if (!trigger?.isConnected) return false;
    if (trigger === this.sidebarMenuTriggerEl) return true;
    this.sidebarMenuTriggerEl = trigger;
    const handler = (evt: Event) => {
      if (this.destroyed) return;
      evt.preventDefault();
      evt.stopImmediatePropagation();
      this.showSidebarMenu(trigger);
    };
    trigger.addEventListener("click", handler, { capture: true });
    this.cleanups.push(() => {
      trigger.removeEventListener("click", handler, { capture: true });
      if (this.sidebarMenuTriggerEl === trigger) this.sidebarMenuTriggerEl = null;
    });
    return true;
  }

  private showSidebarMenu(anchor: HTMLElement): void {
    const v = this.nativeViewer();
    const sidebar = v?.pdfSidebar;
    if (!sidebar) return;
    const menu = new Menu();
    const oursActive = this.sidebarActive;
    menu.addItem((item) =>
      item
        .setTitle("Thumbnails")
        .setChecked(!oursActive && sidebar.active === 1)
        .onClick(() => {
          this.setSidebarAnnotationsActive(false);
          sidebar.switchView?.(1, true);
        })
    );
    if (sidebar.haveOutline) {
      menu.addItem((item) =>
        item
          .setTitle("Table of contents")
          .setChecked(!oursActive && sidebar.active === 2)
          .onClick(() => {
            this.setSidebarAnnotationsActive(false);
            sidebar.switchView?.(2, true);
          })
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("Annotations")
        .setChecked(oursActive)
        .onClick(() => this.setSidebarAnnotationsActive(true))
    );
    if (sidebar.haveOutline) {
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("Reveal page in table of contents").onClick(() => {
          this.setSidebarAnnotationsActive(false);
          sidebar.switchView?.(2, true);
          const page = v?.pdfViewer?.currentPageNumber ?? v?.toolbar?.pageNumber;
          if (typeof page === "number") v?.pdfOutlineViewer?.setPageNumber?.(page);
        })
      );
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private setSidebarAnnotationsActive(on: boolean): void {
    if (on && !this.ensureSidebarTab()) {
      this.toggleListPanel();
      return;
    }
    this.sidebarActive = on;
    this.sidebarWanted = on;
    if (on) {
      const win = this.contentRoot?.ownerDocument.defaultView ?? window;
      this.suppressSidebarViewEvents++;
      try {
        this.nativeViewer()?.pdfSidebar?.open?.();
      } finally {
        win.setTimeout(() => {
          this.suppressSidebarViewEvents = Math.max(0, this.suppressSidebarViewEvents - 1);
        }, 150);
      }
      if (this.sidebarViewEl) this.renderListItemsInto(this.sidebarViewEl);
    }
    this.sidebarViewEl?.toggleClass("is-active", on);
    this.syncToolbarState();
  }

  private removeToolbarButtons(): void {
    this.toolbarSwatchesEl?.remove();
    this.toolbarSwatchesEl = null;
    this.toolbarStylesEl?.remove();
    this.toolbarStylesEl = null;
    this.tagBtn?.remove();
    this.tagBtn = null;
    this.listBtn?.remove();
    this.listBtn = null;
    this.countEl?.remove();
    this.countEl = null;
    this.fitWidthBtn?.remove();
    this.fitWidthBtn = null;
    this.detachSidebarBus();
    this.sidebarViewEl?.remove();
    this.sidebarViewEl = null;
    if (this.sidebarPositionPatched) {
      this.sidebarPositionPatched.style.removeProperty("position");
      this.sidebarPositionPatched = null;
    }
    this.sidebarActive = false;
    // The suppression counter belongs to the handler that just went away; a
    // leftover count would swallow the next genuine user view change.
    this.suppressSidebarViewEvents = 0;
  }

  private detachSidebarBus(): void {
    try {
      this.sidebarBusOff?.();
    } catch {
      /* the viewer may already be gone */
    }
    this.sidebarBusOff = null;
  }

  private syncToolbarState(): void {
    const armed = !!this.pen?.getArmed();
    if (this.toolbarSwatchesEl) {
      for (const sw of Array.from(this.toolbarSwatchesEl.children) as HTMLElement[]) {
        const isCurrent = sw.dataset.color === this.currentColor;
        sw.toggleClass("is-active", isCurrent);
        sw.toggleClass("is-armed", armed && isCurrent);
        sw.setAttribute("aria-pressed", armed && isCurrent ? "true" : "false");
      }
    }
    if (this.toolbarStylesEl) {
      for (const b of Array.from(
        this.toolbarStylesEl.querySelectorAll<HTMLElement>(".lpa-style-btn")
      )) {
        b.toggleClass("is-active", b.dataset.style === this.currentStyle);
        b.style.setProperty("--lpa-ink", markStrokeColor(this.currentColor));
        b.style.setProperty("--lpa-fill", resolvePalette(this.currentColor)?.fill ?? this.currentColor);
      }
    }
    this.tagBtn?.toggleClass("is-active", this.tagMode);
    this.tagBtn?.setAttribute("aria-pressed", this.tagMode ? "true" : "false");
    const listOn = !!this.listPanelEl || this.sidebarActive;
    this.listBtn?.toggleClass("is-active", listOn);
    this.listBtn?.setAttribute("aria-pressed", listOn ? "true" : "false");
  }

  private setTagMode(on: boolean): void {
    this.tagMode = on;
    this.contentRoot?.toggleClass("lpa-native-tag-mode", on);
    this.syncToolbarState();
  }

  private updateCount(): void {
    const n = this.store?.doc.highlights.length ?? 0;
    this.countEl?.setText(String(n));
    this.countEl?.setAttribute("title", `${n} ${n === 1 ? "annotation" : "annotations"}`);
  }

  private notifyStoreChanged(): void {
    this.updateCount();
    this.syncToolbarState();
    if (this.listPanelEl || this.sidebarActive) this.renderListItems();
    this.scheduleRailLayout();
  }

  // ---- page sync / painting -------------------------------------------------

  private onMutations(mutations: MutationRecord[]): void {
    for (const m of mutations) {
      const target = m.target instanceof HTMLElement ? m.target : m.target.parentElement;
      if (target?.closest(OWN_DOM_SELECTOR)) continue;
      this.scheduleSync();
      return;
    }
  }

  private scheduleSync(): void {
    if (this.destroyed || this.syncQueued) return;
    this.syncQueued = true;
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      this.syncQueued = false;
      this.syncPages();
    });
  }

  private syncPages(): void {
    if (this.destroyed || !this.contentRoot || !this.store) return;
    this.updateDarkPageState();
    const store = this.store;
    // One pass over the annotations instead of a full scan per page: this runs
    // on every native mutation batch, so `byPage()` per page made it
    // O(pages x annotations) — hundreds of thousands of comparisons per frame
    // while scrolling a long, heavily annotated document.
    const annotatedPages = new Set(store.doc.highlights.map((h) => h.page));
    const pageEls = this.contentRoot.querySelectorAll<HTMLElement>(".page[data-page-number]");
    for (const pageEl of Array.from(pageEls)) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      const idx = num - 1;
      // Skip untouched placeholder pages so a 500-page PDF doesn't load
      // geometry for every page up front; selection capture loads on demand.
      if (!isRenderedPage(pageEl) && !annotatedPages.has(idx)) continue;
      void this.syncPage(idx, pageEl);
    }
    this.scheduleRailLayout();
  }

  /** CSS snippets that invert the canvas (dark PDF pages) break multiply
   * blending — everything goes muddy. Detect the inversion on the live canvas
   * and let the stylesheet switch the highlight layers to screen blending. */
  private updateDarkPageState(): void {
    const root = this.contentRoot;
    if (!root) return;
    const canvas = root.querySelector<HTMLElement>(".canvasWrapper canvas");
    // `filter` does not inherit, so reading it off the canvas alone misses the
    // common case: snippets usually invert a CONTAINER (.pdf-viewer, .page).
    // Walk up to the content root and treat an inversion anywhere on the chain
    // as a dark page, or marks stay on multiply blending and turn to mud.
    let inverted = false;
    const win = root.ownerDocument.defaultView ?? window;
    // Walk past the content root as well: snippets commonly invert the leaf
    // container (.workspace-leaf-content[data-type="pdf"]), which sits ABOVE
    // it, and stopping at the root missed exactly those.
    const ceiling = root.closest(".workspace-leaf") ?? root.ownerDocument.body;
    for (let el: HTMLElement | null = canvas ?? root; el; el = el.parentElement) {
      // `invert(0)` / `invert(0%)` are resets, not inversions — a substring
       // test flips dark-page mode on a normal white page and washes the marks
       // out. Only a non-zero amount counts.
      const filter = win.getComputedStyle(el).filter;
      const match = /invert\(\s*([\d.]+)(%?)\s*\)/.exec(filter);
      if (match && Number(match[1]) > 0) {
        inverted = true;
        break;
      }
      if (el === ceiling) break;
    }
    if (inverted !== this.darkPages) {
      this.darkPages = inverted;
      root.toggleClass("lpa-dark-pages", inverted);
    }
  }

  private async syncPage(idx: number, pageEl: HTMLElement): Promise<void> {
    const geom = await this.ensureGeom(idx);
    if (!geom || this.destroyed || !pageEl.isConnected) return;

    const textLayer = pageEl.querySelector<HTMLElement>(":scope > .textLayer");
    let layer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-hl-layer");
    if (!layer) {
      layer = pageEl.ownerDocument.createElement("div");
      layer.className = "lpa-highlight-layer lpa-native-hl-layer";
      // Below the text layer in paint order so native selection stays crisp.
      if (textLayer) pageEl.insertBefore(layer, textLayer);
      else pageEl.appendChild(layer);
    } else if (textLayer && layer.compareDocumentPosition(textLayer) & Node.DOCUMENT_POSITION_PRECEDING) {
      // A native re-render put the text layer before our fills; restore order.
      pageEl.insertBefore(layer, textLayer);
    }
    let noteLayer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-note-layer");
    if (!noteLayer) {
      noteLayer = pageEl.ownerDocument.createElement("div");
      noteLayer.className = "lpa-note-layer lpa-native-note-layer";
      pageEl.appendChild(noteLayer);
    }
    this.paintPage(idx, pageEl, layer, noteLayer, geom);
  }

  private ensureGeom(idx: number): Promise<PageGeom | null> {
    const cached = this.geoms.get(idx);
    if (cached) return Promise.resolve(cached);
    let promise = this.geomPromises.get(idx);
    if (!promise) {
      promise = (async () => {
        try {
          if (!this.pdfDoc) return null;
          const page = await this.pdfDoc.getPage(idx + 1);
          const vp1 = page.getViewport({ scale: 1 });
          const geom: PageGeom = { vp1, w: vp1.width, h: vp1.height };
          if (!this.destroyed) this.geoms.set(idx, geom);
          return geom;
        } catch (e) {
          console.error(`${LOG_TAG} native overlay: failed to load geometry for page ${idx + 1}`, e);
          return null;
        }
      })();
      this.geomPromises.set(idx, promise);
    }
    return promise;
  }

  private paintPage(
    idx: number,
    pageEl: HTMLElement,
    layer: HTMLElement,
    noteLayer: HTMLElement,
    geom: PageGeom
  ): void {
    layer.empty();
    noteLayer.empty();
    const store = this.store;
    if (!store) return;

    // A page shown at a different rotation than our geometry would misplace
    // every mark — skip painting rather than paint wrong.
    const box = pageContentBox(pageEl);
    if (box && !this.pageMappable(box, geom)) {
      this.warnRotatedOnce();
      return;
    }
    const pxScale = box && geom.w > 0 ? box.width / geom.w : 1;

    const marks = store.byPage(idx).filter((h) => annotationTypeOf(h) === "highlight");

    // Fill highlights: coalesce + occlude (same policy as the custom view) so
    // overlapping fills never compound into a dark patch.
    const fillRects: PaintRect[] = [];
    let order = 0;
    for (const h of marks) {
      if (markStyleOf(h) !== "highlight") continue;
      order++;
      for (const r of rectsToBase(geom, h.rects)) {
        if (r.right - r.left < 0.25 || r.bottom - r.top < 0.25) continue;
        fillRects.push({
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          color: h.color,
          order,
          ids: new Set([h.id]),
          notes: h.note ? new Set([h.note]) : new Set<string>(),
        });
      }
    }
    for (const r of occludePaintRects(coalescePaintRects(fillRects))) {
      const div = layer.createDiv({ cls: "lpa-highlight lpa-mark--highlight" });
      applyPctBox(div, r, geom);
      div.style.setProperty("--lpa-hl-color", highlightPaintColor(r.color));
      div.style.setProperty("--lpa-hl-color-active", activeHighlightPaintColor(r.color));
      div.style.setProperty("--lpa-hl-color-active-gloss", activeHighlightGlossColor(r.color));
      div.style.setProperty("--lpa-hl-color-active-bridge", activeHighlightBridgeColor(r.color));
      div.style.setProperty("--lpa-hl-color-dark", highlightPaintColorDark(r.color));
      div.style.setProperty("--lpa-hl-color-active-dark", activeHighlightPaintColorDark(r.color));
      const ids = Array.from(r.ids);
      div.dataset.hlIds = ids.join(" ");
      if (ids.length === 1) div.dataset.hlId = ids[0];
      if (r.notes.size === 1) div.setAttribute("aria-label", Array.from(r.notes)[0]);
      div.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      div.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }

    // Decorative styles: one continuous stroke per visual line.
    const metrics = lineMetricsFor(pxScale);
    for (const h of marks) {
      const st = markStyleOf(h);
      if (st === "highlight") continue;
      for (const lr of mergeLineRects(rectsToBase(geom, h.rects))) {
        this.paintDecorativeLine(layer, h, st, lr, metrics, geom);
      }
    }

    for (const tag of store.byPage(idx).filter((h) => annotationTypeOf(h) === "tag")) {
      this.paintTag(noteLayer, tag);
    }
  }

  private paintDecorativeLine(
    layer: HTMLElement,
    h: Highlight,
    st: MarkStyle,
    lr: BaseRect,
    m: LineMetrics,
    geom: PageGeom
  ): void {
    const el = layer.createDiv({ cls: `lpa-highlight lpa-mark lpa-mark--${st}` });
    applyPctBox(el, lr, geom);
    const ink = markStrokeColor(h.color);
    el.style.setProperty("--lpa-ink", ink);
    el.style.setProperty("--lpa-w", `${m.weight}px`);
    el.style.setProperty("--lpa-hl-color-active", activeHighlightPaintColor(h.color));
    el.style.setProperty("--lpa-hl-color-active-gloss", activeHighlightGlossColor(h.color));
    el.style.setProperty("--lpa-hl-color-active-bridge", activeHighlightBridgeColor(h.color));
    el.style.setProperty("--lpa-hl-color-active-dark", activeHighlightPaintColorDark(h.color));
    if (st === "dashed") {
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${ink} 0 ${m.dash}px, transparent ${m.dash}px ${m.dash + m.dashGap}px)`
      );
    } else if (st === "dotted") {
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${ink} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else if (st === "comment") {
      const faint = withAlpha(ink, 0.5);
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${faint} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else {
      el.style.setProperty("--lpa-deco", ink);
    }
    el.dataset.hlIds = h.id;
    el.dataset.hlId = h.id;
    if (h.note) el.setAttribute("aria-label", h.note);
    el.toggleClass("is-active", h.id === this.activeId);
    el.toggleClass("is-hover", h.id === this.hoverId);
  }

  private paintTag(noteLayer: HTMLElement, tag: Highlight): void {
    if (!Number.isFinite(tag.tagX) || !Number.isFinite(tag.tagY)) return;
    const x = clamp(0, tag.tagX ?? 0, 100);
    const y = clamp(0, tag.tagY ?? 0, 100);
    const el = noteLayer.createDiv({ cls: "lpa-page-tag" });
    el.dataset.hlId = tag.id;
    el.dataset.annotationId = tag.id;
    el.setCssProps({ left: `${x}%`, top: `${y}%` });
    el.style.setProperty(
      "--lpa-accent",
      annotationAccent(annotationColor(tag))
    );
    el.toggleClass("is-pinned", !!tag.isPinned);
    el.toggleClass("is-active", tag.id === this.activeId);
    el.toggleClass("is-hover", tag.id === this.hoverId);
    el.createSpan({ cls: "lpa-tag-dot", attr: { "aria-hidden": "true" } });
    el.createSpan({ cls: "lpa-tag-preview", text: tagPreview(tag) });
    this.bindMarkHover(el, tag.id);
    el.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.openEditPopover(tag.id, evt.clientX, evt.clientY, { focusNote: true });
    });
  }

  /** Tags accept pointer events directly; highlight fills are
   * pointer-events:none (so text selection stays native) and get their hover
   * from the mousemove hit test instead. */
  private bindMarkHover(el: HTMLElement, id: string | undefined): void {
    if (!id) return;
    el.addEventListener("mouseenter", () => this.setHoveredAnnotation(id));
    el.addEventListener("mouseleave", () => this.clearHoveredAnnotationSoon(id));
  }

  private repaintPage(idx: number): void {
    const root = this.contentRoot;
    if (!root) return;
    const pageEl = root.querySelector<HTMLElement>(`.page[data-page-number="${idx + 1}"]`);
    if (pageEl) void this.syncPage(idx, pageEl);
  }

  private warnRotatedOnce(): void {
    if (this.warnedRotated) return;
    this.warnedRotated = true;
    new Notice(
      "PDF Annotator: this page is rotated in the native viewer — annotations are hidden there to avoid misplacement."
    );
  }

  // ---- geometry: DOM ↔ PDF user space ---------------------------------------

  private collectPageBoxes(): PageBox[] {
    const root = this.contentRoot;
    if (!root) return [];
    const out: PageBox[] = [];
    for (const pageEl of Array.from(root.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      // pdf.js creates a .page div for EVERY page up front, so measuring them
      // all means one forced layout per page of the document on every scroll
      // frame. Only pages it has actually rendered can be on screen, and every
      // caller here cares about on-screen pages.
      if (!isRenderedPage(pageEl)) continue;
      const box = pageContentBox(pageEl);
      if (!box) continue;
      out.push({ idx: num - 1, pageEl, box });
    }
    return out;
  }

  private pageBoxAtPoint(x: number, y: number): PageBox | null {
    return (
      this.collectPageBoxes().find(
        (b) => x >= b.box.left && x <= b.box.right && y >= b.box.top && y <= b.box.bottom
      ) ?? null
    );
  }

  private annotationAtPoint(x: number, y: number): Highlight | null {
    const store = this.store;
    if (!store) return null;
    const hit = this.pageBoxAtPoint(x, y);
    if (!hit) return null;
    const geom = this.geoms.get(hit.idx);
    if (!geom || !this.pageMappable(hit.box, geom)) return null;
    const [px, py] = clientToPdfPoint(x, y, hit.box, geom);
    const matches = store.byPage(hit.idx).filter(
      (h) =>
        annotationTypeOf(h) === "highlight" &&
        h.rects.some(
          (r) =>
            px >= Math.min(r.x1, r.x2) &&
            px <= Math.max(r.x1, r.x2) &&
            py >= Math.min(r.y1, r.y2) &&
            py <= Math.max(r.y1, r.y2)
        )
    );
    return matches[matches.length - 1] ?? null;
  }

  // ---- selection → highlight -------------------------------------------------

  private onMouseUp(evt: MouseEvent): void {
    if (this.destroyed || !this.store || this.tagMode) return;
    // Mobile capture flows solely through the debounced selectionchange
    // handler: the popup must wait until the selection stops changing (the
    // grabbers keep firing changes), never appear mid-adjustment.
    if (Platform.isMobile) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-selection-popover, .lpa-mark-popover, .lpa-native-controls, .lpa-native-roll, .lpa-native-margins")) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      void this.captureSelection(sel, evt.clientX, evt.clientY);
    }
  }

  private async captureSelection(sel: Selection, anchorX: number, anchorY: number): Promise<void> {
    const text = sel.toString().trim();
    if (!text) return;
    const boxes = this.collectPageBoxes();
    if (!boxes.length) return;

    const rawByPage = new Map<number, { box: DOMRect; rects: DOMRect[] }>();
    let selLeft = Infinity;
    let selRight = -Infinity;
    let selBottom = -Infinity;
    for (let ri = 0; ri < sel.rangeCount; ri++) {
      const range = sel.getRangeAt(ri);
      for (const cr of Array.from(range.getClientRects())) {
        if (cr.width < 1 || cr.height < 1) continue;
        const cx = cr.left + cr.width / 2;
        const cy = cr.top + cr.height / 2;
        const hit = boxes.find(
          (b) => cx >= b.box.left && cx <= b.box.right && cy >= b.box.top && cy <= b.box.bottom
        );
        if (!hit) continue;
        selLeft = Math.min(selLeft, cr.left);
        selRight = Math.max(selRight, cr.right);
        selBottom = Math.max(selBottom, cr.bottom);
        const entry = rawByPage.get(hit.idx) ?? { box: hit.box, rects: [] };
        entry.rects.push(cr);
        rawByPage.set(hit.idx, entry);
      }
    }
    if (rawByPage.size === 0) return;

    const byPage = new Map<number, PdfRect[]>();
    let rotated = false;
    for (const [idx, entry] of rawByPage) {
      const geom = await this.ensureGeom(idx);
      if (this.destroyed) return;
      if (!geom) continue;
      if (!this.pageMappable(entry.box, geom)) {
        rotated = true;
        continue;
      }
      const rects: PdfRect[] = [];
      for (const cr of entry.rects) {
        const p1 = clientToPdfPoint(cr.left, cr.top, entry.box, geom);
        const p2 = clientToPdfPoint(cr.right, cr.bottom, entry.box, geom);
        rects.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
      }
      if (rects.length) byPage.set(idx, rects);
    }
    if (rotated) this.warnRotatedOnce();
    if (byPage.size === 0) return;

    const context = selectionContext(sel, this.contentRoot);
    // Obsidian's MOBILE text layer can sit offset from the painted glyphs
    // (observed on iPad): the DOM selection rects inherit that offset. The
    // plugin's own pdf.js text geometry is glyph-accurate — re-anchor the
    // captured text through it and use those rects when they confidently
    // match, so committed marks land exactly on the words.
    let finalByPage = byPage;
    if (Platform.isMobile && this.pdfDoc) {
      try {
        const index = await this.getDocIndex();
        if (this.destroyed) return;
        // The index build can take a while on first use — if the user moved
        // on to a different (or no) selection meanwhile, commit nothing.
        const nowSel = this.contentRoot?.ownerDocument.getSelection();
        if (!nowSel || nowSel.isCollapsed || nowSel.toString().trim() !== text) return;
        const anchoredResults = anchorQuote(index, text, context?.prefix, context?.suffix);
        if (anchoredResults.length) {
          const anchored = new Map<number, PdfRect[]>();
          for (const r of anchoredResults) anchored.set(r.page, r.rects);
          // Every shared page must land near the DOM rects in BOTH axes —
          // a same-height wrong-column occurrence must not relocate the
          // highlight. Replacement is then PER PAGE: anchored rects win where
          // available, DOM rects are kept for pages the anchor missed, so a
          // legitimate short cross-page tail is never dropped.
          let nearDom = false;
          for (const [page, domRects] of byPage) {
            const anchoredRects = anchored.get(page);
            if (!anchoredRects?.length || !domRects.length) continue;
            const geom = this.geoms.get(page);
            const midY = (rects: PdfRect[]) =>
              rects.reduce((sum, r) => sum + (r.y1 + r.y2) / 2, 0) / rects.length;
            const midX = (rects: PdfRect[]) =>
              rects.reduce((sum, r) => sum + (r.x1 + r.x2) / 2, 0) / rects.length;
            const nearY =
              Math.abs(midY(anchoredRects) - midY(domRects)) <= (geom?.h ?? 800) * 0.2;
            const nearX =
              Math.abs(midX(anchoredRects) - midX(domRects)) <= (geom?.w ?? 600) * 0.3;
            if (!nearY || !nearX) {
              nearDom = false;
              break;
            }
            nearDom = true;
          }
          if (nearDom) {
            finalByPage = new Map(
              [...byPage].map(([page, domRects]) => [page, anchored.get(page) ?? domRects])
            );
          }
        }
      } catch (e) {
        console.warn(`${LOG_TAG} selection re-anchoring failed; keeping DOM rects`, e);
      }
    }

    this.pendingSelection = { text, byPage: finalByPage, context };
    // Anchor on the SELECTION, not the pointer: centered under its last line.
    const cx2 = Number.isFinite(selLeft) ? (selLeft + selRight) / 2 : anchorX;
    const cy2 = Number.isFinite(selBottom) ? selBottom : anchorY;
    if (this.pen?.getArmed()) {
      // A toolbar color is armed: the selection IS the highlight.
      this.currentColor = this.pen.getColor();
      this.currentStyle = this.pen.getStyle();
      this.commitSelection("highlight", cx2, cy2);
      return;
    }
    this.showSelectionPopover(cx2, cy2);
  }

  private showSelectionPopover(x: number, y: number): void {
    this.selectionPopoverEl?.remove();
    const root = this.contentRoot;
    if (!root) return;
    const doc = root.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-selection-popover is-right lpa-native-selection-popover" });
    this.selectionPopoverEl = pop;
    pop.style.setProperty(
      "--lpa-accent",
      annotationAccent(this.currentColor)
    );
    pop.onmousedown = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    pop.onpointerdown = (evt) => {
      // Keep the text selection alive through the tap/click on the popover.
      evt.preventDefault();
      evt.stopPropagation();
    };


    // Row 1 — colors. Clicking a color IS the commit: the mark is created
    // immediately with the current style; notes come from clicking the mark.
    const swatches = pop.createDiv({ cls: "lpa-selection-swatches", attr: { "aria-label": "Highlight color" } });
    for (const p of PALETTE) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name, title: p.name } });
      sw.setCssProps({ background: p.fill });
      sw.dataset.color = p.fill;
      sw.toggleClass("is-active", p.fill === this.currentColor);
      bindPopoverAction(sw, () => {
        this.currentColor = p.fill;
        this.pen?.set(this.currentColor, this.currentStyle);
        this.commitSelection("highlight", x, y);
      });
    }

    // Row 2 — styles (sets the pen; the next color click applies it).
    buildSelectionStyleRow(
      pop,
      () => this.currentStyle,
      () => this.currentColor,
      (st) => {
        this.currentStyle = st;
        this.pen?.set(this.currentColor, this.currentStyle);
      }
    );

    pop.setCssProps({ visibility: "hidden" });
    const pr = pop.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    // Centered under the selection; the larger mobile drop keeps clear of the
    // iOS text-selection callout.
    const gap = Platform.isMobile ? 56 : 12;
    const { edge, bottom } = popoverEdgeInsets(doc);
    const px = clamp(edge, x - pr.width / 2, Math.max(edge, vw - pr.width - edge));
    const py = clamp(edge, y + gap, Math.max(edge, vh - pr.height - bottom));
    pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });
  }

  /** User-applied viewer rotation in degrees (0/90/180/270); 0 if unavailable. */
  private viewerRotation(): number {
    const raw = Number(this.nativeViewer()?.pdfViewer?.pagesRotation ?? 0);
    return Number.isFinite(raw) ? ((raw % 360) + 360) % 360 : 0;
  }

  /**
   * Can this page box be mapped to PDF space?
   *
   * Aspect ratio alone catches 90°/270°, but 180° preserves it EXACTLY — so a
   * page rotated twice would pass, and every mark would be painted
   * point-reflected while new selections were stored with mirrored
   * coordinates, corrupting the sidecar. Ask the viewer for its rotation
   * instead of inferring it, and decline to map anything while it is turned.
   */
  private pageMappable(box: DOMRect | null | undefined, geom: PageGeom | null | undefined): boolean {
    if (!box || !geom) return false;
    if (this.viewerRotation() !== 0) return false;
    return aspectMatches(box, geom);
  }

  /** Does this selection start inside the plugin's own UI rather than the page? */
  private selectionStartsInOwnUi(sel: Selection): boolean {
    // A selection inside a text control lives in that control's shadow tree, so
    // closest() from the anchor node cannot see our popover above it. WebKit
    // (iPad) surfaces those selections through document.getSelection(), so
    // "select all" inside a note field would otherwise be captured and, with a
    // colour armed, committed as a phantom mark carrying the note's own text.
    const active = this.contentRoot?.ownerDocument.activeElement as HTMLElement | null;
    if (
      active &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT") &&
      active.closest(OWN_UI_SELECTOR)
    ) {
      return true;
    }
    const node = sel.anchorNode;
    const el = node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement;
    return !!el?.closest(OWN_UI_SELECTOR);
  }

  private hideSelectionPopover(clearNativeSelection: boolean): void {
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    if (clearNativeSelection) {
      this.contentRoot?.ownerDocument.getSelection()?.removeAllRanges();
    }
  }

  private onSelectionChange(): void {
    // Idle early-out: nothing to hide and no mobile follow-up needed.
    if (!Platform.isMobile && !this.selectionPopoverEl) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    const empty = !sel || sel.isCollapsed || sel.toString().trim().length === 0;
    if (this.selectionPopoverEl && empty) {
      this.hideSelectionPopover(false);
    }
    if (Platform.isMobile && !empty) {
      const win = this.contentRoot?.ownerDocument.defaultView ?? window;
      if (this.mobileSelectionTimer !== null) win.clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = win.setTimeout(() => {
        this.mobileSelectionTimer = null;
        // Same guards as the pointerup path — never create marks in tag mode
        // or after teardown.
        if (this.destroyed || !this.store || this.tagMode) return;
        const cur = this.contentRoot?.ownerDocument.getSelection();
        if (!cur || cur.isCollapsed || cur.toString().trim().length === 0) return;
        // Same origin check the pointerup path applies: text selected inside
        // our OWN panels (the annotations list, a popover) sits over the page,
        // so without this a long-press to copy a list entry commits a phantom
        // mark carrying the list's text at the panel's screen position.
        if (this.selectionStartsInOwnUi(cur)) return;
        const rects = cur.rangeCount ? Array.from(cur.getRangeAt(cur.rangeCount - 1).getClientRects()) : [];
        const last = rects[rects.length - 1];
        if (!last) return;
        void this.captureSelection(cur, last.right, last.bottom);
      }, Math.max(0, this.getMobileSelectionDelay()));
    }
  }

  private commitSelection(mode: "highlight" | "annotate", anchorX: number, anchorY: number): void {
    const pending = this.pendingSelection;
    const store = this.store;
    if (!pending || !store) return;
    const created: Highlight[] = [];
    for (const [pageIndex, rects] of pending.byPage) {
      const h: Highlight = {
        id: newId(),
        type: "highlight",
        page: pageIndex,
        color: this.currentColor,
        style: this.currentStyle,
        text: pending.text,
        rects,
        created: new Date().toISOString(),
        source: "manual",
        marginSide: "auto",
        isPinned: false,
      };
      if (mode === "annotate") h.note = "";
      if (pending.context?.prefix || pending.context?.suffix) h.context = pending.context;
      store.add(h);
      created.push(h);
    }
    this.hideSelectionPopover(true);
    for (const h of created) this.repaintPage(h.page);
    this.notifyStoreChanged();
    if (mode === "annotate" && created[0]) {
      this.openEditPopover(created[0].id, anchorX, anchorY, { focusNote: true });
    } else if (created[0]) {
      this.setActiveAnnotation(created[0].id);
    }
  }

  // ---- clicks: tags + mark editing --------------------------------------------

  private onClick(evt: MouseEvent): void {
    if (this.destroyed || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (
      target?.closest(
        ".pdf-toolbar, .lpa-page-tag, .lpa-native-controls, .lpa-native-roll, .lpa-mark-popover, .lpa-selection-popover, .lpa-native-margins, .lpa-sidebar-annotations"
      )
    ) {
      return;
    }
    if (this.tagMode) {
      const created = this.createTagAt(evt.clientX, evt.clientY);
      if (created) {
        evt.preventDefault();
        evt.stopPropagation();
        this.setTagMode(false);
        this.openEditPopover(created.id, evt.clientX, evt.clientY, { focusNote: true });
      }
      return;
    }
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Never hijack native PDF link/annotation clicks.
    if (target?.closest("a, .annotationLayer")) return;
    const hit = this.annotationAtPoint(evt.clientX, evt.clientY);
    if (hit) {
      evt.preventDefault();
      this.openEditPopover(hit.id, evt.clientX, evt.clientY, {});
    } else {
      this.setActiveAnnotation(null);
    }
  }

  private createTagAt(clientX: number, clientY: number): Highlight | null {
    const store = this.store;
    if (!store) return null;
    const hit = this.pageBoxAtPoint(clientX, clientY);
    if (!hit) return null;
    const xPct = clamp(0, ((clientX - hit.box.left) / Math.max(1, hit.box.width)) * 100, 100);
    const yPct = clamp(0, ((clientY - hit.box.top) / Math.max(1, hit.box.height)) * 100, 100);
    const tag: Highlight = {
      id: newId(),
      type: "tag",
      page: hit.idx,
      color: this.currentColor,
      tagColor: this.currentColor,
      tagX: xPct,
      tagY: yPct,
      text: "",
      note: "",
      rects: [],
      created: new Date().toISOString(),
      source: "manual",
      marginSide: "auto",
      isPinned: false,
    };
    store.add(tag);
    this.repaintPage(hit.idx);
    this.notifyStoreChanged();
    return tag;
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if ((evt.key === "Backspace" || evt.key === "Delete") && this.activeId) {
      // Document-level listener: only the focused pane may delete — or the
      // Annotations panel, when THIS view is the panel's active source.
      if (!mayHandleDocumentKeys(this.app, this.hub, this.leaf)) return;
      const target = evt.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      evt.preventDefault();
      const id = this.activeId;
      const page = this.store?.get(id)?.page;
      this.closeEditPopover();
      this.setActiveAnnotation(null);
      this.store?.remove(id);
      if (page !== undefined) this.repaintPage(page);
      this.notifyStoreChanged();
      return;
    }
    if (evt.key !== "Escape") return;
    if (this.tagMode) {
      this.setTagMode(false);
      return;
    }
    if (this.selectionPopoverEl) this.hideSelectionPopover(false);
  }

  /** Style + color + note editor for an existing mark or tag. */
  private openEditPopover(
    id: string,
    x: number,
    y: number,
    options: { focusNote?: boolean }
  ): void {
    const store = this.store;
    if (!store || !store.get(id)) return;
    this.closeEditPopover();
    this.setActiveAnnotation(id);
    const root = this.contentRoot;
    if (!root) return;
    this.editPopoverCleanup = openAnnotationEditor(
      {
        doc: root.ownerDocument,
        app: this.app,
        get: (hid) => store.get(hid),
        update: (hid, patch) => store.update(hid, patch),
        remove: (hid) => store.remove(hid),
        repaintPage: (page) => this.repaintPage(page),
        notifyChanged: () => this.notifyStoreChanged(),
        copyLink: (hid) => void this.copyAnnotationLink(hid),
        onClose: () => {
          this.editPopoverCleanup = null;
        },
      },
      id,
      x,
      y,
      options
    );
  }

  private closeEditPopover(): void {
    this.editPopoverCleanup?.();
    this.editPopoverCleanup = null;
  }

  // ---- margin rails: side note cards beside the native pages -------------------
  //
  // The native view owns its layout, so instead of reflowing it into a
  // three-column grid (what the custom view does) we pin an overlay to the
  // native scroller's box and position cards in the whitespace beside the
  // visible pages. Cards reuse the custom view's .lpa-margin-card styling and
  // behavior: anchored beside their mark, stacked without overlap, connected
  // by curved lines, expanding on hover/active, editable in place.

  private initMarginRail(): void {
    const root = this.contentRoot;
    if (!root) return;
    this.marginsEl = root.createDiv({ cls: "lpa-native-margins" });
    const svg = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("lpa-connection-layer", "lpa-native-connections");
    this.marginsEl.appendChild(svg);
    this.connectionSvg = svg;
    this.leftRailEl = this.marginsEl.createDiv({
      cls: "lpa-margin lpa-margin-left lpa-native-rail",
      attr: { "aria-label": "Left annotations" },
    });
    this.rightRailEl = this.marginsEl.createDiv({
      cls: "lpa-margin lpa-margin-right lpa-native-rail",
      attr: { "aria-label": "Right annotations" },
    });

    // Native PDF scrolling is owned by a nested `.pdf-viewer-container`.
    // Bind that element directly: its scroll events do not bubble reliably
    // through every Obsidian/Electron PDF-viewer composition.
    this.bindRailScroller(this.findScroller() ?? root);
    this.railResizeObserver = new ResizeObserver(() => this.scheduleRailLayout());
    this.railResizeObserver.observe(root);
    this.cleanups.push(() => {
      this.railScrollTarget?.removeEventListener("scroll", this.railScrollHandler);
      this.railScrollTarget = null;
      this.railResizeObserver?.disconnect();
      this.railResizeObserver = null;
    });
  }

  private onNativeScroll(): void {
    if (this.destroyed || !this.marginsEl) return;
    this.marginsEl.addClass("is-scrolling");
    this.scheduleRailLayout();
    const win = this.marginsEl.ownerDocument.defaultView ?? window;
    if (this.scrollSettleTimer !== null) win.clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = win.setTimeout(() => {
      this.scrollSettleTimer = null;
      this.marginsEl?.removeClass("is-scrolling");
      this.scheduleRailLayout();
    }, 120);
  }

  /** Re-apply UI-affecting settings (cards toggled, palette edited) live. */
  refreshUi(): void {
    this.scheduleSync();
    this.scheduleRailLayout();
  }

  /** Settle any pending debounced save (rename-follow). */
  async flushAnnotations(): Promise<void> {
    try {
      await this.store?.flush();
    } catch (e) {
      console.error(`${LOG_TAG} failed to save annotations`, e);
    }
  }

  private scheduleRailLayout(): void {
    if (this.destroyed || this.railRaf !== null || !this.marginsEl) return;
    const win = this.marginsEl.ownerDocument.defaultView ?? window;
    this.railRaf = win.requestAnimationFrame(() => {
      this.railRaf = null;
      this.layoutRail();
    });
  }

  /** The native scroll container that hosts the pages (excludes the PDF
   * thumbnail/outline sidebar, which lives beside it). */
  private findScroller(): HTMLElement | null {
    const root = this.contentRoot;
    if (!root) return null;
    if (this.scroller?.isConnected && root.contains(this.scroller)) return this.scroller;
    this.scroller = null;
    const page = root.querySelector<HTMLElement>(".page[data-page-number]");
    const win = root.ownerDocument.defaultView;
    let el: HTMLElement | null = page?.parentElement ?? null;
    while (el && el !== root) {
      const overflowY = win?.getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        this.scroller = el;
        break;
      }
      el = el.parentElement;
    }
    return this.scroller ?? root;
  }

  /** Keep the listener attached to the currently live native PDF scroller.
   * Obsidian can replace this element while rebuilding the PDF view. */
  private bindRailScroller(scroller: HTMLElement): void {
    if (this.railScrollTarget === scroller) return;
    this.railScrollTarget?.removeEventListener("scroll", this.railScrollHandler);
    this.railScrollTarget = scroller;
    scroller.addEventListener("scroll", this.railScrollHandler, { passive: true });
  }

  private layoutRail(): void {
    if (this.destroyed) return;
    const root = this.contentRoot;
    const margins = this.marginsEl;
    const store = this.store;
    if (!root || !margins || !this.leftRailEl || !this.rightRailEl || !store) return;
    if (!this.getShowMarginCards()) {
      this.clearRail();
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const scroller = this.findScroller() ?? root;
    this.bindRailScroller(scroller);
    // Track native zoom: page sizes change via the viewer's content element,
    // which may resize without any watched mutation. observe() is idempotent
    // and detached elements are dropped automatically.
    if (scroller !== root && this.railResizeObserver) {
      this.railResizeObserver.observe(scroller);
      if (scroller.firstElementChild instanceof HTMLElement) {
        this.railResizeObserver.observe(scroller.firstElementChild);
      }
    }
    const areaRect = scroller === root ? rootRect : scroller.getBoundingClientRect();
    if (areaRect.width < 60 || areaRect.height < 60) {
      this.clearRail();
      return;
    }
    margins.setCssProps({
      left: `${Math.round(areaRect.left - rootRect.left)}px`,
      top: `${Math.round(areaRect.top - rootRect.top)}px`,
      width: `${Math.round(areaRect.width)}px`,
      height: `${Math.round(areaRect.height)}px`,
    });

    // Visible pages with known geometry; kick off geometry loads for the rest.
    const pages = new Map<number, { box: DOMRect; geom: PageGeom }>();
    let pageLeft = Infinity;
    let pageRight = -Infinity;
    for (const b of this.collectPageBoxes()) {
      if (b.box.bottom <= areaRect.top || b.box.top >= areaRect.bottom) continue;
      const geom = this.geoms.get(b.idx);
      if (!geom) {
        if (store.byPage(b.idx).length > 0) {
          void this.ensureGeom(b.idx).then((g) => {
            if (g) this.scheduleRailLayout();
          });
        }
        continue;
      }
      if (!this.pageMappable(b.box, geom)) continue;
      pages.set(b.idx, { box: b.box, geom });
      pageLeft = Math.min(pageLeft, b.box.left);
      pageRight = Math.max(pageRight, b.box.right);
    }
    if (pages.size === 0) {
      this.clearRail();
      return;
    }

    const naturalLeftWidth = Math.max(0, pageLeft - areaRect.left);
    const naturalRightWidth = Math.max(0, areaRect.right - RAIL_SCROLLBAR_GUTTER - pageRight);
    this.railWidths = { left: naturalLeftWidth, right: naturalRightWidth };
    this.applyRailWidth(this.leftRailEl, naturalLeftWidth);
    this.applyRailWidth(this.rightRailEl, naturalRightWidth);
    this.rightRailEl.setCssProps({ right: `${RAIL_SCROLLBAR_GUTTER}px` });

    const desired: RailEntry[] = [];
    for (const [idx, page] of pages) {
      for (const h of store.byPage(idx)) {
        if (!this.wantsMarginCard(h)) continue;
        const anchor = this.computeNativeAnchor(h, page.box, page.geom, areaRect);
        if (!anchor) continue;
        const railWidth = anchor.side === "left" ? naturalLeftWidth : naturalRightWidth;
        if (railWidth < RAIL_HIDE_WIDTH) continue;
        desired.push({ h, anchor });
      }
    }

    this.reconcileRailCards(desired);
    this.stackRailCards(desired);
    this.drawRailConnections(desired, areaRect);
  }

  private clearRail(): void {
    this.railWidths = { left: 0, right: 0 };
    this.reconcileRailCards([]);
    const svg = this.connectionSvg;
    if (svg) while (svg.firstChild) svg.firstChild.remove();
  }

  private applyRailWidth(rail: HTMLElement, width: number): void {
    const rounded = Math.max(0, Math.round(width));
    rail.setCssProps({ width: `${rounded}px` });
    rail.toggleClass("is-collapsed", rounded < RAIL_HIDE_WIDTH);
    rail.toggleClass("is-tight", rounded >= RAIL_HIDE_WIDTH && rounded < 92);
    rail.toggleClass("is-compact", rounded >= 92 && rounded < 132);
    rail.toggleClass("is-roomy", rounded >= 180);
    rail.toggleClass("is-spacious", rounded >= 260);
  }

  /** Same policy as the custom view: tags show a card while pinned or engaged;
   * highlights show once they carry a note / side note / pin, or while engaged. */
  private wantsMarginCard(h: Highlight): boolean {
    if (!this.getShowMarginCards()) return false;
    if (annotationTypeOf(h) === "tag") {
      return !!h.isPinned || h.id === this.hoverId || h.id === this.activeId;
    }
    return (
      typeof h.note === "string" ||
      !!h.noteContentCJK ||
      !!h.isPinned ||
      h.id === this.hoverId ||
      h.id === this.activeId
    );
  }

  private computeNativeAnchor(
    h: Highlight,
    box: DOMRect,
    geom: PageGeom,
    areaRect: DOMRect
  ): NativeAnchor | null {
    const explicit = h.marginSide === "left" || h.marginSide === "right" ? h.marginSide : null;
    const pageLeftX = box.left - areaRect.left;
    const pageRightX = box.right - areaRect.left;
    const pageTopY = box.top - areaRect.top;
    const pageBottomY = box.bottom - areaRect.top;

    if (annotationTypeOf(h) === "tag") {
      if (typeof h.tagX !== "number" || typeof h.tagY !== "number") return null;
      const sourceX = pageLeftX + (clamp(0, h.tagX, 100) / 100) * box.width;
      const sourceY = box.top - areaRect.top + (clamp(0, h.tagY, 100) / 100) * box.height;
      const side = this.chooseRailSide(explicit, h.tagX < 50 ? "left" : "right");
      return {
        side,
        sourceX,
        sourceY,
        idealY: sourceY,
        pageTopY,
        pageBottomY,
        pageLeftX,
        pageRightX,
      };
    }

    if (h.rects.length === 0) return null;
    const base = rectsToBase(geom, h.rects).filter(
      (r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5
    );
    if (base.length === 0) return null;
    const lines = mergeLineRects(base);
    const first = lines[0] ?? base[0];
    const left = Math.min(...base.map((r) => r.left));
    const right = Math.max(...base.map((r) => r.right));
    const sx = box.width / geom.w;
    const sy = box.height / geom.h;
    const side = this.chooseRailSide(explicit, (left + right) / 2 < geom.w / 2 ? "left" : "right");
    const sourceEdge = side === "left" ? left : right;
    return {
      side,
      sourceX: pageLeftX + sourceEdge * sx,
      sourceY: box.top - areaRect.top + ((first.top + first.bottom) / 2) * sy,
      idealY: box.top - areaRect.top + first.top * sy,
      pageTopY,
      pageBottomY,
      pageLeftX,
      pageRightX,
    };
  }

  private chooseRailSide(
    explicit: "left" | "right" | null,
    preferred: "left" | "right"
  ): "left" | "right" {
    if (explicit) return explicit;
    const { left, right } = this.railWidths;
    const readable = 82;
    const materialDifference = 28;
    if (preferred === "left" && left < readable && right >= readable && right > left + materialDifference) {
      return "right";
    }
    if (preferred === "right" && right < readable && left >= readable && left > right + materialDifference) {
      return "left";
    }
    return preferred;
  }

  /** Create/keep/remove card DOM to match `desired` without disturbing a card
   * the user is currently typing in. */
  private reconcileRailCards(desired: RailEntry[]): void {
    const margins = this.marginsEl;
    if (!margins) return;
    const doc = margins.ownerDocument;
    const focused = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const wanted = new Map(desired.map((d) => [d.h.id, d]));

    for (const card of Array.from(margins.querySelectorAll<HTMLElement>(".lpa-native-rail > .lpa-margin-card"))) {
      const id = card.dataset.hlId ?? "";
      const entry = wanted.get(id);
      const holdsFocus = !!focused && card.contains(focused);
      if (!entry) {
        // Keep a card alive while the user is typing in it, even if its page
        // scrolled out of view; it goes away on the next pass after blur.
        if (!holdsFocus) card.remove();
        continue;
      }
      const rail = entry.anchor.side === "left" ? this.leftRailEl : this.rightRailEl;
      // Re-parenting a focused element would blur it mid-edit; defer the move.
      if (rail && card.parentElement !== rail && !holdsFocus) rail.appendChild(card);
      this.syncCardContent(card, entry.h);
      wanted.delete(id);
    }
    for (const entry of wanted.values()) {
      const rail = entry.anchor.side === "left" ? this.leftRailEl : this.rightRailEl;
      if (rail) this.createRailCard(rail, entry.h, entry.anchor.side);
    }
  }

  private createRailCard(rail: HTMLElement, h: Highlight, side: "left" | "right"): HTMLElement {
    const type = annotationTypeOf(h);
    const card = rail.createDiv({ cls: `lpa-margin-card lpa-native-card lpa-margin-card--${type}` });
    card.dataset.hlId = h.id;
    card.dataset.annotationId = h.id;
    card.dataset.side = side;
    card.dataset.placement = "rail";

    card.addEventListener("mouseenter", () => this.setHoveredAnnotation(h.id));
    card.addEventListener("mouseleave", () => this.clearHoveredAnnotationSoon(h.id));
    card.addEventListener("contextmenu", (evt) => this.openAnnotationContextMenu(evt, h.id));
    card.addEventListener("click", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest("textarea,button")) return;
      this.setActiveAnnotation(h.id);
      void this.revealAnnotation(h.id);
    });
    card.addEventListener("dblclick", (evt) => {
      evt.preventDefault();
      this.focusRailNote(h.id);
    });
    card.addEventListener("transitionend", (evt) => {
      if (evt.propertyName === "max-height") this.scheduleRailLayout();
    });

    const head = card.createDiv({ cls: "lpa-margin-card-head" });
    head.createSpan({ cls: "lpa-margin-dot", attr: { "aria-hidden": "true" } });
    head.createSpan({ cls: "lpa-margin-page", text: `p.${h.page + 1}` });
    const pin = head.createEl("button", { cls: "lpa-pin-btn", text: "⌖" });
    pin.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleAnnotationPin(h.id);
    };

    const note = card.createEl("textarea", {
      cls: "lpa-margin-note",
      attr: {
        placeholder: type === "tag" ? "Page note" : "Note",
        rows: "2",
        "aria-label": type === "tag" ? "Page note" : "Annotation note",
      },
    });
    note.value = h.note ?? "";
    note.onfocus = () => this.setActiveAnnotation(h.id);
    note.oninput = () => {
      // Store + page marks + list panel, but no card rebuild: the rebuild
      // path skips value writes on the focused textarea anyway.
      this.store?.update(h.id, { note: note.value });
      syncMarginCardPresentation(card);
      this.repaintPage(h.page);
      this.updateCount();
      if (this.listPanelEl) this.renderListItems();
      this.scheduleRailLayout();
    };

    if (type === "highlight" && h.text) {
      card.createDiv({ cls: "lpa-margin-source", text: marginCardSourceText(h.text) });
    }

    const sideNote = card.createEl("textarea", {
      cls: "lpa-margin-side-note",
      attr: { placeholder: "Side note", rows: "2", "aria-label": "Side note" },
    });
    sideNote.value = h.noteContentCJK ?? "";
    sideNote.onfocus = () => this.setActiveAnnotation(h.id);
    sideNote.oninput = () => {
      this.store?.update(h.id, { noteContentCJK: sideNote.value.trim() ? sideNote.value : undefined });
      syncMarginCardPresentation(card);
      if (this.listPanelEl) this.renderListItems();
      this.scheduleRailLayout();
    };

    this.syncCardContent(card, h);
    return card;
  }

  /** Refresh a card's accent/state/text from the store (skipping any textarea
   * that currently has focus, so in-place edits are never clobbered). */
  private syncCardContent(card: HTMLElement, h: Highlight): void {
    const pal = resolvePalette(annotationColor(h));
    card.style.setProperty("--lpa-accent", annotationAccent(annotationColor(h)));
    card.style.setProperty("--lpa-sticker-bg", stickerBackgroundColor(annotationColor(h), 0.34));
    card.style.setProperty("--lpa-sticker-bg-strong", stickerBackgroundColor(annotationColor(h), 0.52));
    card.toggleClass("is-pinned", !!h.isPinned);
    card.toggleClass("is-active", h.id === this.activeId);
    card.toggleClass("is-hover", h.id === this.hoverId);
    card.toggleClass(
      "is-expanded",
      !!h.isPinned || h.id === this.activeId || h.id === this.hoverId
    );
    const doc = card.ownerDocument;
    const note = card.querySelector<HTMLTextAreaElement>(".lpa-margin-note");
    if (note && doc.activeElement !== note && note.value !== (h.note ?? "")) {
      note.value = h.note ?? "";
    }
    const sideNote = card.querySelector<HTMLTextAreaElement>(".lpa-margin-side-note");
    if (sideNote && doc.activeElement !== sideNote && sideNote.value !== (h.noteContentCJK ?? "")) {
      sideNote.value = h.noteContentCJK ?? "";
    }
    syncMarginCardPresentation(card);
    const pin = card.querySelector<HTMLElement>(".lpa-pin-btn");
    if (pin) {
      const label = h.isPinned ? "Unpin annotation card" : "Pin annotation card";
      pin.setAttribute("aria-label", label);
      pin.setAttribute("title", h.isPinned ? "Unpin" : "Pin");
    }
  }

  /** Stack each page's cards inside that page's moving vertical band. */
  private stackRailCards(desired: RailEntry[]): void {
    const byId = new Map(desired.map((d) => [d.h.id, d]));
    for (const rail of [this.leftRailEl, this.rightRailEl]) {
      if (!rail) continue;
      const cards = Array.from(rail.querySelectorAll<HTMLElement>(".lpa-margin-card"));
      const gap = 5;
      const groups = new Map<number, Array<{ card: HTMLElement; entry: RailEntry }>>();
      for (const card of cards) {
        const entry = byId.get(card.dataset.hlId ?? "");
        if (!entry) continue; // focused off-screen orphan: hold its last position
        const group = groups.get(entry.h.page) ?? [];
        group.push({ card, entry });
        groups.set(entry.h.page, group);
      }
      for (const group of groups.values()) {
        const anchor = group[0].entry.anchor;
        applyMarginCardDensity(
          group.map(({ card }) => card),
          Math.max(1, anchor.pageBottomY - anchor.pageTopY),
          gap
        );
      }
      const items = Array.from(groups.values()).flat().map(({ card, entry }) => ({
        card,
        entry,
        height: measureMarginCardHeight(card),
      }));
      const tops = layoutPageBoundedCardTops(
        items.map(({ entry, height }) => ({
          page: entry.h.page,
          idealY: entry.anchor.idealY,
          height,
          pageTopY: entry.anchor.pageTopY,
          pageBottomY: entry.anchor.pageBottomY,
        })),
        gap
      );
      items.forEach((item, index) => {
        item.card.setCssProps({ top: `${Math.round(tops[index])}px` });
      });
    }
  }

  private drawRailConnections(desired: RailEntry[], areaRect: DOMRect): void {
    const svg = this.connectionSvg;
    const margins = this.marginsEl;
    if (!svg || !margins) return;
    while (svg.firstChild) svg.firstChild.remove();
    const w = Math.max(1, Math.round(areaRect.width));
    const hgt = Math.max(1, Math.round(areaRect.height));
    svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    svg.setAttribute("width", `${w}`);
    svg.setAttribute("height", `${hgt}`);
    const marginsRect = margins.getBoundingClientRect();
    const svgNS = "http://www.w3.org/2000/svg";

    for (const { h, anchor } of desired) {
      const card = margins.querySelector<HTMLElement>(
        `.lpa-margin-card[data-hl-id="${cssEscape(h.id)}"]`
      );
      if (!card) continue;
      const cardRect = card.getBoundingClientRect();
      const cardX =
        anchor.side === "left" ? cardRect.right - marginsRect.left : cardRect.left - marginsRect.left;
      const cardY = cardRect.top + cardRect.height / 2 - marginsRect.top;
      const borderX = anchor.side === "left" ? anchor.pageLeftX : anchor.pageRightX;
      const accent = annotationAccent(annotationColor(h));
      const isTag = annotationTypeOf(h) === "tag";
      const engaged = h.id === this.hoverId || h.id === this.activeId;
      const d = isTag
        ? `M ${anchor.sourceX},${anchor.sourceY} C ${borderX},${anchor.sourceY} ${borderX},${cardY} ${cardX},${cardY}`
        : `M ${cardX},${cardY} C ${borderX},${cardY} ${borderX},${anchor.sourceY} ${anchor.sourceX},${anchor.sourceY}`;
      const path = margins.ownerDocument.createElementNS(svgNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", accent);
      path.classList.add(
        "lpa-connection-line",
        isTag ? "lpa-connection-line--tag" : "lpa-connection-line--highlight"
      );
      if (engaged) path.classList.add("is-hover");
      if (h.isPinned) path.classList.add("is-pinned");
      svg.appendChild(path);

      const dot = margins.ownerDocument.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", `${cardX}`);
      dot.setAttribute("cy", `${cardY}`);
      dot.setAttribute("r", engaged ? "2.5" : "2");
      dot.setAttribute("fill", accent);
      dot.classList.add("lpa-connection-dot");
      if (engaged) dot.classList.add("is-hover");
      if (h.isPinned) dot.classList.add("is-pinned");
      svg.appendChild(dot);
    }
  }

  private focusRailNote(id: string): void {
    const margins = this.marginsEl;
    if (!margins) return;
    const win = margins.ownerDocument.defaultView ?? window;
    win.setTimeout(() => {
      const note = margins.querySelector<HTMLTextAreaElement>(
        `.lpa-margin-card[data-hl-id="${cssEscape(id)}"] .lpa-margin-note`
      );
      note?.focus({ preventScroll: true });
      if (note) note.selectionStart = note.selectionEnd = note.value.length;
    }, 0);
  }

  private toggleAnnotationPin(id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    this.store?.update(id, { isPinned: !h.isPinned });
    this.repaintPage(h.page);
    this.notifyStoreChanged();
  }

  private openAnnotationContextMenu(evt: MouseEvent, id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    evt.preventDefault();
    evt.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Edit annotation")
        .setIcon("pencil")
        .onClick(() => this.openEditPopover(id, evt.clientX, evt.clientY, { focusNote: true }))
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy link")
        .setIcon("link")
        .onClick(() => void this.copyAnnotationLink(id))
    );
    if (this.getShowMarginCards()) {
      menu.addItem((item) =>
        item
          .setTitle(h.isPinned ? "Unpin card" : "Pin card")
          .setIcon("pin")
          .onClick(() => this.toggleAnnotationPin(id))
      );
      const moveTo = (side: "left" | "right" | "auto") => {
        this.store?.update(id, { marginSide: side });
        this.notifyStoreChanged();
      };
      menu.addItem((item) =>
        item.setTitle("Move card to left margin").setIcon("arrow-left").onClick(() => moveTo("left"))
      );
      menu.addItem((item) =>
        item.setTitle("Move card to right margin").setIcon("arrow-right").onClick(() => moveTo("right"))
      );
      menu.addItem((item) =>
        item.setTitle("Auto-place card").setIcon("wand").onClick(() => moveTo("auto"))
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete annotation")
        .setIcon("trash")
        .onClick(() => {
          const page = this.store?.get(id)?.page ?? h.page;
          this.store?.remove(id);
          this.repaintPage(page);
          this.notifyStoreChanged();
        })
    );
    menu.showAtMouseEvent(evt);
  }

  /** Right-click on a painted mark or tag: rects are pointer-events:none, so
   * hit-test in JS and only hijack the native menu on an actual hit. */
  private onContextMenu(evt: MouseEvent): void {
    if (this.destroyed || !this.store) return;
    if (Platform.isPhone) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest(OWN_DOM_SELECTOR)) return;
    if (target?.closest(".pdf-toolbar, .lpa-mark-popover, .lpa-selection-popover, a, .annotationLayer")) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
    const hit = this.annotationAtPoint(evt.clientX, evt.clientY);
    if (!hit) return;
    this.openAnnotationContextMenu(evt, hit.id);
  }

  private async copyAnnotationLink(id: string): Promise<void> {
    const h = this.store?.get(id);
    if (!h) return;
    await copyHighlightLink(
      this.app,
      this.file,
      h,
      [
        // The native text layer is the ONLY safe source for selection indices:
        // Obsidian stamps [data-idx] with exactly the indices its own links
        // resolve to. Indices from our pinned pdf.js could differ (text-item
        // segmentation changed across pdf.js majors), so when the page is not
        // rendered we degrade to a page link instead of risking wrong words.
        () => this.nativeChunksForPage(h.page),
      ],
      async () => {
        const geom = await this.ensureGeom(h.page);
        return geom ? { w: geom.w, h: geom.h } : null;
      }
    );
  }

  /** Text-item chunks for a rendered native page, indexed by [data-idx].
   * Direct children only, and any duplicate index bails out — a corrupted map
   * must degrade to a page link, never emit wrong offsets. */
  private nativeChunksForPage(pageIndex: number): string[] | null {
    const root = this.contentRoot;
    if (!root) return null;
    const pageEl = root.querySelector<HTMLElement>(`.page[data-page-number="${pageIndex + 1}"]`);
    const nodes = pageEl?.querySelectorAll<HTMLElement>(":scope > .textLayer > [data-idx]");
    if (!nodes || !nodes.length) return null;
    const chunks: string[] = [];
    for (const el of Array.from(nodes)) {
      const idx = Number(el.dataset.idx);
      if (!Number.isFinite(idx) || idx < 0) return null;
      if (chunks[idx] !== undefined) return null;
      chunks[idx] = el.textContent ?? "";
    }
    for (let i = 0; i < chunks.length; i++) if (chunks[i] === undefined) chunks[i] = "";
    return chunks;
  }

  // ---- hover / active binding between marks, tags, and cards -------------------

  /** Highlight fills are pointer-events:none so native text selection stays
   * intact — hover comes from hit-testing the pointer against the page under
   * it (rAF-throttled; only the hovered page's rects are checked). */
  private onPointerMove(evt: MouseEvent): void {
    if (this.destroyed || this.tagMode || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (
      target?.closest(
        ".lpa-native-margins, .lpa-native-roll, .lpa-native-controls, .lpa-mark-popover, .lpa-selection-popover, .lpa-page-tag"
      )
    ) {
      return;
    }
    this.lastPointer = {
      x: evt.clientX,
      y: evt.clientY,
      pageEl: target?.closest<HTMLElement>(".page[data-page-number]") ?? null,
    };
    if (this.pointerRaf !== null) return;
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    this.pointerRaf = win.requestAnimationFrame(() => {
      this.pointerRaf = null;
      if (this.destroyed || !this.lastPointer) return;
      const hit = this.hoveredHighlightAt(this.lastPointer);
      if (hit) this.setHoveredAnnotation(hit.id);
      else if (this.hoverId) this.clearHoveredAnnotationSoon(this.hoverId);
    });
  }

  private hoveredHighlightAt(p: { x: number; y: number; pageEl: HTMLElement | null }): Highlight | null {
    const store = this.store;
    if (!store || !p.pageEl || !p.pageEl.isConnected) return null;
    const num = Number(p.pageEl.getAttribute("data-page-number"));
    if (!Number.isFinite(num) || num < 1) return null;
    const idx = num - 1;
    const geom = this.geoms.get(idx);
    const box = pageContentBox(p.pageEl);
    if (!geom || !box || !this.pageMappable(box, geom)) return null;
    const [px, py] = clientToPdfPoint(p.x, p.y, box, geom);
    const matches = store.byPage(idx).filter(
      (h) =>
        annotationTypeOf(h) === "highlight" &&
        h.rects.some(
          (r) =>
            px >= Math.min(r.x1, r.x2) &&
            px <= Math.max(r.x1, r.x2) &&
            py >= Math.min(r.y1, r.y2) &&
            py <= Math.max(r.y1, r.y2)
        )
    );
    return matches[matches.length - 1] ?? null;
  }

  private setHoveredAnnotation(id: string | null): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    const next = id && this.store?.get(id) ? id : null;
    if (this.hoverId === next) return;
    const prev = this.hoverId;
    this.hoverId = next;
    if (this.dynamicTagCardDependsOn(prev) || this.dynamicTagCardDependsOn(next)) {
      this.scheduleRailLayout();
    }
    this.syncBindingState();
  }

  private clearHoveredAnnotationSoon(id?: string): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) win.clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = win.setTimeout(() => {
      this.hoverClearTimer = null;
      if (!id || this.hoverId === id) this.setHoveredAnnotation(null);
    }, 120);
  }

  private setActiveAnnotation(id: string | null): void {
    const next = id && this.store?.get(id) ? id : null;
    if (this.activeId === next) return;
    const prev = this.activeId;
    this.activeId = next;
    // Tell the panel: it highlights this annotation and Delete removes it.
    this.hub?.noteActiveAnnotationChanged(null);
    if (this.dynamicTagCardDependsOn(prev) || this.dynamicTagCardDependsOn(next)) {
      this.scheduleRailLayout();
    }
    this.syncBindingState();
    for (const panel of [this.listPanelEl, this.sidebarViewEl]) {
      if (!panel) continue;
      for (const item of Array.from(panel.querySelectorAll<HTMLElement>(".lpa-native-roll-item"))) {
        item.toggleClass("is-active", item.dataset.hlId === next);
      }
    }
  }

  /** Unpinned tag cards only exist while engaged, so hover/active transitions
   * on them change the card set, not just classes. */
  private dynamicTagCardDependsOn(id: string | null): boolean {
    if (!id) return false;
    const h = this.store?.get(id);
    return !!h && annotationTypeOf(h) === "tag" && !h.isPinned;
  }

  private syncBindingState(): void {
    const root = this.contentRoot;
    if (!root) return;
    if (this.marginsEl) {
      for (const card of Array.from(this.marginsEl.querySelectorAll<HTMLElement>(".lpa-margin-card"))) {
        const id = card.dataset.hlId ?? "";
        const pinned = !!id && !!this.store?.get(id)?.isPinned;
        card.toggleClass("is-active", !!id && id === this.activeId);
        card.toggleClass("is-hover", !!id && id === this.hoverId);
        card.toggleClass("is-expanded", pinned || (!!id && (id === this.activeId || id === this.hoverId)));
        syncMarginCardPresentation(card);
      }
      this.scheduleRailLayout();
    }
    for (const mark of Array.from(root.querySelectorAll<HTMLElement>(".lpa-native-hl-layer .lpa-highlight"))) {
      const ids = (mark.dataset.hlIds ?? "").split(/\s+/).filter(Boolean);
      mark.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      mark.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }
    for (const tag of Array.from(root.querySelectorAll<HTMLElement>(".lpa-native-note-layer .lpa-page-tag"))) {
      const id = tag.dataset.hlId ?? "";
      tag.toggleClass("is-active", !!id && id === this.activeId);
      tag.toggleClass("is-hover", !!id && id === this.hoverId);
    }
    // Connection strokes carry hover emphasis too.
    this.scheduleRailLayout();
  }

  // ---- annotation list panel ---------------------------------------------------

  private toggleListPanel(): void {
    if (this.listPanelEl) {
      this.closeListPanel();
      return;
    }
    const root = this.contentRoot;
    if (!root || !this.store) return;
    const panel = root.createDiv({ cls: "lpa-native-roll" });
    this.listPanelEl = panel;
    this.buildListBody(panel, true);
    this.renderListItems();
    this.syncToolbarState();
  }

  /** Search box + list; shared by the floating panel and the sidebar tab. */
  private buildListBody(panel: HTMLElement, withClose: boolean): void {
    const head = panel.createDiv({ cls: "lpa-native-roll-head" });
    head.createSpan({ cls: "lpa-native-roll-title", text: "Annotations" });
    head.createSpan({ cls: "lpa-native-roll-meta", text: "" });
    if (withClose) {
      const close = head.createEl("button", {
        cls: "lpa-native-roll-close",
        text: "×",
        attr: { type: "button", "aria-label": "Hide annotations" },
      });
      close.onclick = () => this.closeListPanel();
    }
    const search = panel.createEl("input", {
      cls: "lpa-native-roll-search",
      attr: { type: "search", placeholder: "Search annotations", "aria-label": "Search annotations" },
    });
    search.value = this.listSearchQuery;
    search.oninput = () => {
      this.listSearchQuery = search.value;
      this.renderListItems();
    };
    panel.createDiv({ cls: "lpa-native-roll-list" });
  }

  private closeListPanel(): void {
    this.listPanelEl?.remove();
    this.listPanelEl = null;
    this.syncToolbarState();
  }

  private renderListItems(): void {
    for (const panel of [this.listPanelEl, this.sidebarActive ? this.sidebarViewEl : null]) {
      if (panel) this.renderListItemsInto(panel);
    }
  }

  private renderListItemsInto(panel: HTMLElement): void {
    const store = this.store;
    if (!store) return;
    const listEl = panel.querySelector<HTMLElement>(".lpa-native-roll-list");
    const metaEl = panel.querySelector<HTMLElement>(".lpa-native-roll-meta");
    if (!listEl) return;

    const annotations = [...store.doc.highlights].sort(
      (a, b) => a.page - b.page || a.created.localeCompare(b.created)
    );
    const query = normalizeSearch(this.listSearchQuery);
    const filtered = query ? annotations.filter((h) => annotationMatchesSearch(h, query)) : annotations;
    metaEl?.setText(query ? `${filtered.length}/${annotations.length}` : String(annotations.length));

    listEl.empty();
    if (annotations.length === 0) {
      listEl.createDiv({ cls: "lpa-native-roll-empty", text: "No annotations yet." });
      return;
    }
    if (filtered.length === 0) {
      listEl.createDiv({ cls: "lpa-native-roll-empty", text: "No matching annotations." });
      return;
    }
    for (const h of filtered) {
      const item = listEl.createDiv({ cls: "lpa-native-roll-item" });
      item.dataset.hlId = h.id;
      item.toggleClass("is-active", h.id === this.activeId);
      item.style.setProperty(
        "--lpa-accent",
        annotationAccent(annotationColor(h))
      );
      const head = item.createDiv({ cls: "lpa-native-roll-item-head" });
      head.createSpan({ cls: "lpa-native-roll-page", text: `p.${h.page + 1}` });
      head.createSpan({ cls: "lpa-native-roll-kind", text: annotationKindLabel(h) });
      item.createDiv({ cls: "lpa-native-roll-text", text: rollPrimaryText(h) });
      const secondary = rollSecondaryText(h);
      if (secondary) item.createDiv({ cls: "lpa-native-roll-source", text: secondary });
      item.onclick = () => void this.revealAnnotation(h.id);
    }
  }

  private async revealAnnotation(id: string): Promise<void> {
    const h = this.store?.get(id);
    const root = this.contentRoot;
    if (!h || !root) return;
    this.setActiveAnnotation(id);
    const pageEl = await this.navigateNativeToPage(h.page);
    if (!pageEl) return;
    pageEl.scrollIntoView({ block: "center" });
    this.scheduleRailLayout();
    // The native viewer renders lazily; poll briefly for the painted mark.
    const isTag = annotationTypeOf(h) === "tag";
    for (let i = 0; i < 12; i++) {
      await sleep(150);
      if (this.destroyed || !pageEl.isConnected) return;
      let el: HTMLElement | null = null;
      if (isTag) {
        el = pageEl.querySelector<HTMLElement>(
          `.lpa-native-note-layer .lpa-page-tag[data-hl-id="${cssEscape(id)}"]`
        );
      } else {
        el =
          Array.from(pageEl.querySelectorAll<HTMLElement>(".lpa-native-hl-layer .lpa-highlight")).find(
            (cand) => (cand.dataset.hlIds ?? "").split(/\s+/).includes(id)
          ) ?? null;
      }
      if (el) {
        el.addClass("lpa-flash");
        const flashed = el;
        window.setTimeout(() => flashed.removeClass("lpa-flash"), 1200);
        this.scheduleRailLayout();
        return;
      }
    }
  }

  /** Navigate through the native toolbar when the requested page has not been
   * materialised in Obsidian's lazy PDF DOM. PDF page labels matter here: a
   * book's physical page 27 may be labelled "5" after its front matter. */
  private async navigateNativeToPage(pageIndex: number): Promise<HTMLElement | null> {
    const root = this.contentRoot;
    if (!root) return null;
    const selector = `.page[data-page-number="${pageIndex + 1}"]`;
    const existing = root.querySelector<HTMLElement>(selector);
    if (existing) return existing;

    const input = this.findNativePageNumberInput();
    if (!input) return null;
    const labels = await this.getNativePageLabels();
    if (this.destroyed) return null;
    const label = labels?.[pageIndex] || String(pageIndex + 1);
    input.focus({ preventScroll: true });
    input.value = label;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
    );
    input.blur();

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      if (this.destroyed) return null;
      const pageEl = root.querySelector<HTMLElement>(selector);
      if (pageEl) return pageEl;
    }
    return null;
  }

  private findNativePageNumberInput(): HTMLInputElement | null {
    const container = this.leaf.view.containerEl;
    const toolbar = container.querySelector<HTMLElement>(".pdf-toolbar") ?? container;
    return (
      toolbar.querySelector<HTMLInputElement>(
        "input.pdf-page-input, input.pageNumber, input[type='number'], input[aria-label*='page' i], input[title*='page' i]"
      ) ??
      Array.from(toolbar.querySelectorAll<HTMLInputElement>("input")).find(
        (input) => !input.closest(".lpa-native-controls, .lpa-native-roll")
      ) ??
      null
    );
  }

  private getNativePageLabels(): Promise<string[] | null> {
    if (!this.pageLabelsPromise) {
      this.pageLabelsPromise = Promise.resolve(this.pdfDoc?.getPageLabels?.())
        .then((labels) => (Array.isArray(labels) ? labels.map(String) : null))
        .catch(() => null);
    }
    return this.pageLabelsPromise;
  }

  // ---- legacy import (same behavior as the custom annotator view) --------------

  async importLegacyAnnotations(): Promise<void> {
    const store = this.store;
    if (!this.pdfDoc || !store) {
      new Notice("The annotation overlay is still loading — try again in a moment.");
      return;
    }
    const pdfName = this.file.name.normalize("NFC").toLowerCase();
    const notes = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      const tgt = fm?.["annotation-target"];
      if (!tgt) return false;
      const tval = Array.isArray(tgt) ? tgt[0] : tgt;
      return targetBasename(String(tval)) === pdfName;
    });
    if (notes.length === 0) {
      new Notice("No obsidian-annotator notes target this PDF.");
      return;
    }

    const legacy: LegacyAnnotation[] = [];
    for (const n of notes) {
      legacy.push(...parseLegacyNote(await this.app.vault.read(n)).annotations);
    }
    if (legacy.length === 0) {
      new Notice("Found note(s) but no highlights to import.");
      return;
    }

    const notice = new Notice(`Indexing ${this.pdfDoc.numPages} pages…`, 0);
    let docIndex;
    try {
      docIndex = await buildDocIndex(this.pdfDoc, (d, t) => {
        if (d % 25 === 0 || d === t) notice.setMessage(`Indexing pages ${d}/${t}…`);
      });
    } catch (e) {
      notice.hide();
      console.error(`${LOG_TAG} legacy import indexing failed`, e);
      new Notice("Import failed while indexing the PDF (see console).");
      return;
    }
    if (this.destroyed) {
      notice.hide();
      return;
    }

    const seen = new Set(store.doc.highlights.map((h) => `${h.page}|${dedupeKey(h.text)}`));
    const created: Highlight[] = [];
    const affected = new Set<number>();
    let matched = 0;
    const unmatched: string[] = [];

    for (const a of legacy) {
      const results = anchorQuote(docIndex, a.exact, a.prefix, a.suffix);
      if (results.length === 0) {
        unmatched.push(a.exact);
        continue;
      }
      matched++;
      const cleanText = a.exact.replace(/\s+/g, " ").trim();
      for (const r of results) {
        const key = `${r.page}|${dedupeKey(cleanText)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        created.push({
          id: newId(),
          type: "highlight",
          page: r.page,
          color: this.currentColor,
          text: cleanText,
          note: a.note,
          rects: r.rects,
          created: a.created ?? new Date().toISOString(),
          source: "import",
          marginSide: "auto",
          isPinned: false,
          context: { prefix: a.prefix, suffix: a.suffix },
        });
        affected.add(r.page);
      }
    }

    notice.hide();
    if (created.length === 0) {
      new Notice(`Nothing new to import (matched ${matched}/${legacy.length}; already present).`);
      return;
    }
    store.addMany(created);
    await store.flush();
    for (const p of affected) this.repaintPage(p);
    this.notifyStoreChanged();
    new Notice(
      `Imported ${created.length} highlight(s) from ${notes.length} note(s). ` +
        `Matched ${matched}/${legacy.length}` +
        (unmatched.length ? `, ${unmatched.length} unmatched (see console).` : ".")
    );
    if (unmatched.length) {
      console.warn(`${LOG_TAG} ${unmatched.length} legacy quote(s) could not be anchored:`);
      unmatched.forEach((u) => console.warn("  •", u.slice(0, 90).replace(/\s+/g, " ")));
    }
  }
}

// ---- module helpers (ported from the custom view; base-viewport space) --------

/** The box the PDF content actually occupies inside a native ".page" div.
 * Prefer the native text layer (absolute, inset 0 — where selection rects
 * live), then the canvas wrapper, then our own inset-0 layer. */
function pageContentBox(pageEl: HTMLElement): DOMRect | null {
  const ref =
    pageEl.querySelector<HTMLElement>(":scope > .textLayer") ??
    pageEl.querySelector<HTMLElement>(":scope > .canvasWrapper") ??
    pageEl.querySelector<HTMLElement>(":scope > .lpa-native-hl-layer") ??
    pageEl;
  const box = ref.getBoundingClientRect();
  return box.width >= 2 && box.height >= 2 ? box : null;
}

/** Has pdf.js actually rendered this page (as opposed to reserving its box)? */
function isRenderedPage(pageEl: HTMLElement): boolean {
  // Deliberately NOT counting our own .lpa-native-hl-layer: syncPages gives one
  // to every ANNOTATED page, rendered or not, so accepting it would mark every
  // annotated page of a 500-page document as on-screen forever — re-measuring
  // them all on each scroll frame, which is the cost this filter removes.
  return (
    pageEl.hasAttribute("data-loaded") ||
    !!pageEl.querySelector(":scope > .textLayer, :scope > .canvasWrapper")
  );
}

function aspectMatches(box: DOMRect, geom: PageGeom): boolean {
  if (geom.w <= 0 || geom.h <= 0 || box.height <= 0) return false;
  const dom = box.width / box.height;
  const base = geom.w / geom.h;
  return Math.abs(dom - base) / base <= 0.04;
}

function clientToPdfPoint(clientX: number, clientY: number, box: DOMRect, geom: PageGeom): [number, number] {
  const bx = ((clientX - box.left) / box.width) * geom.w;
  const by = ((clientY - box.top) / box.height) * geom.h;
  const p = geom.vp1.convertToPdfPoint(bx, by) as number[];
  return [p[0], p[1]];
}

/** PDF-space rects → base-viewport (scale 1) rects, origin top-left. */
function rectsToBase(geom: PageGeom, rects: PdfRect[]): BaseRect[] {
  const out: BaseRect[] = [];
  for (const r of rects) {
    const a = geom.vp1.convertToViewportPoint(r.x1, r.y1) as number[];
    const b = geom.vp1.convertToViewportPoint(r.x2, r.y2) as number[];
    out.push({
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      right: Math.max(a[0], b[0]),
      bottom: Math.max(a[1], b[1]),
    });
  }
  return out;
}

/** Position a mark as a % of the page box so native zoom keeps it aligned. */
function applyPctBox(el: HTMLElement, r: BaseRect, geom: PageGeom): void {
  el.setCssProps({
    left: `${(r.left / geom.w) * 100}%`,
    top: `${(r.top / geom.h) * 100}%`,
    width: `${((r.right - r.left) / geom.w) * 100}%`,
    height: `${((r.bottom - r.top) / geom.h) * 100}%`,
  });
}

function lineMetricsFor(s: number): LineMetrics {
  return {
    weight: clamp(1.4, s * 1.35, 3),
    dash: Math.max(4, Math.round(s * 5)),
    dashGap: Math.max(3, Math.round(s * 4)),
    dot: Math.max(1.4, +(s * 1.6).toFixed(2)),
    dotGap: Math.max(2.4, +(s * 2.8).toFixed(2)),
  };
}

function coalescePaintRects(rects: PaintRect[]): PaintRect[] {
  const out: PaintRect[] = [];
  const sorted = [...rects].sort(
    (a, b) => a.color.localeCompare(b.color) || a.top - b.top || a.left - b.left || a.order - b.order
  );
  for (const rect of sorted) {
    let cur = clonePaintRect(rect);
    for (;;) {
      const i = out.findIndex((candidate) => canMergePaintRects(cur, candidate));
      if (i < 0) break;
      cur = mergePaintRects(cur, out[i]);
      out.splice(i, 1);
    }
    out.push(cur);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

function clonePaintRect(r: PaintRect): PaintRect {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    color: r.color,
    order: r.order,
    ids: new Set(r.ids),
    notes: new Set(r.notes),
  };
}

function canMergePaintRects(a: PaintRect, b: PaintRect): boolean {
  if (a.color !== b.color) return false;
  const minHeight = Math.min(a.bottom - a.top, b.bottom - b.top);
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (verticalOverlap < Math.max(1, minHeight * 0.45)) return false;
  const aCenter = (a.top + a.bottom) / 2;
  const bCenter = (b.top + b.bottom) / 2;
  if (Math.abs(aCenter - bCenter) > Math.max(2, minHeight * 0.6)) return false;
  const horizontalGap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
  return horizontalGap <= Math.max(2, minHeight * 0.25);
}

function mergePaintRects(a: PaintRect, b: PaintRect): PaintRect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
    color: a.color,
    order: Math.min(a.order, b.order),
    ids: new Set([...a.ids, ...b.ids]),
    notes: new Set([...a.notes, ...b.notes]),
  };
}

function occludePaintRects(rects: PaintRect[]): PaintRect[] {
  const out: PaintRect[] = [];
  const painted: PaintRect[] = [];
  const sorted = [...rects].sort((a, b) => a.order - b.order || a.top - b.top || a.left - b.left);
  for (const rect of sorted) {
    let pieces = [clonePaintRect(rect)];
    for (const blocker of painted) {
      const next: PaintRect[] = [];
      for (const piece of pieces) next.push(...subtractPaintRect(piece, blocker));
      pieces = next;
      if (pieces.length === 0) break;
    }
    out.push(...pieces);
    painted.push(...pieces);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left || a.order - b.order);
}

function subtractPaintRect(rect: PaintRect, blocker: PaintRect): PaintRect[] {
  const left = Math.max(rect.left, blocker.left);
  const top = Math.max(rect.top, blocker.top);
  const right = Math.min(rect.right, blocker.right);
  const bottom = Math.min(rect.bottom, blocker.bottom);
  if (right - left <= 0.5 || bottom - top <= 0.5) return [rect];
  const pieces: PaintRect[] = [];
  pushPaintPiece(pieces, rect, rect.left, rect.top, rect.right, top);
  pushPaintPiece(pieces, rect, rect.left, bottom, rect.right, rect.bottom);
  pushPaintPiece(pieces, rect, rect.left, top, left, bottom);
  pushPaintPiece(pieces, rect, right, top, rect.right, bottom);
  return pieces;
}

function pushPaintPiece(
  pieces: PaintRect[],
  source: PaintRect,
  left: number,
  top: number,
  right: number,
  bottom: number
): void {
  if (right - left <= 0.5 || bottom - top <= 0.5) return;
  pieces.push({
    left,
    top,
    right,
    bottom,
    color: source.color,
    order: source.order,
    ids: new Set(source.ids),
    notes: new Set(source.notes),
  });
}

function mergeLineRects(rects: BaseRect[]): BaseRect[] {
  const clean = rects.filter((r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5);
  const lines: BaseRect[] = [];
  for (const r of [...clean].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const rCenter = (r.top + r.bottom) / 2;
    const minH = r.bottom - r.top;
    const line = lines.find((l) => {
      const lCenter = (l.top + l.bottom) / 2;
      const h = Math.min(minH, l.bottom - l.top);
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      return overlap >= h * 0.5 && Math.abs(lCenter - rCenter) <= Math.max(2, h * 0.6);
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Calm card tint derived from the mark color (same recipe as the custom view). */
function stickerBackgroundColor(color: string, alpha: number): string {
  const pal = resolvePalette(color);
  const fill = pal?.cardFill ?? pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(alpha)})`;
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function measureMarginCardHeight(card: HTMLElement): number {
  const win = card.ownerDocument.defaultView ?? window;
  const style = win.getComputedStyle(card);
  const current = card.getBoundingClientRect().height || card.offsetHeight || 0;
  const maxHeight = parseCssPixelValue(style.maxHeight);
  const borderY =
    parseCssPixelValue(style.borderTopWidth, 0) + parseCssPixelValue(style.borderBottomWidth, 0);
  const natural = card.scrollHeight + borderY;
  const target = Number.isFinite(maxHeight) ? Math.min(natural, maxHeight) : natural;
  return Math.max(24, current, target);
}

function applyMarginCardDensity(cards: HTMLElement[], railHeight: number, gap: number): void {
  for (const card of cards) card.style.removeProperty("--lpa-card-density-height");
  if (!cards.length || railHeight <= 0) return;

  const expanded = cards.filter(
    (card) =>
      card.classList.contains("is-active") ||
      card.classList.contains("is-hover") ||
      card.classList.contains("is-pinned") ||
      card.matches(":hover")
  );
  const resting = cards.filter((card) => !expanded.includes(card));
  if (!resting.length) return;

  const occupied = expanded.reduce((sum, card) => sum + measureMarginCardHeight(card), 0);
  const available = Math.max(
    24 * resting.length,
    railHeight - 16 - gap * Math.max(0, cards.length - 1) - occupied
  );
  const fitted = fitFoldedMarginCardHeights(
    resting.map((card) => Number.parseFloat(card.dataset.foldedHeight || "54")),
    available
  );
  resting.forEach((card, index) => {
    card.style.setProperty("--lpa-card-density-height", `${fitted[index]}px`);
  });
}

function parseCssPixelValue(value: string, fallback = Number.POSITIVE_INFINITY): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dedupeKey(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase().slice(0, 80);
}

function cssEscape(value: string): string {
  const escape = typeof CSS !== "undefined" ? (CSS as any).escape : null;
  if (typeof escape === "function") return escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
