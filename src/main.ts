/**
 * main.ts — PDF Annotator plugin entry point.
 *
 * Triggers (all public, documented API):
 *   - command "Open current PDF in annotator" (stable custom-view fallback)
 *   - file-open bridge: ordinary .pdf clicks are redirected into this view
 *   - native overlay (experimental): an "Annotate" toggle injected into the
 *     native PDF view's toolbar layers annotation tools onto Obsidian's own
 *     viewer without replacing it (see native-overlay.ts)
 */
import {
  debounce,
  Modal,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { PdfAnnotatorView, VIEW_TYPE_PDF_ANNOTATOR } from "./view";
import { initPdfEngine, disposePdfEngine, LOG_TAG } from "./pdf-engine";
import { NativeOverlayManager } from "./native-overlay";
import {
  DEFAULT_ANNOTATION_FOLDER,
  LEGACY_DEFAULT_ANNOTATION_FOLDER,
  DEFAULT_PALETTE,
  defaultColor,
  derivePaletteEntry,
  markStyleOf,
  moveSidecarsForRename,
  normalizeAnnotationStorageFolder,
  PALETTE,
  setActivePalette,
  type AnnotationPathOptions,
  type AnnotationStorageMode,
  type DocumentIdentityMode,
  type MarkStyle,
  type PenState,
} from "./annotations";
import { parseColor } from "./color";
import { AnnotationHub } from "./annotation-hub";
import { AnnotationPanelView, VIEW_TYPE_LPA_PANEL } from "./annotation-panel";
import { HtmlAnnotatorView, VIEW_TYPE_HTML_ANNOTATOR } from "./html-view";
import { PdfBundleManager } from "./bundles";

interface LpaSettings {
  /** Override Obsidian's core PDF viewer so clicking a PDF opens this view. */
  registerAsDefaultPdfHandler: boolean;
  /** Inject annotation mode into the native PDF view (experimental). */
  enableNativeOverlay: boolean;
  /** Show margin note cards beside the pages (notes always editable via popup). */
  showMarginCards: boolean;
  /** How a PDF is matched to its annotations: by vault path or content hash. */
  documentIdentity: DocumentIdentityMode;
  /** Legacy sidecar mode retained only for migration compatibility. */
  annotationStorageMode: AnnotationStorageMode;
  /** Vault-relative folder searched for legacy sidecars and used for exports. */
  annotationStorageFolder: string;
  /** User-defined highlight colors; null/absent = built-in palette. */
  customPalette: Array<{ name: string; fill: string; highlightAlpha?: number }> | null;
  /** The persistent pen: last used mark color + style. */
  lastColorFill: string | null;
  lastMarkStyle: string | null;
  /** Toolbar color armed: selections highlight instantly without the popover. */
  penArmed: boolean;
  /** Mobile: ms the selection must hold still before the popup / armed commit. */
  mobileSelectionDelayMs: number;
  /** HTML reader zoom, percent. */
  htmlZoomPct: number;
  /** One-shot marker: the old visible default folder was auto-upgraded. */
  legacyFolderUpgraded: boolean;
}

const DEFAULT_SETTINGS: LpaSettings = {
  registerAsDefaultPdfHandler: false,
  enableNativeOverlay: true,
  showMarginCards: false,
  documentIdentity: "path",
  annotationStorageMode: "folder",
  annotationStorageFolder: DEFAULT_ANNOTATION_FOLDER,
  customPalette: null,
  lastColorFill: null,
  lastMarkStyle: null,
  penArmed: false,
  mobileSelectionDelayMs: 3000,
  htmlZoomPct: 100,
  legacyFolderUpgraded: false,
};

function coerceAnnotationStorageMode(value: string): AnnotationStorageMode {
  return value === "beside-pdf" ? "beside-pdf" : "folder";
}

function coerceDocumentIdentity(value: string): DocumentIdentityMode {
  return value === "hash" ? "hash" : "path";
}

export default class LocalPdfAnnotatorPlugin extends Plugin {
  settings!: LpaSettings;
  nativeOverlays!: NativeOverlayManager;
  bundleManager!: PdfBundleManager;
  annotationHub!: AnnotationHub;
  private replacingCorePdfView = false;
  private nativePdfRefreshRaf: number | null = null;

  async onload(): Promise<void> {
    this.annotationHub = new AnnotationHub(this.app);
    await this.loadSettings();
    this.bundleManager = new PdfBundleManager(this.app);

    // Configure + self-verify our bundled pdf.js worker up front so the console
    // shows the version match before any PDF is opened.
    const status = initPdfEngine();
    if (!status.ok) {
      new Notice("PDF Annotator: pdf.js version self-check failed — see console.");
    }

    this.registerView(
      VIEW_TYPE_PDF_ANNOTATOR,
      (leaf: WorkspaceLeaf) =>
        new PdfAnnotatorView(
          leaf,
          () => this.annotationPathOptions(),
          this.bundleManager,
          () => this.settings.showMarginCards,
          this.pen(),
          this.annotationHub,
          () => this.settings.mobileSelectionDelayMs
        )
    );

    this.registerView(VIEW_TYPE_LPA_PANEL, (leaf) => new AnnotationPanelView(leaf, this.annotationHub));

    // HTML reader with the same annotation experience. Core Obsidian claims
    // no view for .html, so the extension registration is uncontested.
    this.registerView(
      VIEW_TYPE_HTML_ANNOTATOR,
      (leaf) =>
        new HtmlAnnotatorView(
          leaf,
          () => this.annotationPathOptions(),
          this.pen(),
          this.annotationHub,
          () => this.settings.mobileSelectionDelayMs,
          () => this.settings.htmlZoomPct,
          (pct: number) => {
            this.settings.htmlZoomPct = pct;
            void this.saveSettings();
          }
        )
    );
    try {
      // One call per extension: registration stops at the first conflict, so a
      // combined call that throws on "htm" would leave "html" registered
      // WITHOUT its unregister-on-unload cleanup — after which disabling the
      // plugin leaves .html files opening into a dead view type.
      for (const ext of ["html", "htm"]) {
        try {
          this.registerExtensions([ext], VIEW_TYPE_HTML_ANNOTATOR);
        } catch (e) {
          console.warn(`${LOG_TAG} could not claim .${ext} (another plugin owns it)`, e);
        }
      }
    } catch (e) {
      console.warn(`${LOG_TAG} could not claim HTML extensions`, e);
    }

    this.nativeOverlays = new NativeOverlayManager(
      this,
      () => this.settings.enableNativeOverlay,
      () => this.annotationPathOptions(),
      this.bundleManager,
      () => this.settings.showMarginCards,
      this.pen(),
      this.annotationHub,
      () => this.settings.mobileSelectionDelayMs
    );

    // Trigger 1: command palette.
    this.addCommand({
      id: "open-current-pdf-in-annotator",
      name: "Open current PDF in annotator",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const isPdf = !!file && file.extension === "pdf";
        if (isPdf && !checking) this.openInAnnotator(file as TFile, "tab");
        return isPdf;
      },
    });

    // Toggle the experimental annotation overlay on the native PDF view.
    this.addCommand({
      id: "toggle-native-annotation-mode",
      name: "Toggle annotation mode on the native PDF view",
      checkCallback: (checking: boolean) => {
        if (!this.settings.enableNativeOverlay) return false;
        const leaf = this.app.workspace.activeLeaf;
        const ready = !!leaf && leaf.view.getViewType() === "pdf";
        if (ready && !checking) void this.nativeOverlays.toggle(leaf!);
        return ready;
      },
    });

    // Migrate highlights from the old obsidian-annotator notes for the open PDF.
    // Works in the custom annotator view AND in native overlay mode.
    this.addCommand({
      id: "import-legacy-annotations",
      name: "Import legacy obsidian-annotator highlights for this PDF",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PdfAnnotatorView);
        if (view && view.file) {
          if (!checking) void view.importLegacyAnnotations();
          return true;
        }
        const overlay = this.nativeOverlays.activeOverlay();
        if (overlay) {
          if (!checking) void overlay.importLegacyAnnotations();
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-annotation-panel",
      name: "Open annotations panel",
      callback: async () => {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_LPA_PANEL)[0];
        if (existing) {
          this.app.workspace.revealLeaf(existing);
          return;
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: VIEW_TYPE_LPA_PANEL, active: true });
        this.app.workspace.revealLeaf(leaf);
      },
    });

    this.addCommand({
      id: "delete-stored-pdf-copies",
      name: "Delete stored PDF copies (reclaim space)",
      callback: async () => {
        const stats = await this.bundleManager.statStoredPdfCopies();
        if (!stats.count && !stats.keptOrphans) {
          new Notice("PDF Annotator: no stored PDF copies found.");
          return;
        }
        if (!stats.count) {
          new Notice(
            `PDF Annotator: ${stats.keptOrphans} stored ${stats.keptOrphans === 1 ? "copy belongs" : "copies belong"} ` +
              "to PDFs no longer in the vault — kept as the only surviving copies (see .pdf-annotator/)."
          );
          return;
        }
        new DeleteStoredCopiesModal(this, stats.count, stats.bytes, stats.keptOrphans).open();
      },
    });

    this.addCommand({
      id: "export-current-pdf-annotations",
      name: "Export annotations for current PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "pdf") return false;
        if (!checking) {
          void this.bundleManager
            .exportAnnotations(file, this.exportFolder(), this.annotationPathOptions())
            .then((path) => new Notice(`PDF Annotator: exported ${path}`))
            .catch((e: any) => {
              console.error(`${LOG_TAG} failed to export PDF annotations`, e);
              new Notice(`PDF Annotator: export failed — ${e?.message ?? e}`);
            });
        }
        return true;
      },
    });

    // Trigger 2: ordinary file clicks. Obsidian's core PDF view owns the "pdf"
    // extension, so registerExtensions cannot override it safely. Instead, use
    // the public file-open event and replace the active core PDF leaf.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.scheduleNativePdfRefresh();
        if (file instanceof TFile && file.extension === "pdf") {
          void this.openPdfClickInAnnotator(file);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.annotationHub.setActiveFromLeaf(leaf);
        this.scheduleNativePdfRefresh();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleNativePdfRefresh())
    );
    // Accents and mark inks are computed per theme and baked into inline styles
    // at paint time, so a light/dark switch (or a snippet reload) has to force a
    // repaint — otherwise every open view keeps the previous theme's colors.
    this.registerEvent(this.app.workspace.on("css-change", () => this.refreshAnnotationUi()));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "pdf") void this.onPdfRenamed(file, oldPath);
        else if (file.extension === "html" || file.extension === "htm") {
          void this.onHtmlRenamed(file, oldPath);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        void this.bundleManager.onPdfDeleted(file.path).catch((e) =>
          console.error(`${LOG_TAG} failed to update deleted PDF bundle metadata`, e)
        );
      })
    );
    this.app.workspace.onLayoutReady(() => this.scheduleNativePdfRefresh());

    this.addSettingTab(new LpaSettingTab(this));

    console.log(`${LOG_TAG} loaded.`);
  }

  onunload(): void {
    if (this.nativePdfRefreshRaf !== null) {
      window.cancelAnimationFrame(this.nativePdfRefreshRaf);
      this.nativePdfRefreshRaf = null;
    }
    // Detach native overlays (removes injected DOM, observers, listeners) …
    this.nativeOverlays.disable();
    // … then revoke the worker Blob URL.
    //
    // The views themselves are NOT detached: Obsidian tears down the leaves of
    // a deregistered view type on its own, and detaching here would close the
    // user's open PDF tabs — losing their layout and scroll position — every
    // time the plugin is updated or toggled off and on.
    disposePdfEngine();
    console.log(`${LOG_TAG} unloaded.`);
  }

  async openInAnnotator(file: TFile, paneType: "tab" | "split" | false = "tab"): Promise<void> {
    const leaf = this.findExistingLeafForFile(file) ?? this.app.workspace.getLeaf(paneType);
    await this.setLeafToAnnotator(leaf, file);
  }

  private async setLeafToAnnotator(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    await leaf.setViewState({
      type: VIEW_TYPE_PDF_ANNOTATOR,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private findExistingLeafForFile(file: TFile): WorkspaceLeaf | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && this.leafContainsFile(activeLeaf, file)) {
      return activeLeaf;
    }

    for (const viewType of ["pdf", VIEW_TYPE_PDF_ANNOTATOR]) {
      for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
        if (this.leafContainsFile(leaf, file)) return leaf;
      }
    }

    return null;
  }

  private leafContainsFile(leaf: WorkspaceLeaf, file: TFile): boolean {
    const leafFile = (leaf.view as { file?: unknown }).file;
    return leafFile instanceof TFile && leafFile.path === file.path;
  }

  private async openPdfClickInAnnotator(file: TFile): Promise<void> {
    if (!this.settings.registerAsDefaultPdfHandler || this.replacingCorePdfView) return;
    // The native-viewer overlay is the mobile experience; the custom view
    // stays reachable through its command but is not the default there.
    if (Platform.isMobile) return;
    for (const delayMs of [-1, 0, 16, 64]) {
      if (delayMs < 0) {
        await Promise.resolve();
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }

      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) continue;
      if (leaf.view.getViewType() === VIEW_TYPE_PDF_ANNOTATOR) return;
      if (this.app.workspace.getActiveFile()?.path !== file.path) continue;

      this.replacingCorePdfView = true;
      try {
        await this.setLeafToAnnotator(leaf, file);
      } finally {
        this.replacingCorePdfView = false;
      }
      return;
    }
  }

  /** Debounced sync of the native-PDF-view integration (toolbar controls +
   * overlay lifecycle). The overlay itself never calls setViewState. */
  private scheduleNativePdfRefresh(): void {
    if (this.nativePdfRefreshRaf !== null) return;
    this.nativePdfRefreshRaf = window.requestAnimationFrame(() => {
      this.nativePdfRefreshRaf = null;
      this.nativeOverlays.refresh();
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.annotationStorageMode = coerceAnnotationStorageMode(
      this.settings.annotationStorageMode
    );
    this.settings.documentIdentity = coerceDocumentIdentity(this.settings.documentIdentity);
    const zoom = Number(this.settings.htmlZoomPct);
    this.settings.htmlZoomPct = Number.isFinite(zoom) ? Math.min(300, Math.max(50, Math.round(zoom))) : 100;
    const delay = Number(this.settings.mobileSelectionDelayMs);
    this.settings.mobileSelectionDelayMs = Number.isFinite(delay)
      ? Math.min(10000, Math.max(0, Math.round(delay)))
      : 3000;
    this.applyPaletteFromSettings();
    this.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(
      this.settings.annotationStorageFolder
    );
    // Auto-upgrade installs that never customized the old visible default —
    // exactly once, so deliberately choosing "PDF annotations" later sticks.
    if (
      !this.settings.legacyFolderUpgraded &&
      this.settings.annotationStorageFolder === LEGACY_DEFAULT_ANNOTATION_FOLDER
    ) {
      this.settings.annotationStorageFolder = DEFAULT_ANNOTATION_FOLDER;
      this.settings.legacyFolderUpgraded = true;
    } else if (!this.settings.legacyFolderUpgraded) {
      this.settings.legacyFolderUpgraded = true;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  applyPaletteFromSettings(): void {
    // data.json can be hand-edited, written by an older build, or damaged by a
    // sync conflict. A throw here happens inside loadSettings, i.e. inside
    // onload — which would leave the plugin half-constructed and make onunload
    // throw as well — so every field is treated as untrusted.
    const raw = this.settings.customPalette;
    const entries = Array.isArray(raw) ? raw : [];
    const valid = entries.filter(
      (e): e is { name: string; fill: string; highlightAlpha?: number } =>
        !!e && typeof e === "object" && typeof (e as any).fill === "string"
    );
    setActivePalette(
      valid.map((e) => {
        const name = typeof e.name === "string" ? e.name.trim() : "";
        const alpha = typeof e.highlightAlpha === "number" ? e.highlightAlpha : undefined;
        // An untouched built-in color keeps its hand-tuned ink/emoji/alpha.
        const preset = DEFAULT_PALETTE.find((p) => p.fill === e.fill);
        return preset ? { ...preset, name: name || preset.name } : derivePaletteEntry(name, e.fill, alpha);
      })
    );
    if (valid.length !== entries.length) {
      console.warn(`${LOG_TAG} ignored ${entries.length - valid.length} malformed palette entries`);
    }
    this.settings.customPalette = valid;
  }

  pen(): PenState {
    return {
      getColor: () => {
        const stored = this.settings.lastColorFill;
        return stored && PALETTE.some((p) => p.fill === stored) ? stored : defaultColor();
      },
      getStyle: () => markStyleOf({ style: this.settings.lastMarkStyle ?? undefined }),
      set: (color: string, style: MarkStyle) => {
        this.settings.lastColorFill = color;
        this.settings.lastMarkStyle = style;
        void this.saveSettings();
      },
      getArmed: () => this.settings.penArmed,
      setArmed: (on: boolean) => {
        this.settings.penArmed = on;
        void this.saveSettings();
      },
    };
  }

  /** Rename-follow: flush, then move sidecars (path mode), then repoint views. */
  private async onPdfRenamed(file: TFile, oldPath: string): Promise<void> {
    const options = this.annotationPathOptions();
    if (options.documentIdentity !== "hash") {
      // Settle any pending debounced save first so it cannot fire mid-move
      // and resurrect a sidecar at the old location.
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
        const view = leaf.view;
        if (view instanceof PdfAnnotatorView) await view.flushAnnotations(file);
      }
      await this.nativeOverlays.flushAnnotations(file);
      await moveSidecarsForRename(this.app.vault.adapter, oldPath, file.path, options);
    }
    await this.bundleManager.onPdfRenamed(file, oldPath).catch((e) =>
      console.error(`${LOG_TAG} failed to update PDF bundle path metadata`, e)
    );
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
      const view = leaf.view;
      if (view instanceof PdfAnnotatorView) view.syncPdfPath(file);
    }
    this.nativeOverlays.syncPdfPath(file);
    this.scheduleNativePdfRefresh();
  }

  private async onHtmlRenamed(file: TFile, oldPath: string): Promise<void> {
    const options = this.annotationPathOptions();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML_ANNOTATOR)) {
      const view = leaf.view;
      if (view instanceof HtmlAnnotatorView) await view.flushAnnotations(file);
    }
    await moveSidecarsForRename(this.app.vault.adapter, oldPath, file.path, options);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML_ANNOTATOR)) {
      const view = leaf.view;
      if (view instanceof HtmlAnnotatorView) view.syncPath(file);
    }
  }

  /** Re-render annotation UI in every open view after a live setting change. */
  refreshAnnotationUi(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
      const view = leaf.view;
      if (view instanceof PdfAnnotatorView) view.refreshAnnotationUi();
    }
    // The HTML reader shares the palette and pen, so it has to repaint too —
    // otherwise two open views disagree about what a color means until the
    // file is closed and reopened.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML_ANNOTATOR)) {
      const view = leaf.view;
      if (view instanceof HtmlAnnotatorView) view.refreshAnnotationUi();
    }
    this.nativeOverlays.refreshUi();
  }

  /**
   * Exports live in their own visible top-level folder, never inside the
   * annotation folder. They must be user-visible (the default annotation folder
   * is hidden, so Obsidian would not index them), and keeping the two
   * namespaces apart is what guarantees an export can never be written on top
   * of a live sidecar.
   */
  exportFolder(): string {
    return "PDF exports";
  }

  annotationPathOptions(): AnnotationPathOptions {
    return {
      storageMode: this.settings.annotationStorageMode,
      storageFolder: this.settings.annotationStorageFolder,
      documentIdentity: this.settings.documentIdentity,
    };
  }
}

