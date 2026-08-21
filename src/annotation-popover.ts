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
  let armed = false;
  let startedHere = false;
  btn.addEventListener("pointerdown", (evt) => {
    if ((evt as PointerEvent).button === 0) {
      armed = true;
      startedHere = true;
    }
  });
  btn.addEventListener("pointerleave", (evt) => {
    armed = false;
    // Button released elsewhere: this press is over for good.
    if (!((evt as PointerEvent).buttons & 1)) startedHere = false;
  });
  btn.addEventListener("pointerenter", (evt) => {
    // A held press that wobbled off and returned re-arms; a drag that
    // STARTED elsewhere (text selection) never does.
    if (startedHere && (evt as PointerEvent).buttons & 1) armed = true;
  });
  btn.addEventListener("pointerup", (evt) => {
    // Only a left-button press that STARTED on this element activates —
    // releasing a selection drag over the popover must not commit.
    const activate = armed && (evt as PointerEvent).button === 0;
    armed = false;
    startedHere = false;
    if (!activate) return;
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

/**
 * Nearby text on either side of a selection, for disambiguating repeated
 * passages when re-anchoring. Boundaries on ELEMENT containers (triple-click,
 * cross-block drags) have child-index offsets, not text offsets — those sides
 * yield no context rather than garbage that would poison the sidecar.
 */
export function selectionContext(sel: Selection): { prefix?: string; suffix?: string } | undefined {
  try {
    const first = sel.getRangeAt(0);
    const last = sel.getRangeAt(sel.rangeCount - 1);
    let prefix: string | undefined;
    let suffix: string | undefined;
    if (first.startContainer.nodeType === Node.TEXT_NODE) {
      const t = first.startContainer.textContent ?? "";
      prefix = t.slice(Math.max(0, first.startOffset - 32), first.startOffset) || undefined;
    }
    if (last.endContainer.nodeType === Node.TEXT_NODE) {
      const t = last.endContainer.textContent ?? "";
      suffix = t.slice(last.endOffset, last.endOffset + 32) || undefined;
    }
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
  let px = x + 6;
  let py = y + 10;
  if (px + pr.width > vw - 8) px = Math.max(8, vw - pr.width - 8);
  if (py + pr.height > vh - 8) py = Math.max(8, y - pr.height - 10);
  pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });

  // Defer so the opening click doesn't immediately dismiss it.
  window.setTimeout(() => doc.addEventListener("pointerdown", onDocPointer, true), 0);
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
