import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkAssembler, planBody } from '../../src/background/fetchProxy';
import { grantId, jobId } from '../helpers/ids';
import { World } from '../harness/world';
import type { Frame } from '../harness/fake-daemon';
import { pattern, splitPieces } from '../harness/fake-fetch';

const ORIGIN = 'https://portal.example.org';
const URL_ = `${ORIGIN}/download/9120`;
const OFFSET = 402_653_184;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function ready(opts: ConstructorParameters<typeof World>[0] = {}): Promise<World> {
  const w = await new World(opts).boot();
  w.ext.grant(ORIGIN);
  await w.bg.store.putConsent({
    grant_id: grantId(1),
    origin: ORIGIN,
    scope: 'site',
    expires_at_ms: w.clock.now() + 24 * 3600 * 1000,
    source: 'ui',
  });
  return w;
}

function range(over: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    stream_id: 's1',
    job_id: jobId(1),
    url: URL_,
    origin: ORIGIN,
    range: { offset: OFFSET, length: 1_000_000 },
    if_range: '"5f3a9c-4c1d2e7b"',
    request_headers: { accept: '*/*' },
    chunk_bytes: 262_144,
    credits: 8,
    deadline_ms: 25_000,
    ...over,
  };
  // JSON has no undefined: drop keys the test unset
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

const ok206 = (offset: number, length: number, extra: Record<string, string> = {}) => ({
  status: 206,
  headers: {
    'content-range': `bytes ${offset}-${offset + length - 1}/1288490188`,
    'content-length': String(length),
    etag: '"5f3a9c-4c1d2e7b"',
    'accept-ranges': 'bytes',
    'content-type': 'application/zstd',
    'set-cookie': 'leak=1',
    'x-internal': 'nope',
    ...extra,
  },
  body: splitPieces(pattern(offset, length), 100_000),
});

const framesOf = (w: World, type: string, streamId = 's1'): Frame[] =>
  w.daemon.sent(type).filter((f) => f.body.stream_id === streamId);

const decode = (f: Frame): Buffer => Buffer.from(f.body.data as string, 'base64');

async function run(w: World, rounds = 30): Promise<void> {
  await w.settle(rounds);
}

describe('fetch.range happy path (spec 02 section 9)', () => {
  it('streams contiguous, correctly labelled chunks and ends with the counts', async () => {
    const w = await ready();
    w.fetcher.respondWith(ok206(OFFSET, 1_000_000));
    const rangeId = w.daemon.send('fetch.range', range());
    await run(w);

    // the request the browser made
    const req = w.fetcher.requests[0];
    expect(req?.url).toBe(URL_);
    expect(req?.init).toMatchObject({
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
    });
    expect(req?.headers).toEqual({
      Range: `bytes=${OFFSET}-${OFFSET + 999_999}`,
      'If-Range': '"5f3a9c-4c1d2e7b"',
      Accept: '*/*',
    });

    const head = framesOf(w, 'fetch.head')[0];
    expect(head?.re).toBe(rangeId);
    expect(head?.body).toMatchObject({ status: 206, final_url: URL_, redirected: false });
    // only allow-listed, lower-case response headers; Set-Cookie and unknown headers never leave
    expect(Object.keys(head?.body.headers as object).sort()).toEqual([
      'accept-ranges',
      'content-length',
      'content-range',
      'content-type',
      'etag',
    ]);

    const chunks = framesOf(w, 'fetch.chunk');
    expect(chunks.map((c) => c.body.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.body.length)).toEqual([262_144, 262_144, 262_144, 213_568]);
    expect(chunks.map((c) => c.body.offset)).toEqual([
      OFFSET,
      OFFSET + 262_144,
      OFFSET + 524_288,
      OFFSET + 786_432,
    ]);
    const all = Buffer.concat(chunks.map(decode));
    expect(all.equals(Buffer.from(pattern(OFFSET, 1_000_000)))).toBe(true);
    for (const c of chunks) expect(decode(c).length).toBe(c.body.length);

    const end = framesOf(w, 'fetch.end')[0];
    expect(end?.body).toMatchObject({ reason: 'complete', chunks: 4, bytes: 1_000_000 });
    expect(w.daemon.violations).toEqual([]);
  });

  it('fetches the whole resource when the range is null and labels offsets from zero', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 200,
      headers: { 'content-length': '300000' },
      body: splitPieces(pattern(0, 300_000), 70_000),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: null, if_range: undefined, chunk_bytes: 131_072, credits: 4 }),
    );
    await run(w);
    expect(w.fetcher.requests[0]?.headers).toEqual({ Accept: '*/*' });
    const chunks = framesOf(w, 'fetch.chunk');
    expect(chunks.map((c) => c.body.offset)).toEqual([0, 131_072, 262_144]);
    expect(Buffer.concat(chunks.map(decode)).equals(Buffer.from(pattern(0, 300_000)))).toBe(true);
  });

  it('stays below the daemon-bound frame limit at the maximum chunk size', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 206, headers: {}, body: [pattern(OFFSET, 2_097_152)] });
    w.daemon.send(
      'fetch.range',
      range({ chunk_bytes: 2_097_152, range: { offset: OFFSET, length: 2_097_152 }, credits: 1 }),
    );
    await run(w);
    const chunk = framesOf(w, 'fetch.chunk')[0];
    expect(chunk).toBeDefined();
    expect(JSON.stringify(chunk).length).toBeLessThan(4_194_304);
    expect((chunk?.body.data as string).length).toBe(2_796_204);
    expect(w.daemon.violations).toEqual([]);
  });

  it('refuses redirect chains before the browser can attach cookies to another origin', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      ...ok206(OFFSET, 1000),
      url: 'https://cdn.example.net/blob?sig=abc',
      redirected: true,
    });
    w.daemon.send('fetch.range', range({ range: { offset: OFFSET, length: 1000 } }));
    await run(w);
    expect(w.fetcher.requests[0]?.init.redirect).toBe('error');
    expect(framesOf(w, 'fetch.head')).toHaveLength(0);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(0);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'fetch.network_error' },
    });
  });
});

