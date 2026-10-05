import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { looksLikeHtmlWall, totalBytesFrom, validatorsFrom } from '../../src/background/session';
import { grantId, jobId } from '../helpers/ids';
import { World } from '../harness/world';
import type { Frame } from '../harness/fake-daemon';

const ORIGIN = 'https://portal.example.org';
const ORIGIN_URL = `${ORIGIN}/files/annual-report.pdf`;
const STALE =
  'https://cdn.example.org/blobs/annual-report.pdf?X-Amz-Expires=300&X-Amz-Signature=STALE';
const FRESH =
  'https://cdn.example.org/blobs/annual-report.pdf?X-Amz-Expires=300&X-Amz-Signature=FRESH-EXAMPLE';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function ready(): Promise<World> {
  const w = await new World().boot();
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

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: jobId(1),
    origin: ORIGIN,
    origin_url: ORIGIN_URL,
    stale_url: STALE,
    reason: 'url_expired',
    methods: ['refetch', 'download_api'],
    expected: { total_bytes: 734_003_200, etag: '"a81c-77e2"', filename: 'annual-report.pdf' },
    deadline_ms: 25_000,
    ...over,
  };
}

async function ask(w: World, b: Record<string, unknown>, wait = 2): Promise<Frame> {
  const id = w.daemon.send('url.refresh.request', b);
  await w.settle(wait);
  const reply = w.daemon.frames.find((f) => f.re === id);
  if (!reply) throw new Error('no reply');
  return reply;
}

describe('refetch (spec 02 section 8.2)', () => {
  it('derives the fresh URL, validators and size from a ranged credentialed fetch', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      url: FRESH,
      redirected: true,
      headers: {
        'content-range': 'bytes 0-0/734003200',
        etag: '"a81c-77e2"',
        'last-modified': 'Tue, 29 Sep 2026 14:02:11 GMT',
        date: 'Mon, 05 Oct 2026 09:15:36 GMT',
        'content-type': 'application/pdf',
      },
      body: [new Uint8Array([37])],
    });
    const reply = await ask(w, body());
    expect(reply.type).toBe('url.refresh.response');
    expect(reply.body).toEqual({
      status: 'refreshed',
      url: ORIGIN_URL,
      final_url: FRESH,
      method: 'refetch',
      validators: {
        etag: '"a81c-77e2"',
        last_modified: 'Tue, 29 Sep 2026 14:02:11 GMT',
        last_modified_strong: true,
        repr_digest: null,
      },
      total_bytes: 734_003_200,
    });
    expect(w.fetcher.requests[0]).toMatchObject({
      url: ORIGIN_URL,
      headers: { Range: 'bytes=0-0' },
    });
    expect(w.fetcher.requests[0]?.init).toMatchObject({
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    });
    expect(w.fetcher.cancelledBodies).toBe(1); // the body is aborted, never read
    expect(w.daemon.violations).toEqual([]);
  });

  it('answers unchanged when the browser obtained the same URL (expiry was not the cause)', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 206,
      url: STALE,
      headers: { 'content-range': 'bytes 0-0/10' },
      body: [],
    });
    const reply = await ask(w, body());
    expect(reply.body).toEqual({ status: 'unchanged' });
  });

  it('answers url.login_required for a 401 and for an HTML wall instead of the file', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 401 });
    expect((await ask(w, body({ methods: ['refetch'] }))).body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'url.login_required', class: 'auth_expired' },
    });
    w.fetcher.respondWith({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: [new TextEncoder().encode('<html>sign in</html>')],
    });
    expect((await ask(w, body({ methods: ['refetch'] }))).body).toMatchObject({
      error: { code: 'url.login_required' },
    });
  });

  it('does not mistake an HTML file for a login wall when an HTML file is expected', async () => {
    const w = await ready();
    w.fetcher.respondWith({
      status: 200,
      url: FRESH,
      headers: { 'content-type': 'text/html' },
      body: [],
    });
    const reply = await ask(
      w,
      body({ methods: ['refetch'], expected: { filename: 'index.html' } }),
    );
    expect(reply.body).toMatchObject({ status: 'refreshed', method: 'refetch' });
  });

  it('answers url.refresh_failed with the status for other errors', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 403 });
    const reply = await ask(w, body({ methods: ['refetch'] }));
    expect(reply.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'url.refresh_failed', details: { status: 403 } },
    });
  });

  it('refuses a redirect to an origin with cookies and no consent', async () => {
    const w = await ready();
    w.ext.grant('https://cdn.example.org');
    w.ext.jar = [
      {
        name: 'c',
        value: 'v',
        domain: 'cdn.example.org',
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
      status: 206,
      url: FRESH,
      redirected: true,
      headers: { 'content-range': 'bytes 0-0/10' },
    });
    const reply = await ask(w, body());
    expect(reply.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'fetch.cross_origin_denied', class: 'policy_denied' },
    });
    expect(w.ext.downloadCalls).toHaveLength(0); // no fallback after a policy refusal
  });

  it('gives up with url.refresh_failed when the fetch times out', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 206, delayMs: 60_000, url: FRESH });
    const id = w.daemon.send(
      'url.refresh.request',
      body({ methods: ['refetch'], deadline_ms: 5_000 }),
    );
    await w.advance(5_500);
    const reply = w.daemon.frames.find((f) => f.re === id);
    expect(reply?.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'url.refresh_failed' },
    });
  });
});

