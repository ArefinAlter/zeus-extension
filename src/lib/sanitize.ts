// Text that originates from remote servers (file names, page titles) is data, never instructions
// (spec 00 section 11, 01 section 12). It is sanitised before display and is only ever put into
// the DOM with textContent.

// Code point ranges that are removed from displayed text: C0 and C1 controls, the Arabic letter
// mark, zero-width space, directional marks, line and paragraph separators and the bidirectional
// embedding, override and isolate controls, word joiner and invisible operators, the byte-order
// mark, interlinear annotation anchors and Unicode tag characters. ZWNJ and ZWJ (0x200C, 0x200D)
// are kept because Bangla and other scripts need them.
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

function isUnsafe(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/** Replace unsafe code points with a space. */
function stripUnsafe(input: string): string {
  let out = '';
  for (const ch of input) out += isUnsafe(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return out;
}

/** Single-line, bounded, display-safe version of untrusted text. */
export function displayText(input: string, maxChars = 120): string {
  const cleaned = stripUnsafe(input).replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length <= maxChars
    ? cleaned
    : chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…';
}

/** Last non-empty path component, for either separator style. Never returns a path. */
export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-1) ?? '';
}

const encoder = new TextEncoder();

/** UTF-8 byte length. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Shorten a file name to at most `maxBytes` UTF-8 bytes, keeping a short extension
 * (spec 00 section 10: file names are limited to 255 bytes).
 */
export function truncateFileName(name: string, maxBytes = 255): string {
  if (utf8Length(name) <= maxBytes) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : '';
  const stem = Array.from(ext === '' ? name : name.slice(0, dot));
  const budget = maxBytes - utf8Length(ext);
  while (stem.length > 0 && utf8Length(stem.join('')) > budget) stem.pop();
  return stem.join('') + ext;
}

/** File name to put in a handoff offer: a bounded basename without control characters. */
export function offerFileName(browserPath: string, urlFallback: string): string {
  const strip = (s: string): string => {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp > 0x1f && (cp < 0x7f || cp > 0x9f)) out += ch;
    }
    return out.trim();
  };
  let name = strip(basenameOf(browserPath));
  if (name === '') {
    try {
      name = strip(decodeURIComponent(basenameOf(new URL(urlFallback).pathname)));
    } catch {
      name = '';
    }
  }
  return truncateFileName(name === '' ? 'download' : name);
}
