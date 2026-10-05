import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SESSION_TTL_MS } from '../../src/background/consent';
import { grantId, jobId, runId } from '../helpers/ids';
import { World } from '../harness/world';

const ORIGIN = 'https://portal.example.org';
const URL_ = `${ORIGIN}/download/8841`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(): Promise<World> {
  return new World({ noDaemon: true }).boot();
}

async function consent(
  w: World,
  extra: Partial<Parameters<World['bg']['store']['putConsent']>[0]> = {},
): Promise<void> {
  await w.bg.store.putConsent({
    grant_id: grantId(1),
    origin: ORIGIN,
    scope: 'site',
    expires_at_ms: w.clock.now() + 24 * 3600 * 1000,
    source: 'ui',
    ...extra,
  });
}

describe('release gate steps (spec 02 section 10.2)', () => {
  it('step 1: rejects an origin that is not the URL origin', async () => {
    const w = await setup();
    const r = await w.bg.gate.evaluate({
      kind: 'session',
      origin: 'https://evil.example',
      url: URL_,
      job_id: jobId(),
      grant_id: grantId(1),
    });
    expect(r).toMatchObject({
      ok: false,
      status: 'invalid',
      reason: 'origin_mismatch',
      error: { code: 'session.origin_mismatch' },
    });
  });

  it('step 1: never releases for plain http outside loopback', async () => {
    const w = await setup();
    const r = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: 'http://portal.example.org',
      url: 'http://portal.example.org/x',
      job_id: jobId(),
    });
    expect(r).toMatchObject({ ok: false, status: 'denied', reason: 'insecure_origin' });
    const local = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: 'http://localhost:8080',
      url: 'http://localhost:8080/x',
      job_id: jobId(),
    });
    expect(local).toMatchObject({ ok: false, status: 'consent_required' }); // allowed in principle, no consent yet
  });

  it('honours the local never list', async () => {
    const w = await setup();
    await consent(w);
    w.ext.grant(ORIGIN);
    await w.bg.store.putNever({
      origin: ORIGIN,
      grant_id: grantId(9),
      created_at_ms: w.clock.now(),
    });
    const r = await w.bg.gate.evaluate({
      kind: 'session',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
      grant_id: grantId(1),
    });
    expect(r).toMatchObject({
      ok: false,
      status: 'denied',
      error: { code: 'policy.origin_never' },
    });
  });

  it('step 2: no consent record means consent_required', async () => {
    const w = await setup();
    w.ext.grant(ORIGIN);
    const r = await w.bg.gate.evaluate({
      kind: 'session',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
      grant_id: grantId(1),
    });
    expect(r).toMatchObject({
      ok: false,
      status: 'consent_required',
      reason: 'no_consent',
      error: { code: 'session.consent_required' },
    });
  });

  it('step 2: the record must carry the named grant id', async () => {
    const w = await setup();
    await consent(w);
    w.ext.grant(ORIGIN);
    const r = await w.bg.gate.evaluate({
      kind: 'session',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
      grant_id: grantId(2),
    });
    expect(r).toMatchObject({ ok: false, reason: 'no_consent' });
  });

  it('step 3: the browser must hold the optional host permission, and cookies for sessions', async () => {
    const w = await setup();
    await consent(w);
    const noPermission = await w.bg.gate.evaluate({
      kind: 'session',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
      grant_id: grantId(1),
    });
    expect(noPermission).toMatchObject({
      ok: false,
      status: 'consent_required',
      reason: 'no_browser_permission',
    });
    w.ext.grant(ORIGIN, false); // host permission only
    const fetchOk = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
    });
    expect(fetchOk.ok).toBe(true); // a credentialed fetch does not need the cookies permission
    const sessionNo = await w.bg.gate.evaluate({
      kind: 'session',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
      grant_id: grantId(1),
    });
    expect(sessionNo).toMatchObject({ ok: false, reason: 'no_browser_permission' });
    w.ext.grant(ORIGIN, true);
    expect(
      (
        await w.bg.gate.evaluate({
          kind: 'session',
          origin: ORIGIN,
          url: URL_,
          job_id: jobId(),
          grant_id: grantId(1),
        })
      ).ok,
    ).toBe(true);
  });

  it('step 4: the lifetime is min(requested, 15 minutes, remaining consent)', async () => {
    const w = await setup();
    w.ext.grant(ORIGIN);
    await consent(w);
    const ttl = async (requested?: number) => {
      const r = await w.bg.gate.evaluate(
        { kind: 'session', origin: ORIGIN, url: URL_, job_id: jobId(), grant_id: grantId(1) },
        requested,
      );
      return r.ok ? r.ttl_ms : null;
    };
    expect(await ttl()).toBe(MAX_SESSION_TTL_MS);
    expect(await ttl(60_000)).toBe(60_000);
    expect(await ttl(10 * 3600 * 1000)).toBe(MAX_SESSION_TTL_MS);
    await consent(w, { expires_at_ms: w.clock.now() + 120_000 });
    expect(await ttl()).toBe(120_000);
    await consent(w, { expires_at_ms: w.clock.now() + 500 });
    expect(await ttl()).toBeNull();
  });

  it('an expired record no longer releases anything', async () => {
    const w = await setup();
    w.ext.grant(ORIGIN);
    await consent(w, { expires_at_ms: w.clock.now() + 1000 });
    await w.advance(2000);
    const r = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: ORIGIN,
      url: URL_,
      job_id: jobId(),
    });
    expect(r).toMatchObject({ ok: false, status: 'consent_required' });
  });
});

