import { describe, expect, it } from 'vitest';
import {
  basenameOf,
  displayText,
  offerFileName,
  truncateFileName,
  utf8Length,
} from '../../src/lib/sanitize';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('displayText', () => {
  it('removes bidi overrides, controls and collapses whitespace', () => {
    const evil = `evil${cp(0x202e)}exe.pdf${cp(0)}\n  name`;
    expect(displayText(evil)).toBe('evil exe.pdf name');
  });
  it('keeps ZWNJ and ZWJ used by Bangla', () => {
    const bn = `ক্ষ${cp(0x200c)}র`;
    expect(displayText(bn)).toBe(bn);
  });
  it('truncates by code points with an ellipsis', () => {
    expect(displayText('a'.repeat(300), 10)).toBe(`aaaaaaaaa${cp(0x2026)}`);
    expect(Array.from(displayText(cp(0x1f600).repeat(50), 5))).toHaveLength(5);
  });
});

describe('file names', () => {
  it('takes the basename for both separator styles', () => {
    expect(basenameOf('C:\\Users\\ada\\Downloads\\a.zip')).toBe('a.zip');
    expect(basenameOf('/home/ada/b.tar.gz')).toBe('b.tar.gz');
    expect(basenameOf('')).toBe('');
  });
  it('truncates to 255 UTF-8 bytes keeping the extension', () => {
    const name = cp(0xe9).repeat(200) + '.tar.gz';
    const out = truncateFileName(name);
    expect(utf8Length(out)).toBeLessThanOrEqual(255);
    expect(out.endsWith('.gz')).toBe(true);
  });
  it('falls back to the URL path and then to "download"', () => {
    expect(offerFileName('', 'https://x.example/a/report%20v2.pdf?sig=abc')).toBe('report v2.pdf');
    expect(offerFileName('', 'https://x.example/')).toBe('download');
    expect(offerFileName('D:\\dl\\ok.bin', 'https://x.example/')).toBe('ok.bin');
  });
});
