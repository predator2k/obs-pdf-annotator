/**
 * annotation-popover.ts — the shared style/color/note editor popup for an
 * existing mark or tag. Both PDF modes render annotations differently, so the
 * host interface carries the mode-specific pieces (store access + repaint);
 * everything the user sees and edits is identical in both modes.
 */
import { App, Modal, Notice, Platform } from "obsidian";
import {
  MARK_STYLES,
  MARK_STYLE_LABELS,
  markStrokeColor,
  markStyleOf,
  PALETTE,
  resolvePalette,
  type Highlight,
  type MarkStyle,
} from "./annotations";
import { annotationColor, annotationTypeOf, tagPreview } from "./annotation-format";

/**
 * Activate on POINTERUP, never click: these controls live in popovers whose
 * pointerdown is prevented (to keep the text selection alive), and newer
 * Chromium suppresses the click event after a canceled pointerdown.
 */
export function bindPopoverAction(btn: HTMLElement, fn: (evt: Event) => void): void {
  // Pointer capture unifies mouse and touch: every pointerup of a press that
  // STARTED here is delivered here, and activation requires the release to
  // land within the button's bounds (small pad). Drags that started
  // elsewhere never reach this handler; slide-off releases don't activate;
  // wobble-off-and-return does — for fingers exactly like mice.
  let pressId: number | null = null;
  btn.addEventListener("pointerdown", (evt) => {
    const pe = evt as PointerEvent;
    if (pe.button !== 0) return;
    pressId = pe.pointerId;
    try {
      btn.setPointerCapture(pe.pointerId);
    } catch {
      /* capture unsupported: bounds check still applies */
    }
  });
  btn.addEventListener("pointercancel", () => {
    pressId = null;
  });
  btn.addEventListener("pointerup", (evt) => {
    const pe = evt as PointerEvent;
    if (pe.pointerId !== pressId || pe.button !== 0) {
      // Do NOT clear here: this release belongs to a different pointer (a
      // second finger, or the right button pressed during a left press).
      // Clearing would discard the still-live press and swallow its activation.
      return;
    }
    pressId = null;
    const r = btn.getBoundingClientRect();
    const pad = 6;
    const inside =
      pe.clientX >= r.left - pad &&
      pe.clientX <= r.right + pad &&
      pe.clientY >= r.top - pad &&
      pe.clientY <= r.bottom + pad;
    if (!inside) return;
    evt.preventDefault();
    evt.stopPropagation();
    fn(evt);
  });
  btn.addEventListener("click", (evt) => {
    // Keyboard activation: Enter/Space synthesize a click with detail 0
    // (pointer clicks are suppressed by the canceled pointerdown).
    if ((evt as MouseEvent).detail === 0) {
      evt.preventDefault();
      fn(evt);
    }
  });
}

/**
 * Compact style row for the pre-commit selection popovers: pick underline /
 * box / strike etc. before creating the mark. The chosen style is the "pen"
 * and persists across sessions via the host callback.
 */
export function buildSelectionStyleRow(
  pop: HTMLElement,
  getStyle: () => MarkStyle,
  getColor: () => string,
  onPick: (style: MarkStyle) => void
): void {
  const styleRow = pop.createDiv({
    cls: "lpa-styles lpa-selection-styles",
    attr: { role: "radiogroup", "aria-label": "Mark style" },
  });
  const sync = () => {
    for (const b of Array.from(styleRow.children) as HTMLElement[]) {
      b.toggleClass("is-active", b.dataset.style === getStyle());
    }
  };
  for (const st of MARK_STYLES) {
    if (st === "comment") continue; // legacy style; not offered for new marks
    const btn = styleRow.createEl("button", {
      cls: "lpa-style-btn",
      attr: { "aria-label": MARK_STYLE_LABELS[st], title: MARK_STYLE_LABELS[st] },
    });
    btn.dataset.style = st;
    btn.createSpan({ cls: `lpa-style-sample lpa-style-sample--${st}`, text: "A", attr: { "aria-hidden": "true" } });
    const pal = resolvePalette(getColor());
    btn.style.setProperty("--lpa-ink", markStrokeColor(getColor()));
    btn.style.setProperty("--lpa-fill", pal?.fill ?? getColor());
    bindPopoverAction(btn, () => {
      onPick(st);
      sync();
    });
  }
  sync();
}

const CONTEXT_CHARS = 32;

/**
 * How much room to keep clear of the window edges when placing a popover.
 *
 * The layout viewport runs underneath Obsidian's mobile toolbar and the iOS
 * home indicator, so a popover clamped to the raw viewport height has its
 * bottom row of controls sitting behind them — visible but untappable.
 */
export function popoverEdgeInsets(doc: Document): { edge: number; bottom: number } {
  const edge = 8;
  if (!Platform.isMobile) return { edge, bottom: edge };
  const raw = doc.defaultView
    ?.getComputedStyle(doc.body)
    .getPropertyValue("--safe-area-inset-bottom")
    .trim();
  const safe = Number.parseFloat(raw ?? "") || 0;
  return { edge, bottom: edge + 48 + safe };
}

