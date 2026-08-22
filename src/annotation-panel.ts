/**
 * annotation-panel.ts — workspace sidebar panel listing every highlight and
 * note of the active PDF, with search. Works with both PDF modes through the
 * AnnotationHub; clicking an entry reveals the mark in whichever view owns it.
 */
import { debounce, ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import {
  annotationColor,
  annotationKindLabel,
  annotationMatchesSearch,
  normalizeSearch,
  rollPrimaryText,
  rollSecondaryText,
} from "./annotation-format";
import { annotationAccent } from "./annotations";
import type { AnnotationHub, AnnotationSource } from "./annotation-hub";

export const VIEW_TYPE_LPA_PANEL = "lpa-annotation-panel";

export class AnnotationPanelView extends ItemView {
  private headerEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private searchQuery = "";
  /** The entry the user last clicked — the one Delete would remove. */
  private selectedId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private hub: AnnotationHub) {
    super(leaf);
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE_LPA_PANEL;
  }

  getDisplayText(): string {
    return "PDF annotations";
  }

  getIcon(): string {
    return "highlighter";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("lpa-panel");

    const head = root.createDiv({ cls: "lpa-panel-head" });
    this.headerEl = head.createDiv({ cls: "lpa-panel-title" });
    this.metaEl = head.createDiv({ cls: "lpa-panel-meta" });

    this.searchEl = root.createEl("input", {
      cls: "lpa-panel-search",
      attr: { type: "search", placeholder: "Search annotations…" },
    });
    this.searchEl.oninput = () => {
      this.searchQuery = this.searchEl.value;
      this.renderList();
    };

    this.listEl = root.createDiv({ cls: "lpa-panel-list" });

    const renderListDebounced = debounce(() => this.renderList(), 150, true);
    this.registerEvent(this.hub.on("active-changed", () => this.render()));
    this.registerEvent(this.hub.on("annotations-changed", () => renderListDebounced()));
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private render(): void {
    const src = this.hub.active;
    this.headerEl.setText(src ? src.file.basename : "No PDF in annotation mode");
    this.renderList();
  }

  private renderList(): void {
    const src = this.hub.active;
    this.listEl.empty();
    if (!src) {
      this.metaEl.setText("");
      this.listEl.createDiv({
        cls: "lpa-panel-empty",
        text: "Open a PDF and enable annotation mode to see its highlights here.",
      });
      return;
    }

    const annotations = [...src.store.doc.highlights].sort(
      (a, b) => a.page - b.page || a.created.localeCompare(b.created)
    );
    const query = normalizeSearch(this.searchQuery);
    const filtered = query
      ? annotations.filter((h) => annotationMatchesSearch(h, query))
      : annotations;
    this.metaEl.setText(
      query
        ? `${filtered.length}/${annotations.length}`
        : `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`
    );

    if (!annotations.length) {
      this.listEl.createDiv({ cls: "lpa-panel-empty", text: "No annotations yet." });
      return;
    }
    if (!filtered.length) {
      this.listEl.createDiv({ cls: "lpa-panel-empty", text: "No matching annotations." });
      return;
    }

    for (const h of filtered) {
      const accent = annotationAccent(annotationColor(h));
      const item = this.listEl.createDiv({ cls: "lpa-panel-item" });
      item.style.setProperty("--lpa-accent", accent);
      // Clicking an entry selects that annotation in the document, and Delete
      // with this panel focused removes the SELECTED one. Show which that is,
      // or the key destroys something the user was never shown.
      if (h.id === this.selectedId) item.addClass("is-active");
      const head = item.createDiv({ cls: "lpa-panel-item-head" });
      head.createSpan({ cls: "lpa-panel-dot", attr: { "aria-hidden": "true" } });
      head.createSpan({ cls: "lpa-panel-page", text: `p.${h.page + 1}` });
      head.createSpan({ cls: "lpa-panel-kind", text: annotationKindLabel(h) });
      item.createDiv({ cls: "lpa-panel-note", text: rollPrimaryText(h) });
      const secondary = rollSecondaryText(h);
      if (secondary) item.createDiv({ cls: "lpa-panel-source", text: secondary });

      item.onclick = () => {
        this.selectedId = h.id;
        for (const el of Array.from(this.listEl.children) as HTMLElement[]) {
          el.toggleClass("is-active", el === item);
        }
        void src.reveal(h.id);
      };
      item.addEventListener("contextmenu", (evt) => this.openItemMenu(evt, src, h.id));
    }
  }

  private openItemMenu(evt: MouseEvent, src: AnnotationSource, id: string): void {
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Reveal in PDF")
        .setIcon("locate")
        .onClick(() => void src.reveal(id))
    );
    if (src.copyLink) {
      menu.addItem((item) =>
        item
          .setTitle("Copy link")
          .setIcon("link")
          .onClick(() => void src.copyLink!(id))
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("Copy text")
        .setIcon("copy")
        .onClick(async () => {
          const h = src.store.get(id);
          if (!h) return;
          await navigator.clipboard.writeText((h.note || h.text || "").trim());
          new Notice("Copied annotation text");
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => src.remove(id))
    );
    menu.showAtMouseEvent(evt);
  }
}
