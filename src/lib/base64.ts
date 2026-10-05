// Standard-alphabet base64 with padding (RFC 4648 section 4), the encoding of fetch.chunk data.
// Hand-written because the worker has no Buffer, btoa needs a binary string (slow for 2 MiB), and
// Uint8Array.prototype.toBase64 is not available in every supported browser.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHARS = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));

/** Length of the padded base64 text for `n` input bytes. */
export function base64Length(n: number): number {
  return Math.ceil(n / 3) * 4;
}

export function encodeBase64(bytes: Uint8Array): string {
  const n = bytes.length;
  const out = new Uint8Array(base64Length(n));
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out[o++] = CHARS[(v >> 18) & 63] ?? 0;
    out[o++] = CHARS[(v >> 12) & 63] ?? 0;
    out[o++] = CHARS[(v >> 6) & 63] ?? 0;
    out[o++] = CHARS[v & 63] ?? 0;
  }
  const rest = n - i;
  if (rest === 1) {
    const v = (bytes[i] ?? 0) << 16;
    out[o++] = CHARS[(v >> 18) & 63] ?? 0;
    out[o++] = CHARS[(v >> 12) & 63] ?? 0;
    out[o++] = 61;
    out[o] = 61;
  } else if (rest === 2) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out[o++] = CHARS[(v >> 18) & 63] ?? 0;
    out[o++] = CHARS[(v >> 12) & 63] ?? 0;
    out[o++] = CHARS[(v >> 6) & 63] ?? 0;
    out[o] = 61;
  }
  // latin1 decoding of ASCII bytes is a plain copy and is far faster than String.fromCharCode loops
  return new TextDecoder('latin1').decode(out);
}
