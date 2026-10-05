import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  errorMessageKey,
  errorSpec,
  makeError,
  ZeusError,
} from '../../src/lib/errors';
import { createLogger, formatLine } from '../../src/lib/log';
import { MessageIds, newInstanceId, newProfileId } from '../../src/lib/ids';
import { COMMON_SCHEMA_ID, schemas } from '../../src/lib/protocol';

describe('logger redaction', () => {
  it('reduces URLs in fields and messages and clips long values', () => {
    const line = formatLine('fetched https://a.example/f?sig=ZEUS-CANARY-1', {
      url: 'https://a.example/f?X-Amz-Signature=ZEUS-CANARY-2',
      note: 'x'.repeat(500),
    });
    expect(line).not.toContain('ZEUS-CANARY');
    expect(line.length).toBeLessThan(400);
  });
  it('filters by level', () => {
    const lines: string[] = [];
    const log = createLogger((_l, line) => lines.push(line), 'warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(lines).toEqual(['[zeus] w']);
  });
});

describe('error envelopes', () => {
  it('every raised code maps to a valid envelope', () => {
    for (const code of ERROR_CODES) {
      const env = makeError(code, 'diagnostic');
      expect(schemas.validate(`${COMMON_SCHEMA_ID}#/$defs/ErrorEnvelope`, env)).toEqual([]);
      expect(env.class).toBe(errorSpec(code).class);
    }
  });
  it('scrubs URLs from messages and drops oversized details', () => {
    const env = makeError('fetch.network_error', 'Failed https://a.example/x?token=ZEUS-CANARY-3', {
      big: 'y'.repeat(9000),
    });
    expect(env.message).not.toContain('ZEUS-CANARY');
    expect(env.details).toBeUndefined();
  });
  it('wraps in a throwable and derives message keys', () => {
    const err = new ZeusError(makeError('nm.timeout', 'no answer'));
    expect(err.message).toBe('nm.timeout: no answer');
    expect(errorMessageKey('fetch.cross_origin_denied')).toBe('err_fetch_cross_origin_denied');
  });
});

describe('ids', () => {
  it('creates well-formed ids', () => {
    const rng = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i * 7);
    expect(newProfileId(rng)).toMatch(/^[0-9a-f]{32}$/);
    expect(newInstanceId(rng)).toMatch(/^[0-9a-f]{16}$/);
    const ids = new MessageIds();
    expect([ids.next(), ids.next()]).toEqual(['e1', 'e2']);
  });
});
