/**
 * html-view.ts — an HTML reader with the same annotation experience as the
 * PDF modes: select text → color click commits a mark, click a mark → the
 * shared popup editor, same palette/pen/styles, same Markdown sidecar (path
 * mode), same sidebar panel via the annotation hub.
 *
 * Anchoring: HTML has no page geometry, so marks are pure TEXT QUOTES
 * (text + prefix/suffix context) re-anchored on every render through the
 * same normalization the PDF text anchoring uses. Painting wraps the matched
 * text nodes in inline spans — no absolute-positioned overlays — so marks
 * reflow with the document.
 *
 * Rendering is sanitized: scripts, embeds, and event handlers are stripped;
 * relative image sources resolve against the file's vault folder.
 */
import { FileView, Menu, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import {
  AnnotationStore,
  defaultColor,
  markStrokeColor,
  markStyleOf,
  newId,
  PALETTE,
  pathModeSidecarPaths,
  resolvePalette,
  type AnnotationPathOptions,
  type Highlight,
  type MarkStyle,
  type PenState,
} from "./annotations";
import { contextScore, normChar } from "./anchor";
import { annotationTypeOf } from "./annotation-format";
import { bindPopoverAction, buildSelectionStyleRow, openAnnotationEditor } from "./annotation-popover";
import type { AnnotationHub } from "./annotation-hub";

export const VIEW_TYPE_HTML_ANNOTATOR = "lpa-html-annotator";

const LOG = "[local-pdf-annotator:html]";

interface TextPos {
  node: Text;
  offset: number; // raw char offset within the node
}

export class HtmlAnnotatorView extends FileView {
  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private toolbarSwatchesEl: HTMLElement | null = null;
  private toolbarStylesEl: HTMLElement | null = null;
  private scrollEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private store: AnnotationStore | null = null;
  private currentColor = defaultColor();
  private currentStyle: MarkStyle = "highlight";
  private pendingSelection: { text: string; context?: { prefix?: string; suffix?: string } } | null =
    null;
  private selectionPopoverEl: HTMLElement | null = null;
  private editorClose: (() => void) | null = null;
  private activeId: string | null = null;
  private mobileSelectionTimer: number | null = null;
  private readonly hubKey = `html-${newId()}`;

  constructor(
    leaf: WorkspaceLeaf,
    private getAnnotationPathOptions: () => AnnotationPathOptions = () => ({}),
    private pen?: PenState,
    private hub?: AnnotationHub,
    private getMobileSelectionDelay: () => number = () => 3000,
    private getZoomPct: () => number = () => 100,
    private setZoomPct: (pct: number) => void = () => {}
  ) {
    super(leaf);
    this.navigation = true;
    this.allowNoFile = false;
    if (pen) {
      this.currentColor = pen.getColor();
      this.currentStyle = pen.getStyle();
    }
  }

  getViewType(): string {
    return VIEW_TYPE_HTML_ANNOTATOR;
  }
  getIcon(): string {
    return "file-text";
  }
  getDisplayText(): string {
    return this.file ? this.file.basename : "HTML";
  }
  canAcceptExtension(extension: string): boolean {
    return extension === "html" || extension === "htm";
  }

  async onOpen(): Promise<void> {
    this.rootEl = this.contentEl.createDiv({ cls: "lpa-html-root" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "lpa-html-toolbar" });
    this.buildToolbar();
    this.scrollEl = this.rootEl.createDiv({ cls: "lpa-html-scroll" });
    this.bodyEl = this.scrollEl.createEl("article", { cls: "lpa-html-body" });
    this.applyZoom();

    this.registerDomEvent(this.scrollEl, "pointerup", (evt) => this.onPointerUp(evt));
    this.registerDomEvent(this.scrollEl, "click", (evt) => this.onClick(evt));
    this.registerDomEvent(this.scrollEl, "contextmenu", (evt) => this.onContextMenu(evt));
    this.registerDomEvent(this.contentEl.ownerDocument, "selectionchange", () =>
      this.onSelectionChange()
    );
    this.registerDomEvent(this.contentEl.ownerDocument, "keydown", (evt) =>
      this.onKeyDown(evt as KeyboardEvent)
    );
  }

  async onClose(): Promise<void> {
    this.teardown();
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.teardown();
    const raw = await this.app.vault.read(file);
    this.renderHtml(raw, file);

    const options = this.getAnnotationPathOptions();
    const paths = pathModeSidecarPaths(file.path, options);
    this.store = new AnnotationStore(
      this.app.vault.adapter,
      paths.annotationPath,
      file.basename,
      file.path,
      undefined,
      [],
      false,
      paths.backupPath
    );
    await this.store.load();
    this.paintAll();

    if (this.hub && this.store) {
      const store = this.store;
      this.hub.register({
        key: this.hubKey,
        file,
        store,
        reveal: (id) => this.revealAnnotation(id),
        remove: (id) => this.deleteAnnotation(id),
        copyLink: (id) => this.copyAnnotationLink(id),
        ownsLeaf: (leaf) => leaf === this.leaf,
      });
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.teardown();
  }

  /** Settle any pending debounced save for this file (rename-follow). */
  async flushAnnotations(file: TFile): Promise<void> {
    if (this.file?.path !== file.path || !this.store) return;
    try {
      await this.store.flush();
    } catch (e) {
      console.error(`${LOG} failed to save annotations`, e);
    }
  }

  syncPath(file: TFile): void {
    if (this.file?.path !== file.path || !this.store) return;
    this.store.setPdfPath(file.path, file.basename);
    const options = this.getAnnotationPathOptions();
    const paths = pathModeSidecarPaths(file.path, options);
    this.store.setSidecarPath(paths.annotationPath, paths.backupPath);
  }

  /** Same pen bar as the PDF toolbar: colors arm/disarm, styles set the pen. */
  private buildToolbar(): void {
    this.toolbarEl.empty();

    const zoomBtn = (icon: string, label: string, delta: number) => {
      const btn = this.toolbarEl.createEl("button", {
        cls: "lpa-native-btn clickable-icon",
        attr: { type: "button", "aria-label": label, title: label },
      });
      setIcon(btn, icon);
      btn.onclick = (evt) => {
        evt.preventDefault();
        const next = Math.min(300, Math.max(50, this.getZoomPct() + delta));
        this.setZoomPct(next);
        this.applyZoom();
      };
    };
    zoomBtn("zoom-out", "Zoom out", -10);
    zoomBtn("zoom-in", "Zoom in", 10);

    const center = this.toolbarEl.createDiv({ cls: "lpa-html-toolbar-center" });
    this.toolbarSwatchesEl = center.createDiv({ cls: "lpa-toolbar-swatches" });
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
        this.syncToolbar();
      };
    }
    this.toolbarStylesEl = center.createDiv({ cls: "lpa-toolbar-styles" });
    buildSelectionStyleRow(
      this.toolbarStylesEl,
      () => this.currentStyle,
      () => this.currentColor,
      (st) => {
        this.currentStyle = st;
        this.pen?.set(this.currentColor, this.currentStyle);
        this.syncToolbar();
      }
    );
    this.syncToolbar();
    this.applyZoom();
  }

  private applyZoom(): void {
    this.scrollEl?.style.setProperty("--lpa-html-zoom", String(this.getZoomPct() / 100));
  }

  private syncToolbar(): void {
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
  }

  private teardown(): void {
    this.hub?.unregister(this.hubKey);
    this.hideSelectionPopover(false);
    this.editorClose?.();
    this.editorClose = null;
    if (this.mobileSelectionTimer !== null) {
      window.clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = null;
    }
    const store = this.store;
    this.store = null;
    this.activeId = null;
    if (store) {
      void store.flush().catch((e) => console.error(`${LOG} failed to save annotations`, e));
    }
    this.bodyEl?.empty();
  }

  // ---- rendering ------------------------------------------------------------

  private renderHtml(raw: string, file: TFile): void {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    // Strip active content wholesale.
    doc
      .querySelectorAll("script, iframe, object, embed, form, base, meta[http-equiv]")
      .forEach((el) => el.remove());
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        else if (/^(href|src|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
    // Resolve relative image sources against the file's folder.
    const folder = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "";
    for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:|blob:|app:)/i.test(src)) continue;
      const clean = src.replace(/^\.\//, "").split("?")[0].split("#")[0];
      const target = this.app.vault.getAbstractFileByPath(
        folder ? `${folder}/${decodeURIComponent(clean)}` : decodeURIComponent(clean)
      );
      if (target instanceof TFile) img.src = this.app.vault.getResourcePath(target);
    }

    this.bodyEl.empty();
    const nodes = Array.from(doc.body.childNodes);
    for (const node of nodes) this.bodyEl.appendChild(this.bodyEl.ownerDocument.importNode(node, true));
  }

  // ---- text anchoring -------------------------------------------------------

  /** Normalized full text of the article with a map back to DOM positions. */
  private buildTextIndex(): { search: string; map: TextPos[] } {
    let search = "";
    const map: TextPos[] = [];
    const walker = this.bodyEl.ownerDocument.createTreeWalker(this.bodyEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      // Skip our own mark wrappers' internals? They contain the document's
      // text — index them normally so re-painting after edits still matches.
      const str = node.nodeValue ?? "";
      let offset = 0;
      for (const c of str) {
        const n = normChar(c);
        for (let k = 0; k < n.length; k++) {
          search += n[k];
          map.push({ node, offset });
        }
        offset += c.length;
      }
      node = walker.nextNode() as Text | null;
    }
    return { search, map };
  }

  private normQuery(s: string): string {
    let out = "";
    for (const c of s) out += normChar(c);
    return out;
  }

  /** Locate a highlight's quote; returns a DOM Range or null. */
  private findRange(
    index: { search: string; map: TextPos[] },
    h: Highlight
  ): Range | null {
    const needle = this.normQuery(h.text);
    if (needle.length < 1) return null;
    const nPrefix = h.context?.prefix ? this.normQuery(h.context.prefix) : undefined;
    const nSuffix = h.context?.suffix ? this.normQuery(h.context.suffix) : undefined;
    let best: { start: number; end: number; score: number } | null = null;
    let from = 0;
    for (;;) {
      const at = index.search.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length - 1;
      const score = contextScore(index.search, at, end, nPrefix, nSuffix);
      if (!best || score > best.score) best = { start: at, end, score };
      if (best.score >= 4) break;
      from = at + 1;
    }
    if (!best) return null;
    const first = index.map[best.start];
    const last = index.map[best.end];
    if (!first || !last) return null;
    const range = this.bodyEl.ownerDocument.createRange();
    range.setStart(first.node, first.offset);
    const lastChar = last.node.nodeValue?.codePointAt(last.offset);
    range.setEnd(last.node, last.offset + (lastChar !== undefined && lastChar > 0xffff ? 2 : 1));
    return range;
  }

  // ---- painting -------------------------------------------------------------

  private unpaintAll(): void {
    for (const span of Array.from(
      this.bodyEl.querySelectorAll<HTMLElement>("span.lpa-html-mark")
    )) {
      span.replaceWith(...Array.from(span.childNodes));
    }
    this.bodyEl.normalize();
  }

  private paintAll(): void {
    this.unpaintAll();
    const store = this.store;
    if (!store) return;
    const index = this.buildTextIndex();
    const ordered = [...store.doc.highlights]
      .filter((h) => annotationTypeOf(h) === "highlight" && h.text)
      .sort((a, b) => a.created.localeCompare(b.created));
    for (const h of ordered) {
      const range = this.findRange(index, h);
      if (range) this.wrapRange(range, h);
    }
  }

  /** Wrap every text segment of the range in a mark span. */
  private wrapRange(range: Range, h: Highlight): void {
    const doc = this.bodyEl.ownerDocument;
    // Collect affected text nodes FIRST — splitting invalidates the walk.
    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(this.bodyEl, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode() as Text | null;
    while (n) {
      if (range.intersectsNode(n)) nodes.push(n);
      n = walker.nextNode() as Text | null;
    }
    for (const node of nodes) {
      let target = node;
      // Trim to the range boundaries. End split first: when one node holds
      // both boundaries, this keeps the middle segment as the wrap target.
      if (node === range.endContainer && range.endOffset < (node.nodeValue?.length ?? 0)) {
        node.splitText(range.endOffset);
      }
      if (node === range.startContainer && range.startOffset > 0) {
        target = node.splitText(range.startOffset);
      }
      if (!(target.nodeValue ?? "").length) continue;
      const span = doc.createElement("span");
      const st = markStyleOf(h);
      span.className = `lpa-html-mark lpa-html-mark--${st}`;
      span.dataset.hlId = h.id;
      const pal = resolvePalette(h.color);
      span.style.setProperty("--lpa-fill", pal?.fill ?? h.color);
      span.style.setProperty("--lpa-ink", markStrokeColor(h.color));
      span.toggleClass("is-active", h.id === this.activeId);
      if (h.note) span.setAttribute("title", h.note);
      target.parentNode?.insertBefore(span, target);
      span.appendChild(target);
    }
  }

  private marksFor(id: string): HTMLElement[] {
    return Array.from(
      this.bodyEl.querySelectorAll<HTMLElement>(`span.lpa-html-mark[data-hl-id="${CSS.escape(id)}"]`)
    );
  }

  private setActive(id: string | null): void {
    this.activeId = id && this.store?.get(id) ? id : null;
    for (const span of Array.from(this.bodyEl.querySelectorAll<HTMLElement>("span.lpa-html-mark"))) {
      span.toggleClass("is-active", span.dataset.hlId === this.activeId);
    }
  }

  // ---- interactions ---------------------------------------------------------

  private onPointerUp(evt: PointerEvent): void {
    if (!this.store) return;
    if (Platform.isMobile) return; // mobile flows through the debounced path
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-selection-popover, .lpa-mark-popover")) return;
    const sel = this.contentEl.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      this.captureSelection(sel);
    }
  }

  private onSelectionChange(): void {
    const sel = this.contentEl.ownerDocument.getSelection();
    const empty = !sel || sel.isCollapsed || sel.toString().trim().length === 0;
    if (this.selectionPopoverEl && empty) this.hideSelectionPopover(false);
    if (Platform.isMobile && !empty) {
      if (this.mobileSelectionTimer !== null) window.clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = window.setTimeout(() => {
        this.mobileSelectionTimer = null;
        if (!this.store) return;
        const cur = this.contentEl.ownerDocument.getSelection();
        if (!cur || cur.isCollapsed || cur.toString().trim().length === 0) return;
        this.captureSelection(cur);
      }, Math.max(0, this.getMobileSelectionDelay()));
    }
  }

  private selectionInsideBody(sel: Selection): boolean {
    const anchor = sel.anchorNode;
    return !!anchor && this.bodyEl.contains(anchor);
  }

  private captureSelection(sel: Selection): void {
    if (!this.selectionInsideBody(sel)) return;
    const text = sel.toString().trim();
    if (!text) return;
    let context: { prefix?: string; suffix?: string } | undefined;
    try {
      const first = sel.getRangeAt(0);
      const last = sel.getRangeAt(sel.rangeCount - 1);
      const startText = first.startContainer.textContent ?? "";
      const endText = last.endContainer.textContent ?? "";
      const prefix = startText.slice(Math.max(0, first.startOffset - 32), first.startOffset);
      const suffix = endText.slice(last.endOffset, last.endOffset + 32);
      if (prefix || suffix) context = { prefix: prefix || undefined, suffix: suffix || undefined };
    } catch {
      /* best effort */
    }
    this.pendingSelection = { text, context };

    const rects = sel.rangeCount
      ? Array.from(sel.getRangeAt(sel.rangeCount - 1).getClientRects())
      : [];
    let left = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let ri = 0; ri < sel.rangeCount; ri++) {
      for (const r of Array.from(sel.getRangeAt(ri).getClientRects())) {
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      }
    }
    const cx = Number.isFinite(left) ? (left + right) / 2 : rects[0]?.left ?? 100;
    const cy = Number.isFinite(bottom) ? bottom : rects[0]?.bottom ?? 100;

    if (this.pen?.getArmed()) {
      this.currentColor = this.pen.getColor();
      this.currentStyle = this.pen.getStyle();
      this.commitSelection();
      return;
    }
    this.showSelectionPopover(cx, cy);
  }

  private commitSelection(): void {
    const pending = this.pendingSelection;
    const store = this.store;
    if (!pending || !store) return;
    const h: Highlight = {
      id: newId(),
      type: "highlight",
      page: 0,
      color: this.currentColor,
      style: this.currentStyle,
      text: pending.text,
      rects: [],
      created: new Date().toISOString(),
      source: "manual",
    };
    if (pending.context?.prefix || pending.context?.suffix) h.context = pending.context;
    store.add(h);
    this.hideSelectionPopover(true);
    this.paintAll();
    this.syncToolbar();
  }

  private showSelectionPopover(x: number, y: number): void {
    // Replace only the ELEMENT — hideSelectionPopover would also null the
    // pendingSelection this popover is about to commit.
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    const doc = this.contentEl.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-selection-popover is-right" });
    this.selectionPopoverEl = pop;
    pop.style.setProperty("--lpa-accent", markStrokeColor(this.currentColor));
    pop.onmousedown = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    pop.onpointerdown = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    const swatches = pop.createDiv({ cls: "lpa-selection-swatches", attr: { "aria-label": "Highlight color" } });
    for (const p of PALETTE) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name, title: p.name } });
      sw.setCssProps({ background: p.fill });
      sw.dataset.color = p.fill;
      sw.toggleClass("is-active", p.fill === this.currentColor);
      bindPopoverAction(sw, () => {
        this.currentColor = p.fill;
        this.pen?.set(this.currentColor, this.currentStyle);
        this.commitSelection();
      });
    }
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
    const gap = Platform.isMobile ? 56 : 12;
    const px = Math.min(Math.max(8, x - pr.width / 2), Math.max(8, vw - pr.width - 8));
    const py = Math.min(Math.max(8, y + gap), Math.max(8, vh - pr.height - 8));
    pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });
  }

  private hideSelectionPopover(clearSelection: boolean): void {
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    if (clearSelection) this.contentEl.ownerDocument.getSelection()?.removeAllRanges();
  }

  private onClick(evt: MouseEvent): void {
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-selection-popover, .lpa-mark-popover")) return;
    const mark = target?.closest<HTMLElement>("span.lpa-html-mark");
    const sel = this.contentEl.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (mark?.dataset.hlId) {
      evt.preventDefault();
      this.setActive(mark.dataset.hlId);
      this.openEditor(mark.dataset.hlId, evt.clientX, evt.clientY);
    } else {
      this.setActive(null);
    }
  }

  private onContextMenu(evt: MouseEvent): void {
    if (Platform.isPhone) return;
    const target = evt.target as HTMLElement | null;
    const mark = target?.closest<HTMLElement>("span.lpa-html-mark");
    const id = mark?.dataset.hlId;
    if (!id || !this.store?.get(id)) return;
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Edit annotation")
        .setIcon("pencil")
        .onClick(() => this.openEditor(id, evt.clientX, evt.clientY, true))
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy link")
        .setIcon("link")
        .onClick(() => void this.copyAnnotationLink(id))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => this.deleteAnnotation(id))
    );
    menu.showAtMouseEvent(evt);
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if ((evt.key === "Backspace" || evt.key === "Delete") && this.activeId) {
      const target = evt.target as HTMLElement | null;
      if (
        !target ||
        (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && !target.isContentEditable)
      ) {
        evt.preventDefault();
        this.deleteAnnotation(this.activeId);
        return;
      }
    }
    if (evt.key === "Escape" && this.selectionPopoverEl) this.hideSelectionPopover(false);
  }

  private openEditor(id: string, x: number, y: number, focusNote = false): void {
    const store = this.store;
    if (!store || !store.get(id)) return;
    this.editorClose?.();
    this.editorClose = openAnnotationEditor(
      {
        doc: this.contentEl.ownerDocument,
        app: this.app,
        get: (hid) => store.get(hid),
        update: (hid, patch) => store.update(hid, patch),
        remove: (hid) => {
          store.remove(hid);
          if (this.activeId === hid) this.activeId = null;
        },
        repaintPage: () => this.paintAll(),
        notifyChanged: () => {
          /* the hub relays store changes to the panel */
        },
        copyLink: (hid) => void this.copyAnnotationLink(hid),
        onClose: () => {
          this.editorClose = null;
        },
      },
      id,
      x,
      y,
      { focusNote }
    );
  }

  private deleteAnnotation(id: string): void {
    if (!this.store?.get(id)) return;
    this.editorClose?.();
    this.store.remove(id);
    if (this.activeId === id) this.activeId = null;
    this.paintAll();
  }

  private async copyAnnotationLink(id: string): Promise<void> {
    const file = this.file;
    if (!file || !this.store?.get(id)) return;
    let link = this.app.fileManager.generateMarkdownLink(file, "", undefined, file.basename);
    if (link.startsWith("!")) link = link.slice(1);
    await navigator.clipboard.writeText(link);
    new Notice("Copied link to document");
  }

  private revealAnnotation(id: string): void {
    this.setActive(id);
    const first = this.marksFor(id)[0];
    if (!first) return;
    first.scrollIntoView({ block: "center", behavior: "smooth" });
    first.addClass("lpa-flash");
    window.setTimeout(() => first.removeClass("lpa-flash"), 1200);
  }
}
