/**
 * annotation-hub.ts — broker between annotation sources (open PDFs in either
 * mode) and consumers like the sidebar panel. Each mode owns its own
 * AnnotationStore; the hub only tracks which one is "active" and relays
 * change events, so the panel never touches mode internals.
 */
import { App, Events, TFile, WorkspaceLeaf } from "obsidian";
import type { AnnotationStore } from "./annotations";
import { VIEW_TYPE_LPA_PANEL } from "./annotation-panel";

/**
 * May a view react to document-level destructive keys (Backspace/Delete on
 * the selected annotation)? Only when its pane is focused — or when the
 * Annotations panel is focused and that view is the panel's active source.
 * ONE rule for all three viewing modes.
 */
export function mayHandleDocumentKeys(
  app: App,
  hub: AnnotationHub | undefined,
  leaf: WorkspaceLeaf
): boolean {
  const activeLeaf = app.workspace.activeLeaf;
  if (activeLeaf === leaf) return true;
  const panelFocused = activeLeaf?.view?.getViewType?.() === VIEW_TYPE_LPA_PANEL;
  return !!panelFocused && hub?.active?.ownsLeaf(leaf) === true;
}

export interface AnnotationSource {
  key: string;
  file: TFile;
  store: AnnotationStore;
  reveal(id: string): void | Promise<void>;
  /** The annotation this source currently considers selected — the one the
   * Delete key would remove. The panel highlights it so the two agree. */
  activeId?(): string | null;
  remove(id: string): void;
  copyLink?(id: string): void | Promise<void>;
  ownsLeaf(leaf: WorkspaceLeaf): boolean;
}

export class AnnotationHub extends Events {
  private sources = new Map<string, AnnotationSource>();
  private activeKey: string | null = null;

  constructor(private app?: App) {
    super();
  }

  /** The registered source whose leaf currently has focus, if any. */
  private focusedSource(): AnnotationSource | null {
    const leaf = this.app?.workspace.activeLeaf;
    if (!leaf) return null;
    for (const src of this.sources.values()) if (src.ownsLeaf(leaf)) return src;
    return null;
  }

  register(src: AnnotationSource): void {
    this.sources.set(src.key, src);
    src.store.onChange = () => this.trigger("annotations-changed", src);
    // Become active only when this document is the one being looked at, or when
    // nothing is active yet. On workspace restore several documents register in
    // whatever order their async loads happen to finish, and unconditionally
    // taking over would point the panel — and the Delete key that follows it —
    // at whichever finished last.
    const focused = this.app?.workspace.activeLeaf;
    if ((focused && src.ownsLeaf(focused)) || !this.active) {
      this.activeKey = src.key;
    }
    this.trigger("active-changed");
  }

  unregister(key: string): void {
    const src = this.sources.get(key);
    if (!src) return;
    src.store.onChange = null;
    this.sources.delete(key);
    if (this.activeKey === key) {
      const focused = this.focusedSource();
      const remaining = [...this.sources.keys()];
      this.activeKey =
        focused?.key ?? (remaining.length ? remaining[remaining.length - 1] : null);
    }
    this.trigger("active-changed");
  }

  /** Sticky: focusing a non-source leaf (the panel itself, a note) keeps the
   * last active PDF, so the panel doesn't blank out while you write. */
  setActiveFromLeaf(leaf: WorkspaceLeaf | null): void {
    if (!leaf) return;
    for (const [key, src] of this.sources) {
      if (src.ownsLeaf(leaf)) {
        if (this.activeKey !== key) {
          this.activeKey = key;
          this.trigger("active-changed");
        }
        return;
      }
    }
  }

  get active(): AnnotationSource | null {
    return this.activeKey ? this.sources.get(this.activeKey) ?? null : null;
  }
}
