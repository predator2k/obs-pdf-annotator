/**
 * bundles.ts — annotation storage resolution for both identity modes.
 *
 * PATH mode (default): the sidecar lives at a path mirrored from the PDF's
 * vault path (e.g. "PDF annotations/Books/Novel.annotations.md"). Annotations
 * survive content edits, and renames inside Obsidian move the sidecar along
 * (see moveSidecarsForRename). No hashing at open once no legacy bundle data
 * remains; while it does, one memoized hash per open keeps migration safe.
 *
 * HASH mode (optional): a PDF's SHA-256 is its durable identity. Every
 * document gets one bundle at:
 *
 *   .pdf-annotator/bundles/sha256/<hash>/
 *     annotations.md
 *     manifest.json
 *
 * Moving/renaming a PDF (even outside Obsidian) cannot orphan its annotations;
 * replacing a file at the same path with different bytes cannot accidentally
 * inherit somebody else's annotations.
 *
 * Older releases also copied the whole PDF into the bundle as document.pdf.
 * That backup feature is retired: no new copies are written and leftover
 * copies are deleted when their PDF is next opened (or in bulk via the
 * "Delete stored PDF copies" command).
 */
import { App, TFile, normalizePath } from "obsidian";
import {
  LEGACY_DEFAULT_ANNOTATION_FOLDER,
  legacySidecarPathFor,
  parseAnnotations,
  pathModeSidecarPaths,
  sidecarPathFor,
  type AnnotationPathOptions,
} from "./annotations";
import { PDF_BUNDLE_LIBRARY, pathsForHash, sha256Hex } from "./bundle-identity";

export { PDF_BUNDLE_LIBRARY, sha256Hex } from "./bundle-identity";

/** First line of every export snapshot; excludes it from recovery scans. */
export const EXPORT_MARKER = "<!-- lpa-export: annotation snapshot; not a live sidecar -->";

export interface PdfBundleManifest {
  version: 1;
  id: string;
  sha256: string;
  byteLength: number;
  originalName: string;
  currentPath: string | null;
  aliases: string[];
  fingerprint?: string;
  created: string;
  updated: string;
  lastSeen: string;
  lastVerified: string;
}

export interface PdfBundleBinding {
  id: string;
  rootPath: string;
  backupPath: string;
  annotationPath: string;
  annotationBackupPath: string;
  manifestPath: string;
  fallbackAnnotationPaths: string[];
  manifest: PdfBundleManifest;
}

export interface StoredCopyStats {
  count: number;
  bytes: number;
  /** Copies kept because no working PDF exists anywhere in the vault. */
  keptOrphans: number;
}

/** What an AnnotationStore needs, independent of the identity mode. */
export interface AnnotationBinding {
  annotationPath: string;
  fallbackPaths: string[];
  migrateFallback: boolean;
  annotationBackupPath?: string;
}

/** Pure fallback binding used when storage resolution fails entirely. */
export function fallbackAnnotationBinding(
  pdfPath: string,
  options: AnnotationPathOptions
): AnnotationBinding {
  return {
    annotationPath: sidecarPathFor(pdfPath, options),
    fallbackPaths: [legacySidecarPathFor(pdfPath)],
    migrateFallback: false,
  };
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((path): path is string => !!path).map(normalizePath)));
}

function isManifest(value: unknown): value is PdfBundleManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<PdfBundleManifest>;
  return (
    m.version === 1 &&
    typeof m.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(m.sha256) &&
    typeof m.byteLength === "number" &&
    typeof m.originalName === "string" &&
    Array.isArray(m.aliases)
  );
}

export class PdfBundleManager {
  private pendingByHash = new Map<string, Promise<PdfBundleBinding>>();
  private hashMemo = new Map<string, string>();
  private pathToHash = new Map<string, string>();
  private legacyFingerprintIndex: Map<string, string[]> | null = null;

  constructor(private app: App) {}

  /** Resolve where annotations live for this document, per the identity mode. */
  async resolveBinding(
    file: TFile,
    pdfData: ArrayBuffer,
    fingerprint: string | undefined,
    options: AnnotationPathOptions
  ): Promise<AnnotationBinding> {
    if (options.documentIdentity === "hash") {
      const binding = await this.prepare(file, pdfData, fingerprint, options);
      return {
        annotationPath: binding.annotationPath,
        fallbackPaths: binding.fallbackAnnotationPaths,
        migrateFallback: true,
        annotationBackupPath: binding.annotationBackupPath,
      };
    }
    return this.preparePathBinding(file, pdfData, fingerprint, options);
  }