describe('credit-based flow control (spec 02 section 9.5)', () => {
  it('sends no chunk without a credit and resumes when credits arrive', async () => {
    const w = await ready();
    const total = 6 * 65_536;
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, total), 65_536),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: total }, chunk_bytes: 65_536, credits: 2 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(2);
    expect(framesOf(w, 'fetch.end')).toHaveLength(0);
    w.daemon.send('fetch.credit', { stream_id: 's1', credits: 3 });
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(5);
    w.daemon.send('fetch.credit', { stream_id: 's1', credits: 1 });
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(6);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({
      reason: 'complete',
      chunks: 6,
      bytes: total,
    });
    expect(w.daemon.violations).toEqual([]);
  });

  it('stops reading the body while out of credits (backpressure)', async () => {
    const w = await ready();
    const total = 40 * 4096;
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, total), 4096),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: total }, chunk_bytes: 4096, credits: 1 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(1);
    // one chunk was sent, one is held waiting for credit; the stream's internal queue adds at most a piece or two
    expect(w.fetcher.piecesPulled).toBeLessThanOrEqual(4);
    // finish with plenty of credit and verify nothing was lost or duplicated
    w.daemon.send('fetch.credit', { stream_id: 's1', credits: 32 });
    await run(w);
    w.daemon.send('fetch.credit', { stream_id: 's1', credits: 32 });
    await run(w);
    const data = Buffer.concat(framesOf(w, 'fetch.chunk').map(decode));
    expect(data.equals(Buffer.from(pattern(OFFSET, total)))).toBe(true);
    expect(w.fetcher.piecesPulled).toBe(40);
  });

  it('aborts with fetch.aborted when the daemon never grants credit again', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, 4 * 4096), 4096),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 4 * 4096 }, chunk_bytes: 4096, credits: 1 }),
    );
    await run(w);
    await w.advance(91_000);
    const err = framesOf(w, 'fetch.error')[0];
    expect(err?.body).toMatchObject({
      error: { code: 'fetch.aborted', class: 'transient_network' },
      bytes: 4096,
    });
    expect(err?.re).toBeUndefined(); // after the head, no re
  });
});

