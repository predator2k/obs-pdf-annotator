import assert from "node:assert/strict";
import {
  AnnotationStore,
  moveSidecarsForRename,
  pathModeSidecarPaths,
  serializeAnnotations,
  type AnnotationDoc,
} from "../src/annotations";
import { PdfBundleManager } from "../src/bundles";
import { pathsForHash, sha256Hex } from "../src/bundle-identity";
import { TFile, normalizePath } from "./obsidian-stub";

class MemoryAdapter {
  text = new Map<string, string>();
  binary = new Map<string, ArrayBuffer>();
  folders = new Set<string>([""]);
  mtimes = new Map<string, number>();
  private clock = 0;

  private touch(path: string): void {
    this.mtimes.set(path, ++this.clock);
  }

  async exists(path: string): Promise<boolean> {
    path = normalizePath(path);
    return this.text.has(path) || this.binary.has(path) || this.folders.has(path);
  }

  async stat(path: string): Promise<any> {
    path = normalizePath(path);
    const mtime = this.mtimes.get(path) ?? 0;
    if (this.folders.has(path)) return { type: "folder", size: 0, ctime: 0, mtime };
    if (this.text.has(path)) {
      return { type: "file", size: new TextEncoder().encode(this.text.get(path)).byteLength, ctime: 0, mtime };
    }
    if (this.binary.has(path)) {
      return { type: "file", size: this.binary.get(path)!.byteLength, ctime: 0, mtime };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    path = normalizePath(path);
    const prefix = path ? `${path}/` : "";
    const direct = (candidate: string) => {
      if (!candidate.startsWith(prefix)) return false;
      return !candidate.slice(prefix.length).includes("/");
    };
    return {
      files: [...this.text.keys(), ...this.binary.keys()].filter(direct),
      folders: [...this.folders].filter((folder) => folder !== path && direct(folder)),
    };
  }

  async read(path: string): Promise<string> {
    const value = this.text.get(normalizePath(path));
    if (value === undefined) throw new Error(`Missing text file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    path = normalizePath(path);
    this.text.set(path, data);
    this.touch(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(normalizePath(path));
    if (!value) throw new Error(`Missing binary file: ${path}`);
    return value.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    path = normalizePath(path);
    this.binary.set(path, data.slice(0));
    this.touch(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async remove(path: string): Promise<void> {
    path = normalizePath(path);
    this.text.delete(path);
    this.binary.delete(path);
  }

  async rename(path: string, newPath: string): Promise<void> {
    path = normalizePath(path);
    newPath = normalizePath(newPath);
    if (this.text.has(path)) {
      this.text.set(newPath, this.text.get(path)!);
      this.text.delete(path);
    } else if (this.binary.has(path)) {
      this.binary.set(newPath, this.binary.get(path)!);
      this.binary.delete(path);
    } else {
      throw new Error(`Missing file: ${path}`);
    }
    this.touch(newPath);
    this.mtimes.delete(path);
  }
}

class MemoryVault {
  adapter = new MemoryAdapter();

  getMarkdownFiles(): TFile[] {
    return [...this.adapter.text.keys()]
      .filter((path) => path.endsWith(".md") && !path.startsWith(".pdf-annotator/"))
      .map((path) => new TFile(path));
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.adapter.binary.has(normalizePath(path)) ? new TFile(path) : null;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (await this.adapter.exists(path)) throw new Error(`Already exists: ${path}`);
    await this.adapter.writeBinary(path, data);
    return new TFile(path);
  }
}

const OPTIONS = { storageMode: "folder", storageFolder: "PDF annotations" } as const;

function annotationDoc(pdfPath: string, fingerprint: string, id: string, text: string): AnnotationDoc {
  return {
    version: 1,
    pdf: pdfPath,
    fingerprint,
    highlights: [
      { id, page: 0, color: "#FBF719", text, rects: [], created: "2026-07-17T00:00:00.000Z" },
    ],
  };
}

async function testPathMode(): Promise<void> {
  const vault = new MemoryVault();
  const app = { vault } as any;
  const manager = new PdfBundleManager(app);
  const file = new TFile("Downloads/paper.pdf") as any;
  const bytes = new TextEncoder().encode("original PDF").buffer;
  await vault.adapter.writeBinary(file.path, bytes);

  // Pre-seed an old hash bundle (with a leftover recovery copy) and an old
  // beside-the-pdf sidecar; both must surface as migration fallbacks.
  const hash = await sha256Hex(bytes);
  const bundle = pathsForHash(hash);
  for (const part of [".pdf-annotator", ".pdf-annotator/bundles", ".pdf-annotator/bundles/sha256", bundle.rootPath]) {
    await vault.adapter.mkdir(part);
  }
  await vault.adapter.write(
    bundle.annotationPath,
    serializeAnnotations(annotationDoc(file.path, "fp-a", "bundle01", "from the bundle"), "paper")
  );
  await vault.adapter.writeBinary(bundle.backupPath, bytes);
  const besidePath = "Downloads/paper.annotations.md";
  await vault.adapter.write(
    besidePath,
    serializeAnnotations(annotationDoc(file.path, "fp-a", "beside01", "beside the pdf"), "paper")
  );

  const binding = await manager.resolveBinding(file, bytes, "fp-a", {
    ...OPTIONS,
    documentIdentity: "path",
  });
  const expected = pathModeSidecarPaths(file.path, OPTIONS);
  assert.equal(binding.annotationPath, expected.annotationPath, "path mode uses the mirrored sidecar");
  assert.equal(binding.annotationBackupPath, expected.backupPath);
  assert.ok(binding.migrateFallback, "fallback content migrates into the canonical sidecar");
  assert.ok(binding.fallbackPaths.includes(besidePath), "beside-pdf sidecar is a migration source");
  assert.ok(binding.fallbackPaths.includes(bundle.annotationPath), "hash bundle is a migration source");
  assert.equal(
    await vault.adapter.exists(bundle.backupPath),
    false,
    "leftover stored PDF copy is deleted on open"
  );
  assert.equal(
    await vault.adapter.exists(bundle.annotationPath),
    true,
    "bundle annotations stay as a recovery snapshot"
  );

  const store = new AnnotationStore(
    vault.adapter as any,
    binding.annotationPath,
    file.basename,
    file.path,
    "fp-a",
    binding.fallbackPaths,
    binding.migrateFallback,
    binding.annotationBackupPath
  );
  await store.load();
  assert.equal(store.doc.highlights.length, 1, "migration loads the first matching fallback");
  assert.ok(await vault.adapter.exists(binding.annotationPath), "migration writes the path sidecar");

  // Rolling last-known-good copy + corruption recovery.
  store.update(store.doc.highlights[0].id, { note: "newer state" });
  await store.flush();
  assert.ok(await vault.adapter.exists(expected.backupPath), "flush keeps a last-known-good copy");
  await vault.adapter.write(binding.annotationPath, "partially written");
  const recovery = new AnnotationStore(
    vault.adapter as any,
    binding.annotationPath,
    file.basename,
    file.path,
    "fp-a",
    [expected.backupPath],
    true,
    expected.backupPath
  );
  await recovery.load();
  assert.equal(recovery.doc.highlights.length, 1, "corrupt canonical state recovers from previous");

  // Rename-follow moves both sidecar files to the mirrored location.
  const oldPath = file.path;
  file.setPath("Library/Philosophy/paper-renamed.pdf");
  await moveSidecarsForRename(vault.adapter as any, oldPath, file.path, OPTIONS);
  const moved = pathModeSidecarPaths(file.path, OPTIONS);
  assert.ok(await vault.adapter.exists(moved.annotationPath), "rename moves the sidecar");
  assert.ok(await vault.adapter.exists(moved.backupPath), "rename moves the rolling backup");
  assert.equal(await vault.adapter.exists(expected.annotationPath), false, "old sidecar is gone");

  // A second resolve with a sidecar already present must not re-migrate.
  await vault.adapter.writeBinary(file.path, bytes);
  const again = await manager.resolveBinding(file, bytes, "fp-a", {
    ...OPTIONS,
    documentIdentity: "path",
  });
  assert.equal(again.annotationPath, moved.annotationPath);
  console.log("path mode: ok");
}

async function testHashMode(): Promise<void> {
  const vault = new MemoryVault();
  const app = { vault } as any;
  const manager = new PdfBundleManager(app);
  const file = new TFile("Downloads/paper.pdf") as any;
  const originalBytes = new TextEncoder().encode("original PDF").buffer;
  const replacementBytes = new TextEncoder().encode("replacement PDF").buffer;
  await vault.adapter.writeBinary(file.path, originalBytes);

  const legacyPath = "PDF annotations/Downloads/paper.annotations.md";
  await vault.adapter.write(
    legacyPath,
    serializeAnnotations(annotationDoc(file.path, "fingerprint-a", "legacy01", "survives"), "paper")
  );

  // Pre-seed a leftover recovery copy from an older release.
  const hash = await sha256Hex(originalBytes);
  const bundle = pathsForHash(hash);
  await vault.adapter.writeBinary(bundle.backupPath, originalBytes);

  const first = await manager.prepare(file, originalBytes, "fingerprint-a", OPTIONS);
  assert.equal(
    await vault.adapter.exists(first.backupPath),
    false,
    "prepare writes no PDF copy and deletes leftovers"
  );
  assert.deepEqual(first.fallbackAnnotationPaths, [legacyPath]);

  const oldPath = file.path;
  file.setPath("Library/Philosophy/paper-renamed.pdf");
  await manager.onPdfRenamed(file, oldPath);
  const renamedManifest = JSON.parse(await vault.adapter.read(first.manifestPath));
  assert.equal(renamedManifest.currentPath, file.path);
  assert.ok(renamedManifest.aliases.includes(oldPath));

  await manager.onPdfDeleted(file.path);
  const deletedManifest = JSON.parse(await vault.adapter.read(first.manifestPath));
  assert.equal(deletedManifest.currentPath, null);

  const replacementFile = new TFile("Downloads/paper.pdf") as any;
  await vault.adapter.writeBinary(replacementFile.path, replacementBytes);
  const replacement = await manager.prepare(replacementFile, replacementBytes, "fingerprint-b", OPTIONS);
  assert.notEqual(first.id, replacement.id, "same path with different bytes creates a new bundle");
  assert.deepEqual(
    replacement.fallbackAnnotationPaths,
    [],
    "a replacement PDF cannot inherit a mismatched legacy sidecar"
  );
  console.log("hash mode: ok");
}

async function testStoredCopyCleanup(): Promise<void> {
  const vault = new MemoryVault();
  const app = { vault } as any;
  const manager = new PdfBundleManager(app);
  const bytes = new TextEncoder().encode("some PDF").buffer;

  const seedBundle = async (hash: string, pdfPath: string | null) => {
    const paths = pathsForHash(hash);
    for (const part of [".pdf-annotator", ".pdf-annotator/bundles", ".pdf-annotator/bundles/sha256", paths.rootPath]) {
      await vault.adapter.mkdir(part);
    }
    await vault.adapter.writeBinary(paths.backupPath, bytes);
    await vault.adapter.write(paths.annotationPath, "annotations stay");
    await vault.adapter.write(
      paths.manifestPath,
      JSON.stringify({
        version: 1,
        id: hash,
        sha256: hash,
        byteLength: bytes.byteLength,
        originalName: "doc.pdf",
        currentPath: pdfPath,
        aliases: pdfPath ? [pdfPath] : ["Gone/doc.pdf"],
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-01T00:00:00.000Z",
        lastVerified: "2026-01-01T00:00:00.000Z",
      })
    );
    if (pdfPath) await vault.adapter.writeBinary(pdfPath, bytes);
    return paths;
  };

  const live1 = await seedBundle("a".repeat(64), "Docs/one.pdf");
  const live2 = await seedBundle("b".repeat(64), "Docs/two.pdf");
  // This PDF no longer exists anywhere — its stored copy is the only survivor.
  const orphan = await seedBundle("c".repeat(64), null);

  const stats = await manager.statStoredPdfCopies();
  assert.equal(stats.count, 2, "only copies with living PDFs are deletable");
  assert.equal(stats.bytes, bytes.byteLength * 2);
  assert.equal(stats.keptOrphans, 1);

  const result = await manager.deleteStoredPdfCopies();
  assert.equal(result.count, 2);
  assert.equal(result.keptOrphans, 1);
  assert.equal(await vault.adapter.exists(live1.backupPath), false, "live copy deleted");
  assert.equal(await vault.adapter.exists(live2.backupPath), false, "live copy deleted");
  assert.ok(await vault.adapter.exists(orphan.backupPath), "sole-surviving copy kept");
  assert.ok(await vault.adapter.exists(live1.annotationPath), "annotations kept");
  console.log("stored-copy cleanup: ok");
}

/** 0.2.x upgrade: the bundle kept receiving edits while the mirrored sidecar
 * stayed frozen as the migration snapshot — the newer bundle must win. */
async function testUpgradePromotion(): Promise<void> {
  const vault = new MemoryVault();
  const app = { vault } as any;
  const manager = new PdfBundleManager(app);
  const file = new TFile("Books/study.pdf") as any;
  const bytes = new TextEncoder().encode("study PDF").buffer;
  await vault.adapter.writeBinary(file.path, bytes);

  const stale = annotationDoc(file.path, "fp-s", "old01", "pre-migration state");
  const sidecar = pathModeSidecarPaths(file.path, OPTIONS);
  await vault.adapter.write(sidecar.annotationPath, serializeAnnotations(stale, "study"));

  const hash = await sha256Hex(bytes);
  const bundle = pathsForHash(hash);
  for (const part of [".pdf-annotator", ".pdf-annotator/bundles", ".pdf-annotator/bundles/sha256", bundle.rootPath]) {
    await vault.adapter.mkdir(part);
  }
  const newer = annotationDoc(file.path, "fp-s", "old01", "pre-migration state");
  newer.highlights.push({
    id: "new01",
    page: 1,
    color: "#ffd400",
    text: "added during 0.2.x",
    rects: [],
    created: "2026-08-01T00:00:00.000Z",
  });
  await vault.adapter.write(bundle.annotationPath, serializeAnnotations(newer, "study"));

  const binding = await manager.resolveBinding(file, bytes, "fp-s", {
    ...OPTIONS,
    documentIdentity: "path",
  });
  const promoted = await vault.adapter.read(binding.annotationPath);
  assert.ok(promoted.includes("new01"), "newer bundle content promoted over the stale snapshot");
  assert.ok(
    (await vault.adapter.read(sidecar.backupPath)).includes("old01"),
    "displaced sidecar preserved as the rolling backup"
  );

  // Second open: the sidecar is now newest — no re-promotion churn.
  await vault.adapter.write(binding.annotationPath, promoted.replace("added during 0.2.x", "edited in 0.3.0"));
  const again = await manager.resolveBinding(file, bytes, "fp-s", {
    ...OPTIONS,
    documentIdentity: "path",
  });
  assert.ok(
    (await vault.adapter.read(again.annotationPath)).includes("edited in 0.3.0"),
    "fresh sidecar edits are never rolled back by the bundle"
  );
  console.log("upgrade promotion: ok");
}

/** Renaming onto a path whose sidecar slot is occupied by ANOTHER document
 * must preserve that document's annotations as a conflict snapshot. */
async function testRenameConflict(): Promise<void> {
  const vault = new MemoryVault();
  const docA = annotationDoc("Inbox/a.pdf", "fp-a", "a01", "doc A note");
  const docB = annotationDoc("Library/paper.pdf", "fp-b", "b01", "doc B note");
  const fromPaths = pathModeSidecarPaths("Inbox/a.pdf", OPTIONS);
  const toPaths = pathModeSidecarPaths("Library/paper.pdf", OPTIONS);
  await vault.adapter.write(fromPaths.annotationPath, serializeAnnotations(docA, "a"));
  await vault.adapter.write(toPaths.annotationPath, serializeAnnotations(docB, "paper"));

  await moveSidecarsForRename(vault.adapter as any, "Inbox/a.pdf", "Library/paper.pdf", OPTIONS);

  assert.ok(
    (await vault.adapter.read(toPaths.annotationPath)).includes("a01"),
    "renamed document's sidecar occupies the destination"
  );
  assert.equal(await vault.adapter.exists(fromPaths.annotationPath), false, "source moved away");
  const conflictFiles = [...vault.adapter.text.keys()].filter((p) =>
    p.includes(".annotations.conflict-")
  );
  assert.equal(conflictFiles.length, 1, "displaced sidecar kept as a conflict snapshot");
  assert.ok(
    (await vault.adapter.read(conflictFiles[0])).includes("b01"),
    "conflict snapshot holds the other document's annotations"
  );
  console.log("rename conflict: ok");
}

/** Renaming a document that has NO sidecar onto a path whose sidecar slot is
 * occupied must still preserve the occupant: the renamed document's store is
 * repointed at that path and would overwrite it on the next save. */
async function testRenameOntoOccupiedWithoutSource(): Promise<void> {
  const vault = new MemoryVault();
  const docB = annotationDoc("Library/paper.pdf", "fp-b", "b01", "doc B note");
  const toPaths = pathModeSidecarPaths("Library/paper.pdf", OPTIONS);
  await vault.adapter.write(toPaths.annotationPath, serializeAnnotations(docB, "paper"));

  // Inbox/scan.pdf was never annotated, so no source sidecar exists.
  await moveSidecarsForRename(vault.adapter as any, "Inbox/scan.pdf", "Library/paper.pdf", OPTIONS);

  const conflictFiles = [...vault.adapter.text.keys()].filter((p) =>
    p.includes(".annotations.conflict-")
  );
  assert.equal(conflictFiles.length, 1, "occupant preserved even with no source sidecar");
  assert.ok(
    (await vault.adapter.read(conflictFiles[0])).includes("b01"),
    "snapshot holds the occupant's annotations"
  );
  assert.equal(
    await vault.adapter.exists(toPaths.annotationPath),
    false,
    "destination slot is cleared for the renamed document"
  );
  console.log("rename onto occupied slot: ok");
}

/** A case-only rename is the same file on macOS/Windows; it must not be
 * mistaken for a collision and set aside. */
async function testCaseOnlyRename(): Promise<void> {
  const vault = new MemoryVault();
  const doc = annotationDoc("Books/A.pdf", "fp-a", "a01", "note");
  const from = pathModeSidecarPaths("Books/A.pdf", OPTIONS);
  await vault.adapter.write(from.annotationPath, serializeAnnotations(doc, "A"));
  await vault.adapter.write(from.backupPath, serializeAnnotations(doc, "A"));

  await moveSidecarsForRename(vault.adapter as any, "Books/A.pdf", "books/A.pdf", OPTIONS);

  const conflicts = [...vault.adapter.text.keys()].filter((p) => p.includes(".conflict-"));
  assert.equal(conflicts.length, 0, "a case-only change creates no conflict snapshot");
  const surviving = [...vault.adapter.text.keys()].filter((p) => p.endsWith(".annotations.md"));
  assert.equal(surviving.length, 1, "the sidecar still exists exactly once");
  assert.ok((await vault.adapter.read(surviving[0])).includes("a01"), "annotations intact");
  assert.ok(
    [...vault.adapter.text.keys()].some((p) => p.endsWith(".annotations.previous.md")),
    "the rolling backup was not deleted"
  );
  console.log("case-only rename: ok");
}

/** An edit made WHILE a save is in flight must still reach disk. */
async function testEditDuringFlush(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Books/A.pdf", OPTIONS);
  const store = new AnnotationStore(
    vault.adapter as any,
    paths.annotationPath,
    "A",
    "Books/A.pdf",
    "fp-a",
    [],
    false,
    paths.backupPath
  );
  store.add({ id: "h1", page: 0, color: "#ffd400", text: "first", created: "t0" } as any);

  const inFlight = store.flush();
  // Lands while the write above is still awaiting adapter round-trips.
  store.add({ id: "h2", page: 0, color: "#ffd400", text: "second", created: "t1" } as any);
  await inFlight;
  await store.flush();

  const written = await vault.adapter.read(paths.annotationPath);
  assert.ok(written.includes("h1"), "the first annotation is saved");
  assert.ok(written.includes("h2"), "the annotation added mid-save is NOT swallowed");
  console.log("edit during flush: ok");
}

/** A second writer's annotations must survive our whole-file rewrite. */
async function testMergeForeignAnnotations(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Books/A.pdf", OPTIONS);
  const makeStore = () =>
    new AnnotationStore(
      vault.adapter as any,
      paths.annotationPath,
      "A",
      "Books/A.pdf",
      "fp-a",
      [],
      false,
      paths.backupPath
    );

  // Two panes on the same document, each with its own store.
  const paneA = makeStore();
  const paneB = makeStore();
  await paneA.load();
  await paneB.load();

  paneA.add({ id: "hA", page: 0, color: "#ffd400", text: "from A", created: "t0" } as any);
  await paneA.flush();
  paneB.add({ id: "hB", page: 1, color: "#ff6666", text: "from B", created: "t1" } as any);
  await paneB.flush();

  const written = await vault.adapter.read(paths.annotationPath);
  assert.ok(written.includes("hB"), "the second pane's annotation is saved");
  assert.ok(written.includes("hA"), "the first pane's annotation is NOT destroyed");

  // A deletion must not be undone by the merge.
  paneB.remove("hA");
  await paneB.flush();
  const afterDelete = await vault.adapter.read(paths.annotationPath);
  assert.ok(!afterDelete.includes("hA"), "an explicit deletion is not resurrected by the merge");
  console.log("merge foreign annotations: ok");
}

/** The sidecar invites prose edits, so a user's own json fence must not make
 * the file look corrupt. */
async function testUserJsonFenceBelowBlock(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Books/A.pdf", OPTIONS);
  const doc = annotationDoc("Books/A.pdf", "fp-a", "a01", "real annotation");
  const withUserBlock =
    serializeAnnotations(doc, "A") +
    '\n\n## My reading notes\n\n```json\n{ "unrelated": true }\n```\n';
  await vault.adapter.write(paths.annotationPath, withUserBlock);

  const store = new AnnotationStore(
    vault.adapter as any,
    paths.annotationPath,
    "A",
    "Books/A.pdf",
    "fp-a",
    [],
    false,
    paths.backupPath
  );
  await store.load();
  assert.equal(store.doc.highlights.length, 1, "the managed block is found above the user's fence");
  assert.equal(store.doc.highlights[0].id, "a01", "and it is the real annotation data");
  console.log("user json fence below the managed block: ok");
}


/** A sidecar belonging to a DIFFERENT document must never be merged in. */
async function testMergeRefusesAnotherDocument(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Library/paper.pdf", OPTIONS);
  // Doc B's sidecar already occupies the slot, with B's fingerprint.
  const docB = annotationDoc("Library/paper.pdf", "fp-b", "b01", "doc B note");
  await vault.adapter.write(paths.annotationPath, serializeAnnotations(docB, "paper"));

  // Doc A was renamed onto that path: same path, DIFFERENT fingerprint.
  const store = new AnnotationStore(
    vault.adapter as any,
    paths.annotationPath,
    "paper",
    "Library/paper.pdf",
    "fp-a",
    [],
    false,
    paths.backupPath
  );
  store.add({ id: "a01", page: 0, color: "#ffd400", text: "doc A", created: "t0" } as any);
  await store.flush();

  assert.ok(
    !store.doc.highlights.some((h) => h.id === "b01"),
    "another document's annotations are not merged in on fingerprint mismatch"
  );
  console.log("merge refuses another document: ok");
}

/** After a rename the on-disk sidecar still records the OLD path; that is our
 * own file and its annotations must survive. */
async function testMergeStillWorksAfterRename(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Notes/new.html", OPTIONS);
  // Written by another device under the pre-rename path, no fingerprint (HTML).
  const disk: AnnotationDoc = {
    version: 1,
    pdf: "Notes/old.html",
    highlights: [
      { id: "ipad", page: 0, color: "#ffd400", text: "from the iPad", created: "t0" } as any,
    ],
  };
  await vault.adapter.write(paths.annotationPath, serializeAnnotations(disk, "old"));

  const store = new AnnotationStore(
    vault.adapter as any,
    paths.annotationPath,
    "old",
    "Notes/old.html",
    undefined,
    [],
    false,
    paths.backupPath
  );
  await store.load();
  store.setPdfPath("Notes/new.html", "new"); // the rename
  store.add({ id: "local", page: 0, color: "#ffd400", text: "local", created: "t1" } as any);
  await store.flush();

  const written = await vault.adapter.read(paths.annotationPath);
  assert.ok(written.includes("ipad"), "the other device's annotation survives the rename");
  assert.ok(written.includes("local"), "and so does the local one");
  console.log("merge still works after rename: ok");
}

/** A malformed entry must never make saving impossible. */
async function testMalformedHighlightNeverBreaksSaves(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Books/A.pdf", OPTIONS);
  // `created` is missing — the serializer sorts on it.
  const doc: any = {
    version: 1,
    pdf: "Books/A.pdf",
    fingerprint: "fp-a",
    highlights: [{ id: "broken", page: 0, color: "#ffd400", text: "no created" }],
  };
  await vault.adapter.write(paths.annotationPath, serializeAnnotations(doc, "A"));

  const store = new AnnotationStore(
    vault.adapter as any,
    paths.annotationPath,
    "A",
    "Books/A.pdf",
    "fp-a",
    [],
    false,
    paths.backupPath
  );
  await store.load();
  store.add({ id: "fresh", page: 0, color: "#ffd400", text: "new work", created: "t1" } as any);
  await store.flush();

  const written = await vault.adapter.read(paths.annotationPath);
  assert.ok(written.includes("fresh"), "a session's work still reaches disk");
  console.log("malformed highlight never breaks saves: ok");
}

/** A user's own empty-highlights fence must not read as an empty document. */
async function testUserEmptyHighlightsFenceIsIgnored(): Promise<void> {
  const vault = new MemoryVault();
  const paths = pathModeSidecarPaths("Books/A.pdf", OPTIONS);
  const doc = annotationDoc("Books/A.pdf", "fp-a", "a01", "real annotation");
  const withUserFence =
    serializeAnnotations(doc, "A") + '\n\n## Notes\n\n```json\n{ "highlights": [] }\n```\n';
  await vault.adapter.write(paths.annotationPath, withUserFence);

  const store = new AnnotationStore(
    vault.adapter as any,
    paths.annotationPath,
    "A",
    "Books/A.pdf",
    "fp-a",
    [],
    false,
    paths.backupPath
  );
  await store.load();
  assert.equal(store.doc.highlights.length, 1, "the managed block wins over a lookalike fence");
  console.log("user empty-highlights fence ignored: ok");
}

async function main(): Promise<void> {
  await testPathMode();
  await testHashMode();
  await testStoredCopyCleanup();
  await testUpgradePromotion();
  await testRenameConflict();
  await testRenameOntoOccupiedWithoutSource();
  await testCaseOnlyRename();
  await testEditDuringFlush();
  await testMergeForeignAnnotations();
  await testUserJsonFenceBelowBlock();
  await testMergeRefusesAnotherDocument();
  await testMergeStillWorksAfterRename();
  await testMalformedHighlightNeverBreaksSaves();
  await testUserEmptyHighlightsFenceIsIgnored();
  console.log("bundle manager smoke test passed");
}

void main();