  /**
   * PATH mode: the canonical sidecar mirrors the PDF's vault path under the
   * annotation folder. Existing hash bundles are offered as one-time migration
   * sources (their annotations are copied into the path sidecar on load), and
   * any leftover document.pdf recovery copy is deleted to reclaim space.
   */
  private async preparePathBinding(
    file: TFile,
    pdfData: ArrayBuffer,
    fingerprint: string | undefined,
    options: AnnotationPathOptions
  ): Promise<AnnotationBinding> {
    const adapter = this.app.vault.adapter;
    const { annotationPath, backupPath } = pathModeSidecarPaths(file.path, options);

    const fallbacks: string[] = [];
    if (await adapter.exists(backupPath)) fallbacks.push(backupPath);
    fallbacks.push(
      ...(await this.legacyAnnotationCandidates(file.path, fingerprint, options, annotationPath))
    );
    // The pre-upgrade folder's rolling backup is a recovery source too: a
    // corrupt legacy sidecar must still restore from its own .previous. Same
    // fingerprint gate as every other candidate — a different document that
    // now occupies this path must never inherit the old backup.
    const legacyBackup = pathModeSidecarPaths(file.path, {
      storageFolder: LEGACY_DEFAULT_ANNOTATION_FOLDER,
    }).backupPath;
    if (await this.annotationCandidateMatches(legacyBackup, fingerprint)) {
      fallbacks.push(legacyBackup);
    }

    // Hash-bundle migration + leftover-copy cleanup. Only runs while old
    // bundle data exists; the per-session memo avoids rehashing a file that
    // has not changed since it was last opened.
    if (await adapter.exists(PDF_BUNDLE_LIBRARY)) {
      try {
        const hash = await this.hashForFile(file, pdfData);
        const paths = pathsForHash(hash);
        const bundleUsable = await this.annotationCandidateMatches(paths.annotationPath, fingerprint);
        if (!(await adapter.exists(annotationPath))) {
          if (bundleUsable) fallbacks.push(paths.annotationPath);
          if (await adapter.exists(paths.annotationBackupPath)) {
            fallbacks.push(paths.annotationBackupPath);
          }
        } else if (bundleUsable) {
          // Upgrade path: 0.2.x kept editing the BUNDLE while the mirrored
          // sidecar stayed frozen as a pre-migration snapshot. If the bundle
          // is newer (or the sidecar is corrupt), promote the bundle content —
          // otherwise the stale snapshot would silently roll annotations back.
          const sidecarStat = await adapter.stat(annotationPath);
          const bundleStat = await adapter.stat(paths.annotationPath);
          const current = await adapter.read(annotationPath).catch(() => "");
          const sidecarParses = !!parseAnnotations(current);
          const bundleNewer =
            !sidecarParses ||
            ((bundleStat?.mtime ?? 0) > (sidecarStat?.mtime ?? 0));
          if (bundleNewer) {
            if (sidecarParses) await adapter.write(backupPath, current);
            await adapter.write(annotationPath, await adapter.read(paths.annotationPath));
          }
        }
        await this.deleteStoredCopy(paths.backupPath);
      } catch (e) {
        console.error("[local-pdf-annotator] hash-bundle migration check failed", e);
      }
    }

    return {
      annotationPath,
      fallbackPaths: uniquePaths(fallbacks).filter((path) => path !== annotationPath),
      migrateFallback: true,
      annotationBackupPath: backupPath,
    };
  }

  /** Session memo: skip rehashing an unchanged file on repeat opens. */
  private async hashForFile(file: TFile, pdfData: ArrayBuffer): Promise<string> {
    const stamp = `${normalizePath(file.path)}:${file.stat?.size ?? pdfData.byteLength}:${file.stat?.mtime ?? 0}`;
    const memo = this.hashMemo.get(stamp);
    if (memo) return memo;
    const hash = await sha256Hex(pdfData);
    this.hashMemo.set(stamp, hash);
    return hash;
  }

