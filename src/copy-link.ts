/**
 * copy-link.ts — build and copy a citation link for a highlight.
 *
 * The link uses Obsidian-native subpaths only, so clicking it works with the
 * core PDF viewer even when this plugin is disabled. Chunk sources are tried
 * in order until one yields a confident text match; otherwise the link
 * degrades to page-only instead of pointing at the wrong words.
 */
import { App, Notice, TFile } from "obsidian";
import { annotationTypeOf } from "./annotation-format";
import type { Highlight } from "./annotations";
import {
  findSelectionInChunks,
  subpathForHighlight,
  subpathForPageNote,
  type SelectionSubpath,
} from "./pdf-link";

export type ChunkSource = () => Promise<string[] | null> | string[] | null;
export type PageSizeSource = () => Promise<{ w: number; h: number } | null>;

export async function copyHighlightLink(
  app: App,
  file: TFile,
  h: Highlight,
  chunkSources: ChunkSource[],
  pageSize?: PageSizeSource
): Promise<void> {
  let subpath: string | null = null;
  let anchored = false;

  if (annotationTypeOf(h) === "tag") {
    // Free-form page note: link to its exact position via a scroll destination.
    if (pageSize && Number.isFinite(h.tagX) && Number.isFinite(h.tagY)) {
      try {
        const size = await pageSize();
        if (size) {
          subpath = subpathForPageNote(h.page, h.tagX ?? 0, h.tagY ?? 0, size.w, size.h);
          anchored = true;
        }
      } catch (e) {
        console.warn("[local-pdf-annotator] page size lookup failed while building link", e);
      }
    }
  } else if (h.text) {
    let sel: SelectionSubpath | null = null;
    for (const source of chunkSources) {
      try {
        const chunks = await source();
        if (!chunks || !chunks.length) continue;
        sel = findSelectionInChunks(chunks, h.text, h.context?.prefix, h.context?.suffix);
        if (sel) break;
      } catch (e) {
        console.warn("[local-pdf-annotator] chunk source failed while building link", e);
      }
    }
    subpath = subpathForHighlight(h.page, sel);
    anchored = !!sel;
  }
  subpath = subpath ?? subpathForHighlight(h.page, null);
  const alias = `${file.basename}, p.${h.page + 1}`;
  let link = app.fileManager.generateMarkdownLink(file, "", subpath, alias);
  // Obsidian emits the embed form ("![[…]]") for non-markdown files.
  if (link.startsWith("!")) link = link.slice(1);
  await navigator.clipboard.writeText(link);
  new Notice(anchored ? "Copied link to annotation" : "Copied link to page");
}
