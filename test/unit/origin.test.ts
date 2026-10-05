import { describe, expect, it } from 'vitest';
import { hostPattern, isEligibleUrl, isReleasableOrigin, originOf } from '../../src/lib/origin';

describe('originOf', () => {
  it('normalises like the WHATWG URL parser', () => {
    expect(originOf('HTTPS://Portal.Example.org:443/a?b#c')).toBe('https://portal.example.org');
    expect(originOf('http://localhost:8080/x')).toBe('http://localhost:8080');
    expect(originOf('https://[::1]:8443/x')).toBe('https://[::1]:8443');
    expect(originOf('https://bücher.example/x')).toBe('https://xn--bcher-kva.example');
  });
  it('rejects non-http(s) and garbage', () => {
    for (const u of [
      'ftp://a/b',
      'blob:https://a/1',
      'data:text/plain,x',
      'file:///c:/a',
      'nope',
      '',
    ]) {
      expect(originOf(u)).toBeNull();
    }
  });
});

describe('isReleasableOrigin (spec 01 section 4 rule 3)', () => {
  it('allows https and loopback http only', () => {
    expect(isReleasableOrigin('https://example.com')).toBe(true);
    expect(isReleasableOrigin('http://localhost:3000')).toBe(true);
    expect(isReleasableOrigin('http://127.0.0.1')).toBe(true);
    expect(isReleasableOrigin('http://[::1]:9')).toBe(true);
    expect(isReleasableOrigin('http://example.com')).toBe(false);
    expect(isReleasableOrigin('http://localhost.evil.example')).toBe(false);
  });
});

describe('url helpers', () => {
  it('limits URL length and builds match patterns', () => {
    expect(isEligibleUrl('https://a.example/' + 'x'.repeat(9000))).toBe(false);
    expect(isEligibleUrl('https://a.example/ok')).toBe(true);
    expect(hostPattern('https://a.example')).toBe('https://a.example/*');
  });
});
