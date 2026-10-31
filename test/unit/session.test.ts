import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAcceptLanguage } from '../../src/background/session';
import type { BrowserCookie } from '../../src/lib/platform';
import { grantId, jobId, sessionId } from '../helpers/ids';
import { World } from '../harness/world';
import type { Frame } from '../harness/fake-daemon';

const ORIGIN = 'https://portal.example.org';
const URL_ = `${ORIGIN}/download/8841`;
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

describe('session.request: strict browser oracle', () => {
  it('rejects legacy export even with consent and never reads or sends cookies', async () => {
    const w = await ready();
    w.ext.jar = [cookie()];
    const reply = await ask(w, requestBody());
    expect(reply.type).toBe('session.response');
    expect(reply.body).toMatchObject({
      status: 'denied',
      error: { code: 'session.consent_denied' },
    });
    expect(JSON.stringify(reply)).not.toContain(CANARY);
    expect(w.ext.cookieQueries).toEqual([]);
    expect(w.ext.local.dump()).not.toContain(CANARY);
    expect(w.ext.session.dump()).not.toContain(CANARY);
    expect(w.logs()).not.toContain(CANARY);
    expect(JSON.stringify(w.daemon.frames)).not.toContain(CANARY);
  });
});

describe('formatAcceptLanguage', () => {
  it('steps q-values down like browsers do', () => {
    expect(formatAcceptLanguage(['en-US', 'en', 'bn'])).toBe('en-US,en;q=0.9,bn;q=0.8');
    expect(formatAcceptLanguage([])).toBe('');
  });
});