class LpaSettingTab extends PluginSettingTab {
  constructor(private plugin: LocalPdfAnnotatorPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Annotation folder")
      .setDesc(
        "Annotation sidecars are stored in this folder, mirroring each PDF's vault path " +
          "(e.g. Books/Novel.pdf → .pdf-annotate/Books/Novel.annotations.md). The default is " +
          "hidden from the file explorer; make sure your sync/backup tool includes it. " +
          "Exports also land here."
      )
      .addText((t) => {
        t
          .setPlaceholder(DEFAULT_ANNOTATION_FOLDER)
          .setValue(this.plugin.settings.annotationStorageFolder)
          .onChange(async (v) => {
            this.plugin.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(v);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Match annotations to PDFs by")
      .setDesc(
        "File path (default): fast opens, annotations survive edits to the PDF's contents, and " +
          "renames done inside Obsidian are tracked. Content hash: robust against moves and " +
          "renames done outside Obsidian, but an edited PDF counts as a new document and every " +
          "open reads and hashes the whole file. Applies the next time a PDF is opened."
      )
      .addDropdown((d) =>
        d
          .addOption("path", "File path (recommended)")
          .addOption("hash", "Content hash")
          .setValue(this.plugin.settings.documentIdentity)
          .onChange(async (v) => {
            this.plugin.settings.documentIdentity = v === "hash" ? "hash" : "path";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Annotate inside the native PDF view")
      .setDesc(
        "Shows your highlights on Obsidian's own PDF viewer and adds a color/style bar to its " +
          "toolbar. Pick a color there to highlight selections instantly; with no color armed, " +
          "selecting text opens the color/style popover. The native toolbar, sidebar, zoom, and " +
          "navigation stay untouched."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableNativeOverlay).onChange(async (v) => {
          this.plugin.settings.enableNativeOverlay = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.nativeOverlays.refresh();
          else this.plugin.nativeOverlays.disable();
        })
      );

    new Setting(containerEl)
      .setName("Show margin note cards")
      .setDesc(
        "Show annotation cards beside the pages, in whatever margin space already exists. " +
          "Off by default: notes are read and edited in a popup on the mark itself. " +
          "The PDF zoom level is never changed automatically."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showMarginCards).onChange(async (v) => {
          this.plugin.settings.showMarginCards = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAnnotationUi();
        })
      );

    new Setting(containerEl)
      .setName("Selection popup delay on mobile")
      .setDesc(
        "How long a text selection must hold still before the popup appears (or an armed " +
          "color commits) on phones and tablets. Prevents fights with the system selection " +
          "handles. Desktop is always instant."
      )
      .addSlider((sl) =>
        sl
          .setLimits(0, 5000, 250)
          .setValue(this.plugin.settings.mobileSelectionDelayMs)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.mobileSelectionDelayMs = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Make this the default PDF viewer")
      .setDesc(
        "When enabled, ordinary .pdf clicks are redirected into this annotator. " +
          "This uses Obsidian's public file-open event and does not patch internal PDF-viewer state."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.registerAsDefaultPdfHandler).onChange(async (v) => {
          this.plugin.settings.registerAsDefaultPdfHandler = v;
          await this.plugin.saveSettings();
          new Notice(v ? "PDF clicks will open in PDF Annotator." : "PDF clicks will use Obsidian's core PDF viewer.");
        })
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The command “Open current PDF in annotator” remains available as a stable custom-view fallback.",
    });

    this.displayPaletteSection(containerEl);
  }

  private displayPaletteSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Highlight colors").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Colors offered by the highlight pickers. Existing marks keep the color they were " +
        "made with, even if it is removed here.",
    });

    const palette =
      this.plugin.settings.customPalette ??
      DEFAULT_PALETTE.map((p) => ({ name: p.name, fill: p.fill, highlightAlpha: p.highlightAlpha }));
    const commit = async (structural: boolean) => {
      this.plugin.settings.customPalette = palette;
      await this.plugin.saveSettings();
      this.plugin.applyPaletteFromSettings();
      this.plugin.refreshAnnotationUi();
      if (structural) this.display();
    };
    // Renames don't change how marks render — no repaint, and saves are
    // debounced so typing a name isn't a disk write per keystroke.
    const commitNameDebounced = debounce(
      () => {
        this.plugin.settings.customPalette = palette;
        void this.plugin.saveSettings().then(() => this.plugin.applyPaletteFromSettings());
      },
      800,
      true
    );

    palette.forEach((entry, index) => {
      const row = new Setting(containerEl);
      row.addText((t) =>
        t
          .setPlaceholder("Name")
          .setValue(entry.name)
          .onChange((v) => {
            entry.name = v;
            commitNameDebounced();
          })
      );
      row.addColorPicker((c) =>
        c.setValue(fillToHex(entry.fill)).onChange(async (v) => {
          entry.fill = v;
          delete entry.highlightAlpha;
          await commit(false);
        })
      );
      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip(palette.length <= 1 ? "At least one color is required" : "Remove color")
          .setDisabled(palette.length <= 1)
          .onClick(async () => {
            palette.splice(index, 1);
            await commit(true);
          })
      );
    });

    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText("Add color").onClick(async () => {
          palette.push({ name: `color ${palette.length + 1}`, fill: "#4A90D9" });
          await commit(true);
        })
      )
      .addButton((b) =>
        b.setButtonText("Restore defaults").onClick(async () => {
          this.plugin.settings.customPalette = null;
          await this.plugin.saveSettings();
          this.plugin.applyPaletteFromSettings();
          this.plugin.refreshAnnotationUi();
          this.display();
        })
      );
  }
}