/**
 * Walk text nodes away from `node` in document order, collecting up to
 * `want` characters. `root` bounds the walk so it never leaves the document
 * being annotated.
 */
function textAround(container: Node, offset: number, want: number, back: boolean): string {
  const doc = container.ownerDocument;
  const root = doc?.body;
  if (!doc || !root) return "";

  let start: Node = container;
  let out = "";
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? "";
    out = back ? text.slice(0, offset) : text.slice(offset);
  } else {
    // An ELEMENT boundary indexes CHILDREN, not characters. Anchor the walk at
    // the child just outside the selection, so context can never pick up text
    // from inside the selection itself.
    const child = container.childNodes[back ? offset - 1 : offset];
    if (child) {
      start = child;
      if (child.nodeType === Node.TEXT_NODE) out = child.textContent ?? "";
    } else if (!back) {
      // Ends at the container's end: the next text is past its whole subtree.
      let last: Node = container;
      while (last.lastChild) last = last.lastChild;
      start = last;
    }
  }

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = start;
  while (out.length < want) {
    const next = back ? walker.previousNode() : walker.nextNode();
    if (!next) break;
    const text = next.textContent ?? "";
    out = back ? text + out : out + text;
  }
  return back ? out.slice(-want) : out.slice(0, want);
}

/**
 * Nearby text on either side of a selection, for disambiguating repeated
 * passages when re-anchoring.
 *
 * The context must cross node and element boundaries. Reading only inside the
 * boundary text node yields NOTHING for the most ordinary gestures — selecting
 * a whole sentence, paragraph, or triple-clicking all start at offset 0 and end
 * at a node's end — and a mark stored without context re-anchors onto the first
 * occurrence of its text, which is the wrong one whenever the page repeats a
 * phrase.
 */
export function selectionContext(sel: Selection): { prefix?: string; suffix?: string } | undefined {
  try {
    const first = sel.getRangeAt(0);
    const last = sel.getRangeAt(sel.rangeCount - 1);
    const prefix =
      textAround(first.startContainer, first.startOffset, CONTEXT_CHARS, true) || undefined;
    const suffix =
      textAround(last.endContainer, last.endOffset, CONTEXT_CHARS, false) || undefined;
    return prefix || suffix ? { prefix, suffix } : undefined;
  } catch {
    return undefined;
  }
}

export interface AnnotationEditorHost {
  doc: Document;
  /** Needed for the phone presentation (Obsidian Modal). */
  app?: App;
  get(id: string): Highlight | undefined;
  update(id: string, patch: Partial<Highlight>): void;
  remove(id: string): void;
  /** Repaint the page a mark sits on (visual change to the mark itself). */
  repaintPage(page: number): void;
  /** Refresh counters / lists / cards after any store change. */
  notifyChanged(): void;
  /** Optional "Copy link" action; the button appears only when provided. */
  copyLink?: (id: string) => void | Promise<void>;
  /** Extra class for the popover root (mode-specific styling hooks). */
  extraClass?: string;
  /** Called exactly once when the popover closes, however it closes. */
  onClose?: () => void;
}

/**
 * Open the editor near (x, y), clamped into the window. Returns a close
 * function; calling it more than once is safe. Dismissal (outside click,
 * Escape, Delete) runs the same close path, so the host can keep the returned
 * function as its single cleanup handle.
 */
export function openAnnotationEditor(
  host: AnnotationEditorHost,
  id: string,
  x: number,
  y: number,
  options: { focusNote?: boolean } = {}
): (() => void) | null {
  if (Platform.isPhone && host.app) return openAnnotationEditorModal(host, id, options);
  const initial = host.get(id);
  if (!initial) return null;
  const doc = host.doc;
  const pop = doc.body.createDiv({
    cls: `lpa-mark-popover lpa-native-edit-popover${host.extraClass ? ` ${host.extraClass}` : ""}`,
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener("pointerdown", onDocPointer, true);
    doc.removeEventListener("keydown", onKey, true);
    pop.remove();
    host.onClose?.();
  };
  const onDocPointer = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  buildEditorContent(host, id, pop, options, close);

  // Position near the click, clamped into the window.
  pop.setCssProps({ visibility: "hidden" });
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;
  const pr = pop.getBoundingClientRect();
  const { edge, bottom } = popoverEdgeInsets(doc);
  let px = x + 6;
  let py = y + 10;
  if (px + pr.width > vw - edge) px = Math.max(edge, vw - pr.width - edge);
  if (py + pr.height > vh - bottom) py = Math.max(edge, y - pr.height - 10);
  pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });

  // Defer so the opening click doesn't immediately dismiss it. If the editor is
  // already closed by then (a same-tick teardown), skip the registration
  // entirely — close() has run and can no longer remove it, so the listener
  // would stay on the document forever, holding the detached popover with it.
  window.setTimeout(() => {
    if (closed) return;
    doc.addEventListener("pointerdown", onDocPointer, true);
  }, 0);
  doc.addEventListener("keydown", onKey, true);

  return close;
}

