/**
 * sanitize-html.ts — strip active content from a parsed HTML document.
 *
 * The HTML reader renders articles into the LIVE workspace document, inside
 * Obsidian's Electron renderer. Anything that executes here executes with the
 * app's privileges, so this module is the whole security boundary.
 *
 * It is an ALLOWLIST for URL schemes and a removal list for elements, in that
 * order of importance. A denylist of bad URL prefixes cannot work: the URL
 * parser strips ASCII whitespace and control characters from inside a scheme
 * before resolving it, so `java&#9;script:` and `javascript:` navigate
 * identically while only the latter matches a naive prefix test.
 *
 * Pure module — no Obsidian and no DOM globals beyond the Document handed in —
 * so the smoke tests exercise it headlessly.
 */

/**
 * Elements dropped wholesale, matched by LOCAL name so namespaced spellings
 * (`svg:script`) are caught too.
 *
 * The SVG animation elements are here for a non-obvious reason: `<animate>` and
 * `<set>` can WRITE an attribute — `href` included — at run time, from a `to`/
 * `values` payload that is not itself a URL attribute. A document whose every
 * attribute passes inspection can therefore still animate a `javascript:` URL
 * into an anchor after rendering, leaving no trace in the serialized markup.
 * `use`/`foreignObject` pull in referenced or re-parsed content for the same
 * reason. None of them are worth a partial subset in a reading view.
 */
export const FORBIDDEN_ELEMENTS = new Set([
  "script", "style", "link", "iframe", "object", "embed", "form", "base", "meta",
  "noscript", "template", "applet", "frame", "frameset", "portal", "handler", "listener",
  "animate", "animatecolor", "animatemotion", "animatetransform", "set", "discard",
  "use", "foreignobject",
]);

/** Attributes whose value is fetched or navigated to. Matched by local name, so
 * any prefix bound to xlink (`xlink:href`, `xl:href`) is covered. */
export const URL_ATTRS = new Set([
  "href", "src", "srcset", "poster", "background", "action", "formaction", "data",
  "ping", "cite", "longdesc", "usemap", "profile", "manifest", "codebase", "dynsrc", "lowsrc",
]);

/** Inline-style payloads that fetch remote resources, execute, or float an
 * element over Obsidian's own UI (the article renders in the live workspace
 * document, so a fixed-position overlay would cover the real app chrome). */
const FORBIDDEN_STYLE =
  /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:|@import|position\s*:\s*(?:fixed|sticky)/i;

/**
 * Is this URL safe to leave in the document? Normalize the way the URL parser
 * does, then allow only known-safe schemes instead of denying known-bad ones.
 */
export function safeUrl(value: string): boolean {
  const v = value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!scheme) return true; // relative path or #fragment
  switch (scheme[1]) {
    case "http":
    case "https":
    case "mailto":
    case "tel":
      return true;
    // NOT blob: or app:. The reader writes the app:// resource path for local
    // images ITSELF, after sanitization, from a resolved vault file — so the
    // only such URLs reaching here are author-written, and app:// can address
    // absolute local paths.
    case "data":
      // Raster images only: data:text/html and data:image/svg+xml are scriptable.
      return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]/.test(v);
    default:
      return false;
  }
}

/** Every candidate URL in a srcset must pass, not just the first. */
export function safeSrcset(value: string): boolean {
  // The srcset grammar separates a candidate's URL from its descriptor on ASCII
  // whitespace, and a URL may itself contain commas (data: URLs do), so
  // splitting on commas both misses candidates and mangles valid ones. Checking
  // every whitespace-separated token is strictly safer: descriptors like "2x"
  // or "640w" carry no scheme and pass trivially.
  return value
    .split(/\s+/)
    .map((token) => token.replace(/,+$/, ""))
    .filter(Boolean)
    .every(safeUrl);
}

/** True when this attribute must be removed from `el`. */
export function attributeIsUnsafe(name: string, localName: string, value: string): boolean {
  const local = localName.toLowerCase();
  if (/^on/i.test(local) || /^on/i.test(name)) return true;
  if (local === "style") return FORBIDDEN_STYLE.test(value);
  if (!URL_ATTRS.has(local)) return false;
  return local === "srcset" ? !safeSrcset(value) : !safeUrl(value);
}

/**
 * Strip active content from a parsed document, in place.
 *
 * Parsing must happen in a detached `DOMParser` document, which runs no scripts
 * and fetches no subresources, so this runs before anything in the file can act.
 */
export function sanitizeDocument(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (FORBIDDEN_ELEMENTS.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (attributeIsUnsafe(attr.name, attr.localName, attr.value)) {
        el.removeAttributeNode(attr);
      } else if (attr.localName.toLowerCase() === "style") {
        const cleaned = sanitizeStyleWithCssom(doc, attr.value);
        if (!cleaned) el.removeAttributeNode(attr);
        else if (cleaned !== attr.value) el.setAttribute(attr.name, cleaned);
      }
    }
  }
}

/**
 * Re-check an inline style through the browser's own CSS parser.
 *
 * The text regex above is a first pass only; it cannot be authoritative,
 * because CSS escapes and comments make the same declaration unrecognizable as
 * text while parsing identically: `position:/**\/fixed`, `po\73 ition:fixed`
 * and `\75 rl(...)` all compute exactly like their plain spellings. Assigning
 * to `cssText` hands the string to the real parser, after which the declaration
 * names and values are normalized and can be compared literally.
 *
 * Offending declarations are dropped individually so the rest of the element's
 * styling survives. Returns null when nothing usable is left.
 */
function sanitizeStyleWithCssom(doc: Document, value: string): string | null {
  let probe: HTMLElement;
  try {
    probe = doc.createElement("div");
    probe.style.cssText = value;
  } catch {
    return null; // cannot verify it, so do not keep it
  }
  const style = probe.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const name = style.item(i);
    const parsed = style.getPropertyValue(name).toLowerCase();
    // url()/image-set() fetch from a remote host the moment the article paints.
    if (parsed.includes("url(") || parsed.includes("image-set(")) {
      style.removeProperty(name);
      continue;
    }
    // The article renders inside the live workspace document, so a fixed or
    // sticky box can float over Obsidian's own UI — a ready-made phishing
    // overlay wearing the app's chrome.
    if (name.toLowerCase() === "position" && (parsed === "fixed" || parsed === "sticky")) {
      style.removeProperty(name);
    }
  }
  return style.cssText || null;
}