describe('what the extension refuses to stream', () => {
  it('holds a non-success response, sends only the head, and answers the cancel with fetch.end', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 403,
      headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
      body: [new TextEncoder().encode('<html>Just a moment</html>')],
    });
    w.daemon.send('fetch.range', range());
    await run(w);
    const head = framesOf(w, 'fetch.head')[0];
    expect(head?.body).toMatchObject({ status: 403 });
    expect((head?.body.headers as Record<string, string>)['cf-mitigated']).toBe('challenge');
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(0);
    expect(w.fetcher.cancelledBodies).toBe(1);
    w.daemon.send('fetch.cancel', { stream_id: 's1', reason: 'superseded' });
    await run(w);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({
      reason: 'canceled',
      chunks: 0,
      bytes: 0,
    });
    expect(w.bg.fetchProxy.openCount()).toBe(0);
  });

  it('ends a held stream by itself if the daemon never cancels', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 404, body: [] });
    w.daemon.send('fetch.range', range());
    await run(w);
    expect(w.bg.fetchProxy.openCount()).toBe(1);
    await w.advance(10_500);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({ reason: 'canceled' });
    expect(w.bg.fetchProxy.openCount()).toBe(0);
  });

  it('holds a 200 to a ranged request that starts later: its bytes would carry wrong offsets', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 200, headers: {}, body: [pattern(0, 5000)] });
    w.daemon.send('fetch.range', range());
    await run(w);
    expect(framesOf(w, 'fetch.head')[0]?.body).toMatchObject({ status: 200 });
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(0);
  });

  it('streams a full 200 at offset zero so the daemon can switch to sequential transfer', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 200,
      headers: {},
      body: splitPieces(pattern(0, 50_000), 7000),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: 0, length: 20_000 }, chunk_bytes: 8192 }),
    );
    await run(w);
    const chunks = framesOf(w, 'fetch.chunk');
    expect(chunks.map((c) => c.body.length)).toEqual([8192, 8192, 8192, 8192, 8192, 8192, 848]);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({ reason: 'complete', bytes: 50_000 });
  });

  it('never sends more bytes than the requested range even if the server overruns', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, 100_000), 9000),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 30_000 }, chunk_bytes: 16_384 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({ reason: 'complete', bytes: 30_000 });
  });

  it('rejects a content-encoded response (byte ranges would not be exact)', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 200,
      headers: { 'content-encoding': 'gzip' },
      body: [pattern(0, 10)],
    });
    const id = w.daemon.send('fetch.range', range());
    await run(w);
    const err = framesOf(w, 'fetch.error')[0];
    expect(err?.re).toBe(id);
    expect(err?.body).toMatchObject({
      error: { code: 'fetch.content_encoded', class: 'permanent', retryable: false },
      bytes: 0,
    });
    expect(framesOf(w, 'fetch.head')).toHaveLength(0);
  });

  it('accepts an explicit identity encoding', async () => {
    const w = await ready();
    w.fetcher.respondWith({ ...ok206(OFFSET, 100), headers: { 'content-encoding': 'identity' } });
    w.daemon.send('fetch.range', range({ range: { offset: OFFSET, length: 100 } }));
    await run(w);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({ reason: 'complete' });
  });
});

describe('consent and origin checks before any network access', () => {
  it('answers fetch.error session.consent_required when no consent covers the stream', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    const id = w.daemon.send('fetch.range', range());
    await run(w);
    const err = framesOf(w, 'fetch.error')[0];
    expect(err?.re).toBe(id);
    expect(err?.body).toMatchObject({ error: { code: 'session.consent_required' }, bytes: 0 });
    expect(w.fetcher.requests).toHaveLength(0);
    expect(w.daemon.violations).toEqual([]);
  });

  it('answers session.origin_mismatch when the URL is not on the named origin', async () => {
    const w = await ready();
    w.daemon.send('fetch.range', range({ url: 'https://evil.example/file' }));
    await run(w);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'session.origin_mismatch' },
    });
    expect(w.fetcher.requests).toHaveLength(0);
  });

  it('refuses a redirect to an origin where the browser has cookies and the human gave no consent', async () => {
    const w = await ready();
    w.ext.grant('https://cdn.example.net');
    w.ext.jar = [
      {
        name: 'k',
        value: 'v',
        domain: 'cdn.example.net',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        hostOnly: true,
        session: true,
        storeId: '0',
      },
    ];
    w.fetcher.respondWith({
      ...ok206(OFFSET, 1000),
      url: 'https://cdn.example.net/blob',
      redirected: true,
    });
    w.daemon.send('fetch.range', range({ range: { offset: OFFSET, length: 1000 } }));
    await run(w);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'fetch.network_error', class: 'transient_network' },
    });
    expect(framesOf(w, 'fetch.head')).toHaveLength(0);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(0);
    expect(w.fetcher.piecesPulled).toBe(0); // redirect rejected before any response body is exposed
  });

  it('stops a running stream when its consent is revoked', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, 10 * 4096), 4096),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 10 * 4096 }, chunk_bytes: 4096, credits: 2 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(2);
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 500,
        ts: '2026-10-05T10:00:00.000Z',
        type: 'grant.revoked',
        data: {
          grant_id: grantId(1),
          origin: ORIGIN,
          by: { kind: 'human', surface: 'extension_popup' },
        },
      },
    });
    await run(w);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'session.consent_required' },
      bytes: 8192,
    });
    expect(w.bg.fetchProxy.openCount()).toBe(0);
  });

  it('stops a running stream when the browser permission is removed', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, 10 * 4096), 4096),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 10 * 4096 }, chunk_bytes: 4096, credits: 1 }),
    );
    await run(w);
    w.ext.onPermissionsRemoved.emit({ origins: [`${ORIGIN}/*`] });
    await run(w);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'session.consent_required' },
    });
  });
});