describe('scopes', () => {
  it('once applies to its job only', async () => {
    const w = await setup();
    w.ext.grant(ORIGIN);
    await consent(w, { scope: 'once', job_id: jobId(1) });
    expect(
      (await w.bg.gate.evaluate({ kind: 'fetch', origin: ORIGIN, url: URL_, job_id: jobId(1) })).ok,
    ).toBe(true);
    expect(
      (await w.bg.gate.evaluate({ kind: 'fetch', origin: ORIGIN, url: URL_, job_id: jobId(2) })).ok,
    ).toBe(false);
    expect(
      (
        await w.bg.gate.evaluate({
          kind: 'session',
          origin: ORIGIN,
          url: URL_,
          job_id: jobId(2),
          grant_id: grantId(1),
        })
      ).ok,
    ).toBe(false);
  });

  it('workflow applies to jobs of its run when the run is known, and by grant id otherwise', async () => {
    const w = await setup();
    w.ext.grant(ORIGIN);
    await consent(w, { scope: 'workflow', run_id: runId(1) });
    // fetch.range and url.refresh.request name no grant: the job's run decides
    expect(
      (await w.bg.gate.evaluate({ kind: 'fetch', origin: ORIGIN, url: URL_, job_id: jobId(1) })).ok,
    ).toBe(false);
    await w.bg.store.rememberJobRun(jobId(1), runId(1));
    await w.bg.store.rememberJobRun(jobId(2), runId(2));
    expect(
      (await w.bg.gate.evaluate({ kind: 'fetch', origin: ORIGIN, url: URL_, job_id: jobId(1) })).ok,
    ).toBe(true);
    expect(
      (await w.bg.gate.evaluate({ kind: 'fetch', origin: ORIGIN, url: URL_, job_id: jobId(2) })).ok,
    ).toBe(false);
    // session.request names the grant: accepted when the run is unknown, refused when it is known and different
    expect(
      (
        await w.bg.gate.evaluate({
          kind: 'session',
          origin: ORIGIN,
          url: URL_,
          job_id: jobId(3),
          grant_id: grantId(1),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await w.bg.gate.evaluate({
          kind: 'session',
          origin: ORIGIN,
          url: URL_,
          job_id: jobId(2),
          grant_id: grantId(1),
        })
      ).ok,
    ).toBe(false);
  });

  it('site covers every job of the origin but not another origin', async () => {
    const w = await setup();
    w.ext.grant(ORIGIN);
    w.ext.grant('https://other.example');
    await consent(w);
    expect(
      (await w.bg.gate.evaluate({ kind: 'fetch', origin: ORIGIN, url: URL_, job_id: jobId(7) })).ok,
    ).toBe(true);
    const other = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: 'https://other.example',
      url: 'https://other.example/f',
      job_id: jobId(7),
    });
    expect(other.ok).toBe(false);
  });
});

describe('cross-origin redirects (spec 02 section 9.3)', () => {
  it('same origin continues', async () => {
    const w = await setup();
    expect(await w.bg.gate.checkRedirectTarget(`${ORIGIN}/file`, ORIGIN)).toBe('ok');
  });

  it('a public CDN without host permission continues (the browser applied CORS)', async () => {
    const w = await setup();
    expect(await w.bg.gate.checkRedirectTarget('https://cdn.example.net/blob?sig=x', ORIGIN)).toBe(
      'ok',
    );
  });

  it('with host permission but no cookies it continues', async () => {
    const w = await setup();
    w.ext.grant('https://cdn.example.net');
    expect(await w.bg.gate.checkRedirectTarget('https://cdn.example.net/blob', ORIGIN)).toBe('ok');
  });

  it('with cookies for the final origin and no consent for it, it is denied; with consent it continues', async () => {
    const w = await setup();
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
    expect(await w.bg.gate.checkRedirectTarget('https://cdn.example.net/blob', ORIGIN)).toBe(
      'denied',
    );
    await consent(w, { grant_id: grantId(5), origin: 'https://cdn.example.net' });
    expect(await w.bg.gate.checkRedirectTarget('https://cdn.example.net/blob', ORIGIN)).toBe('ok');
  });

  it('fails closed when cookies cannot be inspected', async () => {
    const w = await setup();
    w.ext.grantedOrigins.add('https://cdn.example.net/*'); // host permission without the cookies permission
    expect(await w.bg.gate.checkRedirectTarget('https://cdn.example.net/blob', ORIGIN)).toBe(
      'denied',
    );
  });
});