  /** HASH mode: create or resolve the stable bundle before annotations load. */
  async prepare(
    file: TFile,
    pdfData: ArrayBuffer,
    fingerprint: string | undefined,
    legacyPathOptions: AnnotationPathOptions
  ): Promise<PdfBundleBinding> {
    const hash = await sha256Hex(pdfData);
    let pending = this.pendingByHash.get(hash);
    if (!pending) {
      pending = this.ensureBundle(hash, file, pdfData, fingerprint, legacyPathOptions);
      this.pendingByHash.set(hash, pending);
    }

    try {
      const binding = await pending;
      this.pathToHash.set(normalizePath(file.path), hash);
      return await this.touchBinding(binding, file.path, file.name, fingerprint);
    } finally {
      if (this.pendingByHash.get(hash) === pending) this.pendingByHash.delete(hash);
    }
  }

  /** Best-effort metadata sync. Identity does not depend on it. */
  async onPdfRenamed(file: TFile, oldPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const hash = this.pathToHash.get(normalizedOld);
    if (!hash) return;
    this.pathToHash.delete(normalizedOld);
    this.pathToHash.set(normalizePath(file.path), hash);
    const binding = await this.readBinding(hash);
    if (binding) await this.touchBinding(binding, file.path, file.name, undefined, oldPath);
  }

  /** Keep the bundle's annotations after the working PDF is deleted. */
  async onPdfDeleted(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const hash = this.pathToHash.get(normalized);
    if (!hash) return;
    this.pathToHash.delete(normalized);
    const binding = await this.readBinding(hash);
    if (!binding) return;
    const now = new Date().toISOString();
    binding.manifest.currentPath = null;
    binding.manifest.aliases = uniquePaths([...binding.manifest.aliases, normalized]);
    binding.manifest.updated = now;
    await this.writeManifest(binding.manifestPath, binding.manifest);
  }