describe('failures', () => {
  it('maps a rejected fetch() to fetch.network_error', async () => {
    const w = await ready();
    w.fetcher.respondWith({ fail: new TypeError('Failed to fetch') });
    const id = w.daemon.send('fetch.range', range());
    await run(w);
    const err = framesOf(w, 'fetch.error')[0];
    expect(err?.re).toBe(id);
    expect(err?.body).toMatchObject({
      error: { code: 'fetch.network_error', class: 'transient_network', retryable: true },
      bytes: 0,
    });
  });

  it('maps a missed header deadline to fetch.timeout, aborting at min(deadline, 25 s)', async () => {
    const w = await ready();
    w.fetcher.respondWith({ ...ok206(OFFSET, 100), delayMs: 120_000 });
    w.daemon.send('fetch.range', range({ deadline_ms: 60_000 }));
    await w.advance(24_000);
    expect(framesOf(w, 'fetch.error')).toHaveLength(0);
    await w.advance(1_500);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({ error: { code: 'fetch.timeout' } });
  });

  it('maps a mid-body failure to fetch.body_error with the bytes already sent', async () => {
    const w = await ready();
    let n = 0;
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: [pattern(OFFSET, 8192), pattern(OFFSET + 8192, 8192)],
    });
    const original = w.env.fetch;
    w.env.fetch = async (...args) => {
      const res = await original(...args);
      const reader = res.body?.getReader();
      const failing = new ReadableStream<Uint8Array>({
        async pull(c) {
          n += 1;
          if (n === 3 || !reader) {
            c.error(new TypeError('network error'));
            return;
          }
          const r = await reader.read();
          if (r.done) c.close();
          else c.enqueue(r.value);
          return undefined;
        },
      });
      return Object.defineProperty(new Response(failing, { status: 206 }), 'url', {
        value: res.url,
      });
    };
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 100_000 }, chunk_bytes: 8192 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'fetch.body_error' },
      bytes: 16_384,
    });
  });

  it('aborts a stalled body after 25 s', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 206, headers: {}, body: [pattern(OFFSET, 4096)], hang: true });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 100_000 }, chunk_bytes: 4096 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(1);
    await w.advance(26_000);
    expect(framesOf(w, 'fetch.error')[0]?.body).toMatchObject({
      error: { code: 'fetch.body_error' },
      bytes: 4096,
    });
  });
});

