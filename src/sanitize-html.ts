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
  "script", "style", "link", "iframe", "embed", "base", "meta",
  "template", "applet", "frame", "frameset", "portal", "handler", "listener",
  "animate", "animatecolor", "animatemotion", "animatetransform", "set", "discard",
  "use", "foreignobject",
]);

/** Attributes whose value is fetched or navigated to. Matched by local name, so
 * any prefix bound to xlink (`xlink:href`, `xl:href`) is covered. */
/**
 * Unsafe containers whose CHILDREN are legitimate content: drop the element,
 * keep what it wrapped. Distinct from FORBIDDEN_ELEMENTS, where the subtree is
 * itself the payload (`<script>`, `<style>`).
 */
export const UNWRAP_ELEMENTS = new Set(["form", "object", "noscript"]);

export const URL_ATTRS = new Set([
  "href", "src", "srcset", "poster", "background", "action", "formaction", "data",
  "ping", "cite", "longdesc", "usemap", "profile", "manifest", "codebase", "dynsrc", "lowsrc",
]);

/**
 * Inline-style properties a reading view may keep. An ALLOWLIST, because a
 * denylist cannot survive indirection: `--p:fixed; position:var(--p)` computes
 * to `position: fixed` while the declaration serializes as `var(--p)`, and
 * `background-image:var(--x,\75 rl(...))` fetches a remote beacon while
 * containing neither "url(" nor a known-bad keyword. Both were verified working
 * against the previous denylist.
 *
 * Custom properties are absent from this list, so `var()` has nothing left to
 * resolve. So are `position`, `transform` and `z-index` — the article renders
 * inside the LIVE workspace document, so anything that can leave the flow can
 * float over Obsidian's own UI as a phishing surface.
 */
export const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color", "opacity",
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent",
  "text-transform", "text-shadow", "vertical-align", "white-space", "word-break",
  "text-decoration", "text-decoration-line", "text-decoration-color", "text-decoration-style",
  "direction", "unicode-bidi", "list-style-type",
  "border", "border-top", "border-bottom", "border-left", "border-right",
  "border-color", "border-style", "border-width", "border-radius",
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "width", "max-width", "height", "max-height",
]);

/** Fallback text screen, used only when no CSSOM is available to parse with. */
const FORBIDDEN_STYLE =
  /url\s*\(|image-set\s*\(|expression\s*\(|-moz-binding|behavior\s*:|@import|var\s*\(|position\s*:|transform\s*:|z-index\s*:/i;

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

/**
 * Every candidate URL in a srcset must pass, not just the first.
 *
 * srcset ends a candidate at a comma AND separates the URL from its descriptor
 * on whitespace, so neither split alone is right: splitting on commas mangles
 * data: URLs, and splitting on whitespace alone hands back "1x,javascript:..."
 * as one token that starts with a digit and therefore matches no scheme —
 * letting every candidate after the first descriptor through unchecked.
 *
 * Split on BOTH, and require any token that carries a scheme to pass. Tokens
 * without a colon are relative URLs or descriptors ("2x", "640w"), which are
 * safe by construction; a data: URL's own comma splits it into a head that
 * still carries — and is judged on — its scheme.
 */
export function safeSrcset(value: string): boolean {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((token) => !token.includes(":") || safeUrl(token));
}

/** True when this attribute must be removed from `el`. */
export function attributeIsUnsafe(name: string, localName: string, value: string): boolean {
  const local = localName.toLowerCase();
  if (/^on/i.test(local) || /^on/i.test(name)) return true;
  // `style` is NOT judged here: sanitizeDocument runs it through the real CSS
  // parser, which is the only thing that sees through escapes and var(). This
  // used to run first and delete the whole attribute on a text match, so an
  // honest page lost all its styling while an escaped payload got the precise
  // treatment.
  if (local === "style") return false;
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
    const name = el.localName.toLowerCase();
    if (UNWRAP_ELEMENTS.has(name)) {
      // The element is unsafe but its CONTENT is the article. Deleting the
      // subtree silently blanked pages that wrap their body in a <form>, and
      // dropped every <object>'s fallback text. Hoist the children instead.
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
      }
      el.remove();
      continue;
    }
    if (FORBIDDEN_ELEMENTS.has(name)) {
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
    // No CSSOM to verify with (headless tests): fall back to the text screen.
    return FORBIDDEN_STYLE.test(value) ? null : value;
  }
  const style = probe.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const name = style.item(i);
    if (!ALLOWED_STYLE_PROPS.has(name.toLowerCase())) {
      style.removeProperty(name);
      continue;
    }
    // Belt and braces: an allowed property must still not fetch anything.
    const parsed = style.getPropertyValue(name).toLowerCase();
    if (parsed.includes("url(") || parsed.includes("image-set(") || parsed.includes("var(")) {
      style.removeProperty(name);
    }
  }
  return style.cssText || null;
}