function buildEditorContent(
  host: AnnotationEditorHost,
  id: string,
  container: HTMLElement,
  options: { focusNote?: boolean },
  close: () => void
): void {
  const initial = host.get(id);
  if (!initial) return;
  const type = annotationTypeOf(initial);

  const repaint = () => {
    const cur = host.get(id);
    host.repaintPage((cur ?? initial).page);
    host.notifyChanged();
  };

  let styleRow: HTMLElement | null = null;
  if (type === "highlight") {
    styleRow = container.createDiv({ cls: "lpa-styles", attr: { role: "radiogroup", "aria-label": "Mark style" } });
    const syncStyleChecks = () => {
      const cur = markStyleOf(host.get(id));
      for (const b of Array.from(styleRow!.children) as HTMLElement[]) {
        b.toggleClass("is-active", b.dataset.style === cur);
      }
    };
    for (const st of MARK_STYLES) {
      const btn = styleRow.createEl("button", {
        cls: "lpa-style-btn",
        attr: { "aria-label": MARK_STYLE_LABELS[st], title: MARK_STYLE_LABELS[st] },
      });
      btn.dataset.style = st;
      const cur = host.get(id)?.color ?? initial.color;
      const pal = resolvePalette(cur);
      btn.createSpan({ cls: `lpa-style-sample lpa-style-sample--${st}`, text: "A", attr: { "aria-hidden": "true" } });
      btn.style.setProperty("--lpa-ink", markStrokeColor(cur));
      btn.style.setProperty("--lpa-fill", pal?.fill ?? cur);
      btn.onclick = () => {
        host.update(id, { style: st });
        repaint();
        syncStyleChecks();
      };
    }
    syncStyleChecks();
  }

  const colorRow = container.createDiv({ cls: "lpa-swatches" });
  const syncColorChecks = () => {
    const cur = host.get(id);
    const active = cur ? annotationColor(cur) : null;
    for (const sw of Array.from(colorRow.children) as HTMLElement[]) {
      sw.toggleClass("is-active", sw.dataset.color === active);
    }
  };
  for (const p of PALETTE) {
    const sw = colorRow.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name } });
    sw.setCssProps({ background: p.fill });
    sw.dataset.color = p.fill;
    sw.onclick = () => {
      const patch: Partial<Highlight> =
        type === "tag" ? { color: p.fill, tagColor: p.fill } : { color: p.fill };
      host.update(id, patch);
      repaint();
      if (styleRow) {
        for (const b of Array.from(styleRow.children) as HTMLElement[]) {
          b.style.setProperty("--lpa-ink", markStrokeColor(p.fill));
          b.style.setProperty("--lpa-fill", p.fill);
        }
      }
      syncColorChecks();
    };
  }
  syncColorChecks();

  const note = container.createEl("textarea", {
    cls: "lpa-native-note",
    attr: {
      placeholder: type === "tag" ? "Page note" : "Note",
      rows: "3",
      "aria-label": type === "tag" ? "Page note" : "Annotation note",
    },
  });
  note.value = initial.note ?? "";
  note.oninput = () => {
    host.update(id, { note: note.value });
    repaint();
  };

  const actions = container.createDiv({ cls: "lpa-popover-actions" });
  const copyBtn = actions.createEl("button", { text: "Copy" });
  copyBtn.onclick = async () => {
    const cur = host.get(id);
    await navigator.clipboard.writeText((cur?.note || cur?.text || tagPreview(cur ?? initial)).trim());
    new Notice("Copied annotation text");
  };
  if (host.copyLink) {
    const linkBtn = actions.createEl("button", { text: "Copy link" });
    linkBtn.onclick = () => void host.copyLink!(id);
  }
  const delBtn = actions.createEl("button", { cls: "lpa-danger", text: "Delete" });
  delBtn.onclick = () => {
    const page = host.get(id)?.page ?? initial.page;
    host.remove(id);
    close();
    host.repaintPage(page);
    host.notifyChanged();
  };

  if (options.focusNote) {
    window.setTimeout(() => {
      note.focus();
      note.selectionStart = note.selectionEnd = note.value.length;
    }, 0);
  }
}

/** Phone presentation: the same editor content inside an Obsidian modal. */
function openAnnotationEditorModal(
  host: AnnotationEditorHost,
  id: string,
  options: { focusNote?: boolean }
): (() => void) | null {
  const initial = host.get(id);
  if (!initial || !host.app) return null;
  let closedByUs = false;
  const modal = new (class extends Modal {
    onOpen(): void {
      this.containerEl.addClass("lpa-editor-modal");
      this.titleEl.setText(annotationTypeOf(initial) === "tag" ? "Page note" : "Annotation");
      buildEditorContent(host, id, this.contentEl, options, () => this.close());
    }
    onClose(): void {
      this.contentEl.empty();
      if (!closedByUs) host.onClose?.();
    }
  })(host.app);
  modal.open();
  return () => {
    closedByUs = true;
    modal.close();
    host.onClose?.();
  };
}