function fillToHex(fill: string): string {
  const c = parseColor(fill);
  if (!c) return "#ffd400";
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

class DeleteStoredCopiesModal extends Modal {
  constructor(
    private plugin: LocalPdfAnnotatorPlugin,
    private count: number,
    private bytes: number,
    private keptOrphans: number
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const mb = (this.bytes / (1024 * 1024)).toFixed(1);
    this.titleEl.setText("Delete stored PDF copies");
    this.contentEl.createEl("p", {
      text:
        `Older versions of PDF Annotator kept a recovery copy of each annotated PDF inside ` +
        `.pdf-annotator/. ${this.count} ${this.count === 1 ? "copy" : "copies"} (${mb} MB) ` +
        `whose working PDFs still exist can be deleted. Annotations are not touched, and your ` +
        `working PDFs are never affected.`,
    });
    if (this.keptOrphans > 0) {
      this.contentEl.createEl("p", {
        text:
          `${this.keptOrphans} ${this.keptOrphans === 1 ? "copy" : "copies"} will be KEPT because ` +
          `no working PDF exists for ${this.keptOrphans === 1 ? "it" : "them"} anywhere in the ` +
          `vault — deleting those would destroy the only surviving copy of the document.`,
      });
    }
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const del = buttons.createEl("button", { cls: "mod-warning", text: `Delete ${this.count} ${this.count === 1 ? "copy" : "copies"}` });
    del.onclick = async () => {
      del.disabled = true;
      try {
        const { count, bytes, keptOrphans } = await this.plugin.bundleManager.deleteStoredPdfCopies();
        new Notice(
          `PDF Annotator: deleted ${count} stored ${count === 1 ? "copy" : "copies"} ` +
            `(${(bytes / (1024 * 1024)).toFixed(1)} MB reclaimed)` +
            (keptOrphans ? `; kept ${keptOrphans} sole-surviving ${keptOrphans === 1 ? "copy" : "copies"}.` : ".")
        );
      } catch (e: any) {
        console.error(`${LOG_TAG} failed to delete stored PDF copies`, e);
        new Notice(`PDF Annotator: cleanup failed — ${e?.message ?? e}`);
      }
      this.close();
    };
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
