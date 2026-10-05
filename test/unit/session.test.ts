import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAcceptLanguage } from '../../src/background/session';
import type { BrowserCookie } from '../../src/lib/platform';
import { grantId, jobId, sessionId } from '../helpers/ids';
import { World } from '../harness/world';
import type { Frame } from '../harness/fake-daemon';

const ORIGIN = 'https://portal.example.org';
const URL_ = `${ORIGIN}/download/8841`;
interface WireCookie {
  name: string;
  [key: string]: unknown;
}

type WireSession = Record<string, unknown> & {
  cookies: WireCookie[];
  headers: Record<string, string>;
  user_agent: string;
};

const CANARY = 'ZEUS-CANARY-cookie-value-1f9a';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function cookie(over: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: 'portal_session',
    value: CANARY,
    domain: 'portal.example.org',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    hostOnly: true,
    session: true,
    storeId: '0',
    ...over,
  };
}

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

function requestBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: jobId(1),
    session_id: sessionId(1),
    grant_id: grantId(1),
    origin: ORIGIN,
    url: URL_,
    purpose: 'download',
    request_headers: ['accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'],
    ttl_ms: 900_000,
    incognito: false,
    ...over,
  };
}

async function ask(w: World, body: Record<string, unknown>): Promise<Frame> {
  const id = w.daemon.send('session.request', body);
  await w.settle();
  const reply = w.daemon.frames.find((f) => f.re === id);
  if (!reply) throw new Error('no reply to session.request');
  return reply;
}

describe('session.request: granted', () => {
  it('releases the cookies the browser would send for the URL, with UA and client hints', async () => {
    const w = await ready();
    w.ext.jar = [
      cookie(),
      cookie({
        name: 'csrf',
        value: 'csrf-value',
        domain: '.example.org',
        path: '/download',
        hostOnly: false,
        session: false,
        expirationDate: 1_791_277_200,
        sameSite: 'strict',
        httpOnly: false,
      }),
      cookie({ name: 'other', domain: 'unrelated.example', value: 'not-for-us' }),
    ];
    const reply = await ask(w, requestBody());
    expect(reply.type).toBe('session.response');
    const body = reply.body as {
      status: string;
      session: WireSession;
    };
    expect(body.status).toBe('granted');
    const s = body.session;
    expect(s.session_id).toBe(sessionId(1));
    expect(s.origin).toBe(ORIGIN);
    expect(s.issued_at).toMatch(/^2026-10-05T09:\d\d:\d\d\.\d{3}Z$/);
    expect(s.ttl_ms).toBe(900_000);
    expect(s.user_agent).toContain('Chrome/141');
    expect(s.headers).toEqual({
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="8"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });
    // most specific path first, like browsers send them
    expect(s.cookies.map((c) => c.name)).toEqual(['csrf', 'portal_session']);
    expect(s.cookies[0]).toEqual({
      name: 'csrf',
      value: 'csrf-value',
      domain: '.example.org',
      path: '/download',
      secure: true,
      http_only: false,
      same_site: 'strict',
      host_only: false,
      expires_at: '2026-10-06T09:00:00.000Z',
    });
    expect(s.cookies[1]?.expires_at).toBeNull();
    expect(w.daemon.violations).toEqual([]);
    expect(w.ext.cookieQueries[0]).toEqual({ url: URL_, storeId: undefined });
  });

  it('shortens the lifetime to the remaining consent time', async () => {
    const w = await ready();
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 90_000,
      source: 'ui',
    });
    const reply = await ask(w, requestBody());
    expect((reply.body as { session: { ttl_ms: number } }).session.ttl_ms).toBe(90_000);
  });

  it('includes partitioned (CHIPS) cookies and de-duplicates', async () => {
    const w = await ready();
    w.ext.jar = [
      cookie(),
      cookie({ name: 'chips', value: 'p', partitionKey: { topLevelSite: ORIGIN } }),
    ];
    const reply = await ask(w, requestBody());
    const names = (
      reply.body as { session: { cookies: { name: string; partition_key?: object }[] } }
    ).session.cookies;
    expect(names.map((c) => c.name).sort()).toEqual(['chips', 'portal_session']);
    expect(names.find((c) => c.name === 'chips')?.partition_key).toEqual({
      top_level_site: ORIGIN,
    });
    expect(w.daemon.violations).toEqual([]);
  });

  it('truncates to the negotiated cookie count and drops cookies that violate the limits', async () => {
    const w = await ready({ daemon: { limits: { max_cookie_count: 3 } } });
    w.ext.jar = [
      cookie({ name: 'a', path: '/' }),
      cookie({ name: 'b', path: '/download' }),
      cookie({ name: 'c', path: '/download/8841' }),
      cookie({ name: 'd', path: '/' }),
      cookie({ name: 'huge', value: 'x'.repeat(9000) }),
    ];
    const reply = await ask(w, requestBody());
    const cookies = (reply.body as { session: { cookies: { name: string }[] } }).session.cookies;
    expect(cookies.map((c) => c.name)).toEqual(['c', 'b', 'a']);
  });

  it('omits client hints the browser cannot produce (Firefox)', async () => {
    const w = await ready({
      ext: {
        isFirefox: true,
        userAgentData: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0',
      },
    });
    w.ext.jar = [cookie()];
    const reply = await ask(w, requestBody());
    const s = (reply.body as { session: { headers: Record<string, string>; user_agent: string } })
      .session;
    expect(s.headers).toEqual({ 'accept-language': 'en-US,en;q=0.9' });
    expect(s.user_agent).toContain('Firefox/140.0');
  });
});