  async listBundles(): Promise<PdfBundleBinding[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(PDF_BUNDLE_LIBRARY))) return [];
    const listing = await adapter.list(PDF_BUNDLE_LIBRARY);
    const bundles: PdfBundleBinding[] = [];
    for (const folder of listing.folders) {
      const hash = folder.split("/").pop() ?? "";
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const binding = await this.readBinding(hash);
      if (binding) bundles.push(binding);
    }
    return bundles.sort((a, b) => b.manifest.lastSeen.localeCompare(a.manifest.lastSeen));
  }

  /** Size up leftover document.pdf recovery copies from older releases. */
  async statStoredPdfCopies(): Promise<StoredCopyStats> {
    return this.sweepStoredCopies(false);
  }

  /** Delete leftover document.pdf copies whose working PDF still exists.
   * A copy whose PDF is gone from the vault is the only surviving copy of
   * that document — those are always kept and reported instead. */
  async deleteStoredPdfCopies(): Promise<StoredCopyStats> {
    return this.sweepStoredCopies(true);
  }

  private async sweepStoredCopies(remove: boolean): Promise<StoredCopyStats> {
    const adapter = this.app.vault.adapter;
    const result: StoredCopyStats = { count: 0, bytes: 0, keptOrphans: 0 };
    if (!(await adapter.exists(PDF_BUNDLE_LIBRARY))) return result;
    const listing = await adapter.list(PDF_BUNDLE_LIBRARY);
    for (const folder of listing.folders) {
      const copyPath = normalizePath(`${folder}/document.pdf`);
      const stat = await adapter.stat(copyPath);
      if (stat?.type !== "file") continue;
      const manifest = await this.readManifest(normalizePath(`${folder}/manifest.json`));
      const knownPaths = uniquePaths([manifest?.currentPath, ...(manifest?.aliases ?? [])]);
      let workingCopyExists = false;
      for (const path of knownPaths) {
        if (await adapter.exists(path)) {
          workingCopyExists = true;
          break;
        }
      }
      if (!workingCopyExists) {
        result.keptOrphans++;
        continue;
      }
      result.count++;
      result.bytes += stat.size;
      if (remove) await adapter.remove(copyPath);
    }
    return result;
  }

  private async deleteStoredCopy(backupPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const stat = await adapter.stat(backupPath);
      if (stat?.type === "file") await adapter.remove(backupPath);
    } catch (e) {
      console.error("[local-pdf-annotator] could not delete stored PDF copy", e);
    }
  }

  /** Write a user-visible snapshot without making that path authoritative. */
  async exportAnnotations(
    file: TFile,
    exportFolder: string,
    options: AnnotationPathOptions = {}
  ): Promise<string> {
    const adapter = this.app.vault.adapter;
    const { annotationPath } = pathModeSidecarPaths(file.path, options);
    const pathCandidates = uniquePaths([
      annotationPath,
      sidecarPathFor(file.path, options),
      legacySidecarPathFor(file.path),
    ]);

    let sourcePath: string | null = null;
    let suffix = "";

    const tryBundle = async () => {
      const hash = await this.hashForFile(file, await this.app.vault.readBinary(file));
      const paths = pathsForHash(hash);
      if (await adapter.exists(paths.annotationPath)) {
        sourcePath = paths.annotationPath;
        suffix = `--${hash.slice(0, 12)}`;
      }
    };
    const tryPaths = async () => {
      for (const path of pathCandidates) {
        if (await adapter.exists(path)) {
          sourcePath = path;
          return;
        }
      }
    };

    // The active identity mode owns the canonical copy; the other is fallback.
    if (options.documentIdentity === "hash") {
      await tryBundle();
      if (!sourcePath) await tryPaths();
    } else {
      await tryPaths();
      if (!sourcePath) await tryBundle();
    }
    if (!sourcePath) throw new Error("No annotations exist for this PDF.");

    const folder = normalizePath(exportFolder).replace(/^\/+|\/+$/g, "");
    const exportPath = normalizePath(`${folder}/${file.basename}${suffix}.annotations.md`);
    // The marker keeps snapshots out of the fingerprint rescue index.
    const content = EXPORT_MARKER + "\n" + (await adapter.read(sourcePath));
    // Vault APIs so the folder and file are indexed immediately
    // (search/switcher); adapter fallback covers unusual paths, loudly.
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      /* already exists */
    }
    try {
      const existing = this.app.vault.getAbstractFileByPath(exportPath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, content);
      else await this.app.vault.create(exportPath, content);
    } catch (e) {
      console.warn("[local-pdf-annotator] vault export write failed; using adapter", e);
      await this.ensureFolder(folder);
      await adapter.write(exportPath, content);
    }
    return exportPath;
  }

  private async ensureBundle(
    hash: string,
    file: TFile,
    pdfData: ArrayBuffer,
    fingerprint: string | undefined,
    legacyPathOptions: AnnotationPathOptions
  ): Promise<PdfBundleBinding> {
    const paths = pathsForHash(hash);
    await this.ensureFolder(paths.rootPath);

    let manifest = await this.readManifest(paths.manifestPath);
    if (manifest?.sha256 !== hash) manifest = null;
    const now = new Date().toISOString();

    // The retired recovery-copy feature: reclaim the space on next open.
    await this.deleteStoredCopy(paths.backupPath);

    manifest = manifest ?? {
      version: 1,
      id: hash,
      sha256: hash,
      byteLength: pdfData.byteLength,
      originalName: file.name,
      currentPath: file.path,
      aliases: [file.path],
      fingerprint,
      created: now,
      updated: now,
      lastSeen: now,
      lastVerified: now,
    };
    manifest.byteLength = pdfData.byteLength;
    await this.writeManifest(paths.manifestPath, manifest);

    const fallbackAnnotationPaths = await this.legacyAnnotationCandidates(
      file.path,
      fingerprint,
      legacyPathOptions,
      paths.annotationPath
    );
    const annotationRecoveryPaths = (await this.app.vault.adapter.exists(paths.annotationBackupPath))
      ? [paths.annotationBackupPath]
      : [];
    return {
      ...paths,
      manifest,
      fallbackAnnotationPaths: uniquePaths([
        ...annotationRecoveryPaths,
        ...fallbackAnnotationPaths,
      ]),
    };
  }

  private async touchBinding(
    binding: PdfBundleBinding,
    currentPath: string,
    currentName: string,
    fingerprint?: string,
    oldPath?: string
  ): Promise<PdfBundleBinding> {
    const now = new Date().toISOString();
    const manifest = binding.manifest;
    manifest.currentPath = normalizePath(currentPath);
    manifest.aliases = uniquePaths([
      ...manifest.aliases,
      oldPath,
      currentPath,
    ]);
    manifest.originalName ||= currentName;
    if (fingerprint) manifest.fingerprint = fingerprint;
    manifest.lastSeen = now;
    manifest.updated = now;
    await this.writeManifest(binding.manifestPath, manifest);
    return binding;
  }

  private async legacyAnnotationCandidates(
    pdfPath: string,
    fingerprint: string | undefined,
    options: AnnotationPathOptions,
    canonicalPath: string
  ): Promise<string[]> {
    const central = sidecarPathFor(pdfPath, {
      storageMode: "folder",
      storageFolder: options.storageFolder,
    });
    // The old default folder remains a migration source even after the
    // setting auto-upgrades to the hidden default.
    const legacyCentral = sidecarPathFor(pdfPath, {
      storageMode: "folder",
      storageFolder: LEGACY_DEFAULT_ANNOTATION_FOLDER,
    });
    const configured = sidecarPathFor(pdfPath, options);
    const beside = legacySidecarPathFor(pdfPath);
    const direct = uniquePaths([configured, central, legacyCentral, beside]).filter(
      (path) => path !== canonicalPath
    );

    const existing: string[] = [];
    for (const path of direct) {
      if (await this.annotationCandidateMatches(path, fingerprint)) existing.push(path);
    }

    // A unique fingerprint match recovers an old sidecar after the PDF was
    // already renamed or moved before this storage system was installed.
    if (fingerprint) {
      const index = await this.getLegacyFingerprintIndex();
      const fingerprintMatches = (index.get(fingerprint) ?? []).filter(
        (path) => path !== canonicalPath && !existing.includes(path)
      );
      if (fingerprintMatches.length === 1) existing.push(fingerprintMatches[0]);
    }
    return existing;
  }

  private async annotationCandidateMatches(
    path: string,
    fingerprint: string | undefined
  ): Promise<boolean> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return false;
      const parsed = parseAnnotations(await this.app.vault.adapter.read(path));
      if (!parsed) return false;
      // A sidecar with a different document fingerprint must never migrate
      // merely because a new PDF was placed at the same visible path.
      return !fingerprint || !parsed.fingerprint || parsed.fingerprint === fingerprint;
    } catch {
      return false;
    }
  }

  private async getLegacyFingerprintIndex(): Promise<Map<string, string[]>> {
    if (this.legacyFingerprintIndex) return this.legacyFingerprintIndex;
    const index = new Map<string, string[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.toLowerCase().endsWith(".annotations.md")) continue;
      // Export snapshots share the document fingerprint; counting them would
      // make the uniqueness-gated rescue veto itself (or worse, adopt a stale
      // snapshot). Both export folder shapes exist: "<folder>/Exports/" and
      // the flat "PDF exports/" used when the storage folder is hidden.
      if (
        file.path.includes("/Exports/") ||
        file.path === "PDF exports" ||
        file.path.startsWith("PDF exports/")
      ) {
        continue;
      }
      try {
        const content = await this.app.vault.cachedRead(file);
        if (content.startsWith(EXPORT_MARKER)) continue; // export snapshot
        const parsed = parseAnnotations(content);
        if (!parsed?.fingerprint) continue;
        const paths = index.get(parsed.fingerprint) ?? [];
        paths.push(file.path);
        index.set(parsed.fingerprint, paths);
      } catch {
        /* A malformed legacy file must not block opening unrelated PDFs. */
      }
    }
    this.legacyFingerprintIndex = index;
    return index;
  }

  private async readBinding(hash: string): Promise<PdfBundleBinding | null> {
    const paths = pathsForHash(hash);
    const manifest = await this.readManifest(paths.manifestPath);
    return manifest && manifest.sha256 === hash
      ? { ...paths, manifest, fallbackAnnotationPaths: [] }
      : null;
  }

  private async readManifest(path: string): Promise<PdfBundleManifest | null> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const parsed = JSON.parse(await this.app.vault.adapter.read(path));
      return isManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeManifest(path: string, manifest: PdfBundleManifest): Promise<void> {
    await this.app.vault.adapter.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.app.vault.adapter.stat(current);
      if (stat?.type === "folder") continue;
      if (stat) throw new Error(`Cannot create PDF bundle folder because ${current} is a file.`);
      try {
        await this.app.vault.adapter.mkdir(current);
      } catch (error) {
        if ((await this.app.vault.adapter.stat(current))?.type !== "folder") throw error;
      }
    }
  }
}
