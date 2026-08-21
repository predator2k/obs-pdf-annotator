# PDF Annotator

Read a PDF, mark the parts that matter, and keep your own thoughts beside the
words — all inside Obsidian, on desktop and mobile.

Open any PDF — your highlights are right there, and a color bar sits in the
toolbar. Pick a color, select a sentence, and it's highlighted; click it to
write a note, and carry on reading without changing apps.

## Mark what matters

Select some words and choose what you want to do:

- **Highlight** marks the words.
- **Annotate** marks the words and opens a note editor.
- **Copy** copies the selected words.

![Simple buttons for highlighting, annotating, or copying selected words](docs/screenshots/selection-popover-light-retina.png)

Pick the mark style right in the popover: plain highlight, underline, dotted
underline, dashed underline, box, or strike-through. Your last style and color
are remembered — set your pen once and keep reading.

Prefer zero clicks? **Arm a color in the toolbar** (click one of the swatches
between the native controls): from then on, selecting text highlights it
instantly with your current style — no popover. Click the armed swatch again
to disarm and get the popover flow back.

## Notes live in a popup

Notes come in two forms:

- **Attached to a highlight** — choose **Annotate** after selecting text, or
  click an existing mark and write in its popup.
- **Free-form page notes** — click the tag button in the toolbar, then click
  anywhere on the page. The note is anchored to that exact position, no text
  selection needed.

Click any mark or page note to open its editor. The popup shows the quoted
words (for highlights), and lets you change the style, change the color, write
a note, copy the text, copy a link, or delete it. Nothing moves on the page and
the zoom level never changes.

On phones the same editor opens as a sheet, sized for thumbs.

## Cite a highlight in your notes

Right-click a mark (or use the **Copy link** button in the popup) to copy a
markdown link like:

```text
[[paper.pdf#page=5&selection=12,0,14,7|paper, p.5]]
```

Paste it into any note. Clicking it scrolls to the page and flashes the exact
words — using Obsidian's own PDF link format, so the link keeps working even
if this plugin is disabled. When the exact words cannot be located (scanned or
unusual PDFs), the link points at the page instead.

Free-form page notes are linkable too: their links use Obsidian's native
scroll-destination form (`#page=N&offset=x,y,0`), which jumps to the note's
exact position on the page.

## Find a note again

- **In the PDF**: click the list button beside **Annotate** for a searchable
  list of every mark and note. Click a result to jump to it.
- **In the sidebar**: run **Open annotations panel** for a workspace panel that
  always shows the highlights of the PDF you are reading, with search. It works
  with both viewing modes and stays put while you write in other notes.

![The searchable list of notes beside the PDF](docs/screenshots/annotation-list-light-retina.png)

## Your own colors

Add, rename, or remove highlight colors in the plugin settings with a color
picker. Existing marks always keep the color they were made with, even if you
later remove it from the palette.

## HTML files too

Open any `.html` or `.htm` file in the vault and it renders as a clean,
theme-styled reading view with the exact same annotation experience: select
text, pick a color and style, click marks to write notes, find everything in
the annotations panel. Marks are anchored by their quoted text (with
surrounding context), so they survive edits around them and reflow with the
document. Scripts and active content are stripped before rendering; sidecars
use the same storage as PDFs.

## Margin note cards (optional)

If you prefer notes laid out beside the page, enable **Show margin note cards**
in settings. Cards appear in whatever margin space already exists — the plugin
never zooms the page out to make room. Short notes stay small, long notes fold
gently, and hovering or selecting a card expands it.

![A PDF page with several short and long notes on both sides](docs/screenshots/annotation-cards-overview-light-retina.png)

---

## Technical Notes

PDF Annotator is an Obsidian community plugin for desktop and mobile. Its main
mode adds annotation layers, controls, and an annotation list to Obsidian's
native PDF viewer; the native toolbar, outline/sidebar, zoom, and page
navigation remain in place and are never driven programmatically.

Selection alone does not create an annotation. The selection popover commits a
highlight or annotated mark only after you choose an action. Highlight geometry
is stored in PDF user-space coordinates, so marks stay anchored across zoom and
resize changes.

### Native PDF workflow

1. Open a PDF normally in Obsidian — annotation mode attaches automatically
   (toggle it off per-PDF with the command palette if you want a plain viewer).
2. Select text: with a toolbar color armed the highlight applies instantly;
   otherwise the color/style popover appears and a color click commits.
3. Click an existing mark to edit its style, colour, or note in the popup;
   right-click for the menu (copy link, delete, card placement).
