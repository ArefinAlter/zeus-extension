import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_CAPABILITIES } from '../harness/fake-daemon';
import { World, type WorldOptions } from '../harness/world';
import { approvalId, grantId, runId } from '../helpers/ids';
import type { SessionPageRequestBody } from '../../src/lib/protocol';

const ORIGIN = 'https://portal.example.org';
const PLAN = 'plan_01M45NHJ2AHWMXT8JVJ7BEEJ01';
const CANARY = 'ZEUS-CANARY-authenticated-document';
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function ready(options: WorldOptions = {}): Promise<World> {
  const world = await new World({
    daemon: { capabilities: [...DAEMON_CAPABILITIES, 'session.page'] },
    ...options,
  }).boot();
  world.ext.grant(ORIGIN);
  await world.bg.store.putConsent({
    grant_id: grantId(1),
    origin: ORIGIN,
    scope: 'workflow',
    run_id: runId(1),
    expires_at_ms: world.clock.now() + 60_000,
    source: 'ui',
  });
  world.fetcher.respondWith({
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: [new TextEncoder().encode(CANARY)],
  });
  return world;
}
async function request(
  world: World,
  change: Partial<SessionPageRequestBody> = {},
): Promise<SessionPageRequestBody> {
  return {
    subject: { purpose: 'run', run_id: runId(1) },
    grant_id: grantId(1),
    profile_id: await world.bg.store.getProfileId(),
    origin: ORIGIN,
    url: `${ORIGIN}/page?private=query`,
    representation: 'html',
    max_body_bytes: 512,
    deadline_ms: 5000,
    incognito: false,
    ...change,
  };
}
async function ask(world: World, body: SessionPageRequestBody): Promise<Record<string, unknown>> {
  const id = world.daemon.send('session.page.request', { ...body });
  await world.settle();
  const reply = world.daemon.frames.find((frame) => frame.re === id);
  if (!reply) throw new Error('page response missing');
  return reply.body;
}