describe('session.request: refusals', () => {
  it('answers consent_required without touching the cookie store', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    w.ext.jar = [cookie()];
    const reply = await ask(w, requestBody());
    expect(reply.body).toMatchObject({
      status: 'consent_required',
      error: { code: 'session.consent_required', class: 'auth_expired', retryable: true },
    });
    expect(w.ext.cookieQueries).toEqual([]);
    expect(w.daemon.violations).toEqual([]);
  });

  it('answers denied for a never-listed origin', async () => {
    const w = await ready();
    await w.bg.store.putNever({
      origin: ORIGIN,
      grant_id: grantId(9),
      created_at_ms: w.clock.now(),
    });
    const reply = await ask(w, requestBody());
    expect(reply.body).toMatchObject({ status: 'denied', error: { code: 'policy.origin_never' } });
    expect(w.ext.cookieQueries).toEqual([]);
  });

  it('answers an origin mismatch with an error frame', async () => {
    const w = await ready();
    const reply = await ask(w, requestBody({ origin: 'https://evil.example' }));
    expect(reply.type).toBe('error');
    expect(reply.body).toMatchObject({
      error: { code: 'session.origin_mismatch', class: 'invalid_request' },
    });
    expect(w.ext.cookieQueries).toEqual([]);
  });

  it('refuses a replayed session_id', async () => {
    const w = await ready();
    w.ext.jar = [cookie()];
    expect(((await ask(w, requestBody())).body as { status: string }).status).toBe('granted');
    const replay = await ask(w, requestBody());
    expect(replay.type).toBe('error');
    expect(replay.body).toMatchObject({ error: { code: 'nm.conflict' } });
    expect(w.ext.cookieQueries).toHaveLength(2); // the two getAll calls of the first release only
  });

  it('lets the daemon retry the same session_id after a failed release', async () => {
    const w = await ready();
    w.ext.jar = [cookie()];
    w.ext.grantedPermissions.delete('cookies');
    w.ext.grantedPermissions.add('cookies');
    const original = w.ext.api.cookies.getAll;
    let calls = 0;
    w.ext.api.cookies.getAll = (d) =>
      ++calls === 1 ? Promise.reject(new Error('transient')) : original(d);
    const first = await ask(w, requestBody());
    expect(first.body).toMatchObject({
      status: 'unavailable',
      error: { code: 'session.store_unavailable' },
    });
    const second = await ask(w, requestBody());
    expect((second.body as { status: string }).status).toBe('granted');
  });
});

describe('incognito (spec 02 section 8.1)', () => {
  it('answers store_unavailable when private windows are not allowed', async () => {
    const w = await ready();
    const reply = await ask(w, requestBody({ incognito: true }));
    expect(reply.body).toMatchObject({
      status: 'unavailable',
      error: { code: 'session.store_unavailable' },
    });
    expect(w.ext.cookieQueries).toEqual([]);
  });

  it('uses the cookie store that belongs to a private tab', async () => {
    const w = await ready({ ext: { allowedIncognito: true } });
    w.ext.cookieStores = [
      { id: '0', tabIds: [1] },
      { id: '1', tabIds: [7] },
    ];
    w.ext.tabIncognito = new Map([
      [1, false],
      [7, true],
    ]);
    w.ext.jar = [
      cookie({ storeId: '1', value: 'private-value' }),
      cookie({ name: 'regular', storeId: '0' }),
    ];
    const reply = await ask(w, requestBody({ incognito: true }));
    const s = (
      reply.body as {
        session: { cookies: { name: string; value: string }[]; cookie_store_id: string };
      }
    ).session;
    expect(s.cookie_store_id).toBe('1');
    expect(s.cookies.map((c) => c.name)).toEqual(['portal_session']);
    expect(w.ext.cookieQueries.every((q) => q.storeId === '1')).toBe(true);
  });

  it('answers store_unavailable when no private tab identifies the store', async () => {
    const w = await ready({ ext: { allowedIncognito: true } });
    const reply = await ask(w, requestBody({ incognito: true }));
    expect(reply.body).toMatchObject({ status: 'unavailable' });
  });
});

describe('cookie material never leaves the response (spec 00 section 8)', () => {
  it('is not in storage, not in logs and not in any other frame', async () => {
    const w = await ready();
    w.ext.jar = [cookie()];
    const reply = await ask(w, requestBody());
    expect(JSON.stringify(reply)).toContain(CANARY); // it is in the one response that carries it
    expect(w.ext.local.dump()).not.toContain(CANARY);
    expect(w.ext.session.dump()).not.toContain(CANARY);
    expect(w.logs()).not.toContain(CANARY);
    const others = w.daemon.frames.filter((f) => f !== reply);
    expect(JSON.stringify(others)).not.toContain(CANARY);
    // the log records only counts and handles
    expect(w.logs()).toMatch(/session released .*cookie_count=1/);
  });
});

describe('formatAcceptLanguage', () => {
  it('steps q-values down like browsers do', () => {
    expect(formatAcceptLanguage(['en-US', 'en', 'bn'])).toBe('en-US,en;q=0.9,bn;q=0.8');
    expect(formatAcceptLanguage([])).toBe('');
  });
});
