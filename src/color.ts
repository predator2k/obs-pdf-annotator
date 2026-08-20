/**
 * color.ts — pure color math shared by both PDF modes and the palette
 * settings. No Obsidian imports and no palette knowledge (annotations.ts owns
 * the palette and imports from here, so this file must stay dependency-free).
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Painted alpha cap so stacked marker fills never render text unreadable. */
export const MAX_HIGHLIGHT_ALPHA = 0.46;

export function parseColor(color: string): Rgba | null {
  const rgb = color.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+)\s*)?\)$/i
  );
  if (rgb) {
    return {
      r: clampCssByte(Number(rgb[1])),
      g: clampCssByte(Number(rgb[2])),
      b: clampCssByte(Number(rgb[3])),
      a: rgb[4] === undefined ? 1 : clampCssAlpha(Number(rgb[4])),
    };
  }
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1].length === 3 ? hex[1].split("").map((ch) => ch + ch).join("") : hex[1];
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

/** Crisp stroke color for line/box styles when a stored color has no palette
 * entry (custom colors): darken the hue and make it near-opaque. */
export function markInkColor(color: string): string {
  const c = parseColor(color);
  if (!c) return color;
  const k = 0.62;
  return `rgba(${Math.round(c.r * k)}, ${Math.round(c.g * k)}, ${Math.round(c.b * k)}, 0.95)`;
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(alpha)})`;
}

export function clampCssByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function clampCssAlpha(value: number): number {
  if (!Number.isFinite(value)) return MAX_HIGHLIGHT_ALPHA;
  return Math.min(1, Math.max(0, value));
}

/** Colored-square emoji for a fill, by hue bucket (used in sidecar prose). */
export function deriveEmoji(fill: string): string {
  const c = parseColor(fill);
  if (!c) return "🟨";
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  if (max - min < 24) return max > 128 ? "⬜" : "⬛";
  const d = max - min;
  let hue: number;
  if (max === c.r) hue = ((c.g - c.b) / d + (c.g < c.b ? 6 : 0)) * 60;
  else if (max === c.g) hue = ((c.b - c.r) / d + 2) * 60;
  else hue = ((c.r - c.g) / d + 4) * 60;
  if (hue < 15 || hue >= 330) return "🟥";
  if (hue < 45) return "🟧";
  if (hue < 70) return "🟨";
  if (hue < 170) return "🟩";
  if (hue < 250) return "🟦";
  return "🟪";
}
