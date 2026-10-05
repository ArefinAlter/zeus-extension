import { describe, expect, it } from 'vitest';
import vectors from '../../schema/redaction-vectors.v1.json';
import {
  UNPARSEABLE_URL,
  looksSecret,
  redactUrl,
  scrubUrls,
  type RedactMode,
} from '../../src/lib/redact';

interface Vector {
  name: string;
  mode: RedactMode;
  input: string;
  expected: string;
  redacted: boolean;
}

describe('redact_url normative vectors (spec 00 section 8.2)', () => {
  for (const v of vectors.cases as Vector[]) {
    it(`${v.name} [${v.mode}]`, () => {
      expect(redactUrl(v.input, v.mode)).toEqual({ url: v.expected, redacted: v.redacted });
    });
  }

  it('is idempotent where the output has no display-only ellipsis', () => {
    for (const v of vectors.cases as Vector[]) {
      if (v.expected.includes(String.fromCodePoint(0x2026))) continue;
      const once = redactUrl(v.input, v.mode).url;
      expect(redactUrl(once, v.mode).url).toBe(once);
    }
  });
});

describe('redactUrl totality', () => {
  it('does not throw on unparseable input and leaks none of it', () => {
    const out = redactUrl('not a url ZEUS-CANARY-1', 'log');
    expect(out).toEqual({ url: UNPARSEABLE_URL, redacted: true });
  });

  it('removes userinfo and fragment in every mode', () => {
    for (const mode of ['log', 'record', 'strict'] as const) {
      const { url } = redactUrl('https://u:p@example.com/x#frag', mode);
      expect(url).not.toMatch(/u:p|frag/);
    }
  });
});

describe('looksSecret', () => {
  it('flags a JWT and long hex, not a UUID or a readable slug', () => {
    expect(looksSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe(true);
    expect(looksSecret('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(looksSecret('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(looksSecret('Quarterly-Report-2026-final-version')).toBe(false);
  });
});

describe('scrubUrls', () => {
  it('reduces every URL inside free text', () => {
    const text = 'GET https://files.example.com/a/b?token=ZEUS-CANARY-9 failed';
    const ellipsis = String.fromCodePoint(0x2026);
    expect(scrubUrls(text)).toBe(`GET https://files.example.com/a/b?${ellipsis} failed`);
    expect(scrubUrls(text)).not.toContain('ZEUS-CANARY');
  });
});
