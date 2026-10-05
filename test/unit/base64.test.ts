import { describe, expect, it } from 'vitest';
import { base64Length, encodeBase64 } from '../../src/lib/base64';

describe('encodeBase64', () => {
  it('matches Buffer for every length up to 64 and a 3 MiB buffer', () => {
    for (let n = 0; n <= 64; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 255;
    expect(encodeBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });

  it('reproduces the spec fetch.chunk example', () => {
    expect(encodeBase64(new TextEncoder().encode('hello-world!'))).toBe('aGVsbG8td29ybGQh');
  });

  it('reports the padded length', () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(2_097_152)).toBe(2_796_204);
  });
});