describe('explicit browser page grants', () => {
  it('returns bounded document data on the native protocol without reading or exposing cookies', async () => {
    const world = await ready();
    const cookies = vi.spyOn(world.ext.api.cookies, 'getAll');
    const reply = await ask(world, await request(world));
    expect(reply.status).toBe('fetched');
    const document = reply.document as Record<string, unknown>;
    expect(Buffer.from(document.data as string, 'base64').toString()).toBe(CANARY);
    expect(document.subject).toEqual({ purpose: 'run', run_id: runId(1) });
    expect(cookies).not.toHaveBeenCalled();
    expect(world.fetcher.requests[0]?.init).toMatchObject({
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(world.logs()).not.toContain(CANARY);
    expect(world.logs()).not.toContain('private=query');
    expect(world.daemon.violations).toEqual([]);
  });

  it('separates site-granted plan sampling from workflow-granted execution', async () => {
    const world = await ready();
    const plan = await request(world, { subject: { purpose: 'plan', plan_id: PLAN } });
    expect((await ask(world, plan)).status).toBe('unavailable');
    expect(world.fetcher.requests).toHaveLength(0);
    await world.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: world.clock.now() + 60_000,
      source: 'ui',
    });
    expect((await ask(world, plan)).status).toBe('fetched');
    expect((await ask(world, await request(world))).status).toBe('unavailable');
    expect(world.fetcher.requests).toHaveLength(1);
  });

  it('rejects wrong runs, profiles, grants and origins before making a request', async () => {
    const world = await ready();
    for (const change of [
      { subject: { purpose: 'run' as const, run_id: runId(2) } },
      { profile_id: 'f'.repeat(32) },
      { grant_id: grantId(2) },
      { origin: 'https://other.example.org' },
    ])
      expect((await ask(world, await request(world, change))).status).toBe('unavailable');
    expect(world.fetcher.requests).toHaveLength(0);
  });

  it('accepts terminal grants only after local display and host permission, then rejects expiry and revocation', async () => {
    for (const displayed of [false, true]) {
      const world = await new World({
        daemon: { capabilities: [...DAEMON_CAPABILITIES, 'session.page'] },
      }).boot();
      if (displayed) await world.bg.store.markApprovalDisplayed(approvalId(1));
      const now = world.clock.now();
      await world.bg.approvals.onGrantCreated({
        id: grantId(1),
        origin: ORIGIN,
        scope: 'workflow',
        state: 'active',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        approval_id: approvalId(1),
        run_id: runId(1),
        decided_by: { kind: 'human', surface: 'cli_interactive' },
        uses: 0,
        renewable: false,
      });
      world.fetcher.respondWith({
        headers: { 'content-type': 'text/html' },
        body: [new TextEncoder().encode(CANARY)],
      });
      // A valid daemon decision cannot substitute for browser host permission.
      expect((await ask(world, await request(world))).status).toBe('unavailable');
      expect(world.fetcher.requests).toHaveLength(0);
      world.ext.grant(ORIGIN, false);
      expect((await ask(world, await request(world))).status).toBe(
        displayed ? 'fetched' : 'unavailable',
      );
      expect(world.fetcher.requests).toHaveLength(displayed ? 1 : 0);
      if (displayed) {
        await world.bg.store.putConsent({
          grant_id: grantId(1),
          origin: ORIGIN,
          scope: 'workflow',
          run_id: runId(1),
          expires_at_ms: now - 1,
          source: 'event',
        });
        expect((await ask(world, await request(world))).status).toBe('unavailable');
        await world.bg.approvals.onGrantEnded(grantId(1), ORIGIN);
        expect((await ask(world, await request(world))).status).toBe('unavailable');
        expect(world.fetcher.requests).toHaveLength(1);
      }
    }
  });

  it('requires negotiated capability and refuses private-profile fallback', async () => {
    for (const options of [
      { daemon: { capabilities: DAEMON_CAPABILITIES } },
      { ext: { isIncognitoContext: true } },
    ]) {
      const world = await ready(options);
      expect((await ask(world, await request(world))).status).toBe('unavailable');
      expect(world.fetcher.requests).toHaveLength(0);
    }
    const world = await ready();
    expect((await ask(world, await request(world, { incognito: true }))).status).toBe(
      'unavailable',
    );
    expect(world.fetcher.requests).toHaveLength(0);
  });

  it('never dispatches insecure, numeric or local-network browser page targets', async () => {
    const world = await ready();
    for (const url of [
      'http://portal.example.org/page',
      'https://127.1/page',
      'https://[::1]/page',
      'https://localhost/page',
      'https://device.local/page',
      'https://device.internal/page',
    ]) {
      expect(
        (await ask(world, await request(world, { url, origin: new URL(url).origin }))).status,
      ).toBe('unavailable');
    }
    expect(world.fetcher.requests).toHaveLength(0);
  });

  it('refuses redirects, binary bodies and documents larger than the exact reviewed limit', async () => {
    const world = await ready();
    for (const response of [
      { url: 'https://other.example.org/page', headers: { 'content-type': 'text/html' } },
      { headers: { 'content-type': 'application/octet-stream' } },
      { headers: { 'content-type': 'text/html' }, body: [new Uint8Array(513)] },
    ]) {
      world.fetcher.respondWith(response);
      expect((await ask(world, await request(world))).status).toBe('unavailable');
    }
    expect(world.bg.pages.openCount()).toBe(0);
  });

  it('cancels only the correlated page request and sends no document after cancellation', async () => {
    const world = await ready();
    world.fetcher.respondWith({ headers: { 'content-type': 'text/html' }, hang: true });
    const body = await request(world);
    const id = world.daemon.send('session.page.request', { ...body });
    await world.settle();
    world.daemon.send('session.page.cancel', { request_id: 'd-unrelated' });
    await world.settle();
    expect(world.bg.pages.openCount()).toBe(1);
    world.daemon.send('session.page.cancel', { request_id: id });
    await world.settle();
    expect(world.bg.pages.openCount()).toBe(0);
    expect(world.daemon.frames.find((frame) => frame.re === id)?.body.status).toBe('unavailable');
    expect(world.daemon.violations).toEqual([]);
  });

  it('aborts stalled bodies when consent disappears and on the original deadline', async () => {
    for (const revoke of [true, false]) {
      const world = await ready();
      world.fetcher.respondWith({ headers: { 'content-type': 'text/html' }, hang: true });
      const reading = world.bg.pages.read(await request(world), 'd-direct');
      await world.settle();
      if (revoke) await world.bg.store.removeConsent(() => true);
      await world.advance(revoke ? 300 : 5100);
      expect((await reading).status).toBe('unavailable');
      expect(world.bg.pages.openCount()).toBe(0);
    }
  });
});