describe('cancel and lifecycle (spec 02 section 9.6)', () => {
  it('aborts the fetch, stops sending and answers fetch.end canceled', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, 20 * 4096), 4096),
      hang: true,
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 20 * 4096 }, chunk_bytes: 4096, credits: 3 }),
    );
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(3);
    w.daemon.send('fetch.cancel', { stream_id: 's1', reason: 'job_paused' });
    await run(w);
    const end = framesOf(w, 'fetch.end');
    expect(end).toHaveLength(1);
    expect(end[0]?.body).toMatchObject({ reason: 'canceled', chunks: 3, bytes: 12_288 });
    expect(framesOf(w, 'fetch.error')).toHaveLength(0);
    expect(w.fetcher.requests[0]?.init.signal?.aborted).toBe(true);
    w.daemon.send('fetch.credit', { stream_id: 's1', credits: 5 }); // late credit for a closed stream: ignored
    await run(w);
    expect(framesOf(w, 'fetch.chunk')).toHaveLength(3);
  });

  it('cancels a stream whose request is still in flight', async () => {
    const w = await ready();
    w.fetcher.respondWith({ ...ok206(OFFSET, 100), delayMs: 20_000 });
    w.daemon.send('fetch.range', range());
    await run(w, 4);
    w.daemon.send('fetch.cancel', { stream_id: 's1', reason: 'job_canceled' });
    await run(w);
    expect(framesOf(w, 'fetch.end')[0]?.body).toMatchObject({ reason: 'canceled' });
  });

  it('frees the stream id after the end so it can be reused', async () => {
    const w = await ready();
    w.fetcher.respondWith({ ...ok206(OFFSET, 100) });
    w.daemon.send('fetch.range', range({ range: { offset: OFFSET, length: 100 } }));
    await run(w);
    w.daemon.send('fetch.range', range({ range: { offset: OFFSET, length: 100 } }));
    await run(w);
    expect(framesOf(w, 'fetch.end')).toHaveLength(2);
  });

  it('enforces the concurrent stream limit and rejects duplicate ids', async () => {
    const w = await ready({ daemon: { limits: { max_concurrent_streams: 1 } } });
    w.fetcher.respondWith({ ...ok206(OFFSET, 100), hang: true, delayMs: 5000 });
    w.daemon.send('fetch.range', range());
    await run(w, 4);
    const second = w.daemon.send('fetch.range', range({ stream_id: 's2' }));
    const dup = w.daemon.send('fetch.range', range({ stream_id: 's1' }));
    await run(w, 4);
    const errors = w.daemon.sent('error');
    expect(errors.find((e) => e.re === second)?.body).toMatchObject({
      error: { code: 'nm.too_many_streams', class: 'unavailable' },
    });
    expect(errors.find((e) => e.re === dup)?.body).toMatchObject({
      error: { code: 'nm.duplicate_id' },
    });
  });

  it('refuses a range larger than the negotiated max_range_bytes', async () => {
    const w = await ready({ daemon: { limits: { max_range_bytes: 1_048_576 } } });
    const id = w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 1_048_577 } }),
    );
    await run(w, 4);
    expect(w.daemon.sent('error').find((e) => e.re === id)?.body).toMatchObject({
      error: { code: 'nm.schema_violation' },
    });
    expect(w.fetcher.requests).toHaveLength(0);
  });

  it('drops every stream when the connection closes, sending nothing more', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(OFFSET, 10 * 4096), 4096),
    });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 10 * 4096 }, chunk_bytes: 4096, credits: 2 }),
    );
    await run(w);
    const daemon = w.daemon;
    const before = daemon.frames.length;
    w.ext.lastNativePort().hostDisconnect('Native host has exited.');
    await w.settle(3);
    expect(w.bg.fetchProxy.openCount()).toBe(0);
    expect(w.fetcher.requests[0]?.init.signal?.aborted).toBe(true);
    expect(daemon.frames.length).toBe(before);
  });

  it('keeps the connection open while a stream is active', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 206, headers: {}, body: [pattern(OFFSET, 4096)], hang: true });
    w.daemon.send(
      'fetch.range',
      range({ range: { offset: OFFSET, length: 100_000 }, chunk_bytes: 4096 }),
    );
    await run(w);
    await w.advance(120_000);
    expect(w.bg.link.isReady()).toBe(true);
    expect(w.ext.nativePorts).toHaveLength(1);
  });
});

describe('planBody', () => {
  it('streams 206, holds everything unsafe', () => {
    expect(planBody(206, { offset: 5, length: 10 })).toEqual({ mode: 'stream', limit: 10 });
    expect(planBody(206, null)).toEqual({ mode: 'stream', limit: null });
    expect(planBody(200, null)).toEqual({ mode: 'stream', limit: null });
    expect(planBody(200, { offset: 0, length: 10 })).toEqual({ mode: 'stream', limit: null });
    expect(planBody(200, { offset: 1, length: 10 })).toEqual({ mode: 'hold' });
    for (const s of [204, 301, 403, 404, 416, 429, 500, 503])
      expect(planBody(s, null)).toEqual({ mode: 'hold' });
  });
});

describe('ChunkAssembler (property)', () => {
  it('re-chunks any split of the input into exact-size chunks', () => {
    let seed = 12345;
    const rand = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let trial = 0; trial < 200; trial++) {
      const size = 1 + rand(64);
      const data = pattern(trial, rand(400));
      const a = new ChunkAssembler(size);
      const out: Uint8Array[] = [];
      let pos = 0;
      while (pos < data.length) {
        const take = 1 + rand(97);
        out.push(...a.push(data.subarray(pos, pos + take)));
        pos += take;
      }
      const rest = a.flush();
      for (const c of out) expect(c.length).toBe(size);
      if (rest) {
        expect(rest.length).toBeGreaterThan(0);
        expect(rest.length).toBeLessThan(size);
        out.push(rest);
      }
      expect(Buffer.concat(out).equals(Buffer.from(data))).toBe(true);
    }
  });
});