describe('consent gate for refreshes', () => {
  it('answers session.consent_required without any network access', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    const reply = await ask(w, body());
    expect(reply.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'session.consent_required' },
    });
    expect(w.fetcher.requests).toHaveLength(0);
    expect(w.ext.downloadCalls).toHaveLength(0);
  });

  it('answers session.origin_mismatch when the URL is not on the origin', async () => {
    const w = await ready();
    const reply = await ask(w, body({ origin_url: 'https://evil.example/x' }));
    expect(reply.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'session.origin_mismatch' },
    });
    expect(w.fetcher.requests).toHaveLength(0);
  });
});

describe('download_api (spec 02 section 8.2)', () => {
  it('starts a browser download, reads its final URL, then cancels, erases and removes it', async () => {
    const w = await ready();
    w.ext.onDownloadCreatedHook = (id) => {
      const it = w.ext.downloadsList.get(id);
      if (it) {
        it.finalUrl = FRESH;
        it.totalBytes = 734_003_200;
        it.mime = 'application/pdf';
      }
    };
    const reply = await ask(w, body({ methods: ['download_api'] }), 4);
    expect(reply.body).toMatchObject({
      status: 'refreshed',
      url: ORIGIN_URL,
      final_url: FRESH,
      method: 'download_api',
      total_bytes: 734_003_200,
    });
    expect(w.ext.downloadCalls).toEqual([{ url: ORIGIN_URL, saveAs: false }]);
    const id = w.ext.canceled[0];
    expect(id).toBeDefined();
    expect(w.ext.erased).toContain(id);
    expect(w.ext.removedFiles).toContain(id);
    // the rescue watcher must not offer this internal download
    w.ext.onDownloadChanged.emit({
      id: id as number,
      state: { previous: 'in_progress', current: 'interrupted' },
      error: { current: 'USER_CANCELED' },
    });
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(0);
    expect(w.daemon.violations).toEqual([]);
  });

  it('is the fallback when refetch meets an HTML wall', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 200, headers: { 'content-type': 'text/html' }, body: [] });
    w.ext.onDownloadCreatedHook = (id) => {
      const it = w.ext.downloadsList.get(id);
      if (it) {
        it.finalUrl = FRESH;
        it.mime = 'application/pdf';
      }
    };
    const reply = await ask(w, body(), 4);
    expect(reply.body).toMatchObject({
      status: 'refreshed',
      method: 'download_api',
      final_url: FRESH,
    });
    expect(w.fetcher.requests).toHaveLength(1);
  });

  it('reports login_required when the browser itself is unauthorised, even if a later method fails otherwise', async () => {
    const w = await ready();
    w.fetcher.respondWith({ status: 401 });
    w.ext.onDownloadCreatedHook = (id) => {
      const it = w.ext.downloadsList.get(id);
      if (it) {
        it.state = 'interrupted';
        it.error = 'SERVER_FORBIDDEN';
        it.finalUrl = '';
      }
    };
    const reply = await ask(w, body(), 4);
    expect(reply.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'url.login_required' },
    });
  });

  it('times out when the browser never reports a final URL', async () => {
    const w = await ready();
    w.ext.onDownloadCreatedHook = (id) => {
      const it = w.ext.downloadsList.get(id);
      if (it) {
        it.finalUrl = '';
        it.bytesReceived = 0;
      }
    };
    const id = w.daemon.send(
      'url.refresh.request',
      body({ methods: ['download_api'], deadline_ms: 3_000 }),
    );
    await w.advance(4_000);
    const reply = w.daemon.frames.find((f) => f.re === id);
    expect(reply?.body).toMatchObject({
      status: 'cannot_refresh',
      error: { code: 'url.refresh_failed' },
    });
    expect(w.ext.canceled).toHaveLength(1); // cleanup still ran
  });
});

describe('helpers', () => {
  it('recognises HTML walls', () => {
    expect(looksLikeHtmlWall('text/html; charset=utf-8', 'file.pdf')).toBe(true);
    expect(looksLikeHtmlWall('application/xhtml+xml', undefined)).toBe(true);
    expect(looksLikeHtmlWall('text/html', 'page.html')).toBe(false);
    expect(looksLikeHtmlWall('application/pdf', 'file.pdf')).toBe(false);
    expect(looksLikeHtmlWall(null, 'file.pdf')).toBe(false);
  });

  it('derives validators, strong Last-Modified and the total size', () => {
    const h = new Headers({
      etag: 'W/"x"',
      'last-modified': 'Mon, 05 Oct 2026 09:15:36 GMT',
      date: 'Mon, 05 Oct 2026 09:15:36 GMT',
      'content-range': 'bytes 0-0/99',
    });
    expect(validatorsFrom(h)).toEqual({
      etag: 'W/"x"',
      last_modified: 'Mon, 05 Oct 2026 09:15:36 GMT',
      last_modified_strong: false,
      repr_digest: null,
    });
    expect(totalBytesFrom(206, h)).toBe(99);
    expect(totalBytesFrom(200, new Headers({ 'content-length': '12' }))).toBe(12);
    expect(totalBytesFrom(206, new Headers())).toBeNull();
  });
});