4. Use the in-PDF list or the sidebar panel for search and navigation.

### Highlight links

**Copy link** produces Obsidian-native subpaths
(`#page=N&selection=beginIndex,beginOffset,endIndex,endOffset`). In the native
viewer the selection indices are read from the rendered text layer (exact by
construction), so copy the link while the page is on screen; if the page is
not rendered — or no confident text match exists — the link degrades to
`#page=N` rather than pointing at the wrong words.

## Storage

Annotations are stored in a human-readable Markdown sidecar per PDF. The
sidecar has a readable summary plus a fenced JSON block that is the
machine-readable source of truth. A rolling `*.annotations.previous.md`
last-known-good copy protects against interrupted or corrupted saves. The
working PDF itself is never modified.

**How a PDF is matched to its annotations** is configurable:

- **File path** (default): the sidecar lives in the annotation folder,
  mirroring the PDF's vault path — `Books/Novel.pdf` →
  `.pdf-annotate/Books/Novel.annotations.md`. Opening is fast (no hashing in
  fresh vaults; vaults upgraded from 0.2.x hash once per open while old bundle
  data remains, to keep migrations safe), annotations survive edits to the
  PDF's contents, and renaming or moving the PDF inside Obsidian moves the
  sidecar along automatically. Moving the file outside Obsidian leaves the
  sidecar behind (it can be re-attached via the fingerprint match on first
  open).
- **Content hash**: the SHA-256 of the PDF bytes is the identity, with the
  sidecar stored under `.pdf-annotator/bundles/sha256/<hash>/`. Robust against
  moves and renames done outside Obsidian, but an edited PDF counts as a new
  document, and every open reads and hashes the whole file.

Annotations created under one mode are found and migrated automatically when
you switch modes or upgrade from an older release; legacy files are retained as
recovery snapshots.

### Retired: stored PDF copies

Versions up to 0.2.x kept a byte-for-byte recovery copy of every annotated PDF
inside `.pdf-annotator/`. This doubled the storage cost per document and has
been retired: no new copies are written, leftover copies are deleted
automatically the next time each PDF is opened, and the
**Delete stored PDF copies** command reclaims the rest in one go. The plugin
never deletes or modifies your working PDFs — keep your vault covered by
iCloud, Obsidian Sync, or another backup system as usual.

## Mobile

The plugin runs on iOS, iPadOS, and Android (Obsidian 1.8.10 or newer). The
native-viewer annotation mode is the mobile experience: select text with the
system grabbers, then use the popover; tap a mark to edit it in a sheet.
Tag dragging and hover previews are desktop-only.

## Privacy

PDF Annotator does not use telemetry and does not send PDF contents or
annotation contents to any remote service. Data is stored locally in your
vault.

## Legacy Import

If you previously used `obsidian-annotator`, open the target PDF in this plugin
and run:

```text
Import legacy obsidian-annotator highlights for this PDF
```

The importer searches notes with `annotation-target:` frontmatter, re-anchors
quoted text in the PDF, and creates PDF Annotator highlights. Legacy notes are
left untouched.

## Fallback Annotator View

The original bundled `pdf.js` annotator view remains available as a stable
fallback (desktop). Use the command palette action:

```text
Open current PDF in annotator
```

You can also make the fallback annotator the default PDF viewer from plugin
settings (desktop only). This redirects ordinary `.pdf` clicks into
PDF Annotator.

## Commands

- **Toggle annotation mode on the native PDF view**
- **Open annotations panel**
- **Export annotations for current PDF** — snapshot under
  `.pdf-annotate/Exports/`
- **Delete stored PDF copies (reclaim space)** — removes 0.2.x-era duplicates
  (copies whose PDF no longer exists anywhere in the vault are kept, since they
  are the only surviving copy of that document)
- **Import legacy obsidian-annotator highlights for this PDF**
- **Open current PDF in annotator** — the fallback custom view

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` type-checks the plugin, bundles `main.js`, and copies
`main.js`, `manifest.json`, and `styles.css` into
`LOCAL_PDF_ANNOTATOR_PLUGIN_DIR` (or `./dist` when unset). Point that variable
at a vault's `.obsidian/plugins/local-pdf-annotator/` to test in Obsidian.

The plugin bundles its own pinned pdf.js and worker (inlined as a Blob URL) so
it can never conflict with Obsidian's internal pdf.js version.

## Release Files

Obsidian installs community plugin releases from GitHub release assets. A
release must include:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match the `version` field in `manifest.json`.
