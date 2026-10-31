import { withBinding, decisionBinding } from '../helpers/approvals';
// The sequence diagrams of spec 02 section 15, played end to end against the real background with a
// scripted daemon. Every frame the extension emits is validated against the schema by the fake
// daemon; each test ends by asserting that there were no violations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalId, grantId, jobId, sessionId } from '../helpers/ids';
import { World } from '../harness/world';
import { pattern, splitPieces } from '../harness/fake-fetch';
import type { UiResponse } from '../../src/lib/ui-protocol';

const ORIGIN = 'https://portal.example.org';
const CANARY = 'ZEUS-CANARY-seq-cookie';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const pendingApproval = withBinding({
  id: approvalId(1),
  kind: 'handoff',
  state: 'pending',
  job_id: jobId(1),
  origin: ORIGIN,
  allowed_scopes: ['once', 'site', 'never'],
  reason_codes: ['handoff.interrupted', 'session.first_use'],
  summary: {
    title: 'dataset-v3.tar.zst',
    url_redacted: `${ORIGIN}/download/8841`,
    total_bytes: 1_288_490_188,
    source_kind: 'browser_handoff',
  },
  created_at: '2026-10-05T09:15:30.301Z',
  expires_at: '2026-10-06T09:15:30.301Z',
  decided_at: null,
});

const siteGrant = {
  id: grantId(1),
  origin: ORIGIN,
  scope: 'site',
  state: 'active',
  created_at: '2026-10-05T09:15:34.870Z',
  expires_at: '2026-10-06T09:15:34.870Z',
  approval_id: approvalId(1),
  decided_by: { kind: 'human', surface: 'extension_popup' },
  uses: 0,
  last_used_at: null,
  revoked_at: null,
  renewable: false,
  renewal_count: 0,
};

function scriptDecision(w: World, grant: Record<string, unknown> | null): void {
  w.daemon.on('approval.decide', (f, d) => {
    const approved = f.body.decision === 'approve';
    d.reply(f, 'approval.decide.response', {
      approval: {
        ...pendingApproval,
        state: approved ? 'approved' : 'denied',
        decided_at: '2026-10-05T09:15:34.870Z',
        decision: {
          outcome: f.body.decision,
          ...(f.body.scope ? { scope: f.body.scope } : {}),
          actor: { kind: 'human', surface: 'extension_popup' },
          ...(grant ? { grant_id: grantId(1) } : {}),
        },
      },
      ...(grant ? { grant } : {}),
    });
  });
}

describe('15.1 rescue happy path', () => {
  it('offer, approval, browser-only ranged download and completion', async () => {
    const w = await new World().boot();
    scriptDecision(w, siteGrant);
    w.ext.jar = [
      {
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
      },
    ];

    // E: downloads.onChanged interrupted -> handoff.offer -> D: handoff.accept + approval.pending
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(1);
    w.daemon.send('approval.pending', { approval: pendingApproval });
    await w.settle();

    // the human clicks "This site (24 h)": the popup obtains the browser permission, then decides
    expect(await w.ext.api.permissions.request({ origins: [`${ORIGIN}/*`] })).toBe(true);
    const decided = (await w.ext.sendFromPage({
      ...decisionBinding(pendingApproval),
      cmd: 'approval.decide',
      approval_id: approvalId(1),
      decision: 'approve',
      scope: 'site',
      user_gesture: true,
      surface: 'extension_popup',
    })) as UiResponse;
    expect(decided).toMatchObject({ ok: true });

    // D: S30 -> probing: session.request -> E: session.response
    const reqId = w.daemon.send('session.request', {
      job_id: jobId(1),
      session_id: sessionId(1),
      grant_id: grantId(1),
      origin: ORIGIN,
      url: `${ORIGIN}/download/8841`,
      purpose: 'download',
      request_headers: ['accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'],
      ttl_ms: 900_000,
      incognito: false,
    });
    await w.settle();
    const session = w.daemon.frames.find((f) => f.re === reqId);
    expect(session?.body).toMatchObject({
      status: 'denied',
      error: { code: 'session.consent_denied' },
    });

    // D: ranged GETs go direct. A later block moves the transfer to the browser:
    w.fetcher.respondWith({
      status: 206,
      headers: {
        'content-range': 'bytes 402653184-402719719/1288490188',
        etag: '"5f3a9c-4c1d2e7b"',
      },
      body: splitPieces(pattern(402_653_184, 65_536), 16_384),
    });
    w.daemon.send('fetch.range', {
      stream_id: 's1',
      job_id: jobId(1),
      url: `${ORIGIN}/download/8841`,
      origin: ORIGIN,
      range: { offset: 402_653_184, length: 65_536 },
      if_range: '"5f3a9c-4c1d2e7b"',
      chunk_bytes: 16_384,
      credits: 8,
      deadline_ms: 25_000,
    });
    await w.settle(20);
    expect(w.daemon.sent('fetch.end')[0]?.body).toMatchObject({
      reason: 'complete',
      chunks: 4,
      bytes: 65_536,
    });

    // D: job.completed -> E notifies
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 500,
        ts: '2026-10-05T09:17:12.020Z',
        type: 'job.created',
        job_id: jobId(1),
        data: {
          source: { kind: 'browser_handoff', via: 'native_messaging' },
          state: 'queued',
          url_redacted: `${ORIGIN}/download/8841`,
          filename_hint: 'dataset-v3.tar.zst',
          priority: 'high',
        },
      },
    });
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 501,
        ts: '2026-10-05T09:17:12.020Z',
        type: 'job.completed',
        job_id: jobId(1),
        data: {
          path: '/home/ada/Downloads/Zeus/dataset-v3.tar.zst',
          size_bytes: 1_288_490_188,
          sha256: 'eba4a8587ad422baa9bb314f660b11dfd73563c9af06c6c6ed6ec4bf2da2bc47',
          blake3: '1e0f07a3c0beca17e28b2d889c3e78a743e9c931e3d5efbff76921fe028ce231',
          quarantined: false,
          duration_ms: 101_770,
        },
      },
    });
    await w.settle();
    expect(w.ext.notificationsShown.map((n) => n.spec.title)).toContain('Zeus saved a file');

    expect(w.daemon.violations).toEqual([]);
    // Cookie values never leave the browser, including in legacy responses.
    const leaks = w.daemon.frames.filter((f) => JSON.stringify(f).includes(CANARY));
    expect(w.ext.cookieQueries).toEqual([]);
    expect(leaks).toEqual([]);
    expect(w.logs()).not.toContain(CANARY);
    expect(w.ext.local.dump() + w.ext.session.dump()).not.toContain(CANARY);
  });
});

describe('15.2 expired URL', () => {
  it('refreshes a signed URL while refusing legacy cookie export', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 1e9,
      source: 'ui',
    });
    w.ext.jar = [
      {
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
      },
    ];
    w.fetcher.respondWith({
      status: 206,
      url: 'https://cdn.example.org/blobs/annual-report.pdf?X-Amz-Signature=FRESH-EXAMPLE',
      redirected: true,
      headers: { 'content-range': 'bytes 0-0/734003200', etag: '"a81c-77e2"' },
      body: [],
    });

    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 510,
        ts: '2026-10-05T10:31:20.000Z',
        type: 'session.refresh_needed',
        job_id: jobId(2),
        data: {
          origin: ORIGIN,
          need: 'url',
          reason: 'url_expired',
          attempt: 1,
          deadline_at: '2026-10-05T11:31:20.000Z',
        },
      },
    });
    const refreshId = w.daemon.send('url.refresh.request', {
      job_id: jobId(2),
      origin: ORIGIN,
      origin_url: `${ORIGIN}/files/annual-report.pdf`,
      stale_url: 'https://cdn.example.org/blobs/annual-report.pdf?X-Amz-Signature=STALE',
      reason: 'url_expired',
      methods: ['refetch', 'download_api'],
      expected: { total_bytes: 734_003_200, etag: '"a81c-77e2"', filename: 'annual-report.pdf' },
      deadline_ms: 25_000,
    });
    await w.settle();
    expect(w.daemon.frames.find((f) => f.re === refreshId)?.body).toMatchObject({
      status: 'refreshed',
      method: 'refetch',
      final_url: 'https://cdn.example.org/blobs/annual-report.pdf?X-Amz-Signature=FRESH-EXAMPLE',
      total_bytes: 734_003_200,
    });

    const sessId = w.daemon.send('session.request', {
      job_id: jobId(2),
      session_id: sessionId(2),
      grant_id: grantId(1),
      origin: ORIGIN,
      url: `${ORIGIN}/files/annual-report.pdf`,
      purpose: 'refresh',
      request_headers: ['accept-language'],
      ttl_ms: 900_000,
      incognito: false,
    });
    await w.settle();
    expect(w.daemon.frames.find((f) => f.re === sessId)?.body).toMatchObject({
      status: 'denied',
      error: { code: 'session.consent_denied' },
    });
    expect(w.daemon.violations).toEqual([]);
  });
});

describe('15.3 blocked, then in-browser fetch', () => {
  it('streams ranges with credit, slice after slice, and stops cleanly when the challenge shows up in the browser too', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 1e9,
      source: 'ui',
    });
    const url = `${ORIGIN}/download/9120`;
    const slice = (id: string, offset: number) => ({
      stream_id: id,
      job_id: jobId(3),
      url,
      origin: ORIGIN,
      range: { offset, length: 32_768 },
      if_range: '"5f3a9c-4c1d2e7b"',
      chunk_bytes: 8_192,
      credits: 2,
      deadline_ms: 25_000,
    });

    w.fetcher.respondWith((r) => {
      const start = Number(/bytes=(\d+)-/.exec(r.headers.Range ?? '')?.[1] ?? 0);
      return {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${start + 32_767}/1288490188`,
          etag: '"5f3a9c-4c1d2e7b"',
        },
        body: splitPieces(pattern(start, 32_768), 8_192),
      };
    });
    // slice 1 with credit replenishment as D writes chunks
    w.daemon.send('fetch.range', slice('s1', 1_000_000));
    await w.settle(10);
    expect(w.daemon.sent('fetch.chunk')).toHaveLength(2);
    w.daemon.send('fetch.credit', { stream_id: 's1', credits: 2 });
    await w.settle(10);
    expect(w.daemon.sent('fetch.end').map((f) => f.body.stream_id)).toEqual(['s1']);
    // slice 2 follows, as D issues the next range when one ends
    w.daemon.send('fetch.range', slice('s2', 1_032_768));
    await w.settle(10);
    w.daemon.send('fetch.credit', { stream_id: 's2', credits: 2 });
    await w.settle(10);
    const chunks = w.daemon.sent('fetch.chunk');
    expect(chunks.map((c) => c.body.offset)).toEqual([
      1_000_000, 1_008_192, 1_016_384, 1_024_576, 1_032_768, 1_040_960, 1_049_152, 1_057_344,
    ]);

    // the challenge now appears in the browser: head only, then the daemon gives up
    w.fetcher.respondWith({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: [] });
    w.daemon.send('fetch.range', slice('s3', 1_065_536));
    await w.settle(10);
    expect(w.daemon.sent('fetch.head').at(-1)?.body).toMatchObject({
      stream_id: 's3',
      status: 403,
    });
    w.daemon.send('fetch.cancel', { stream_id: 's3', reason: 'superseded' });
    await w.settle(10);
    expect(w.daemon.sent('fetch.end').at(-1)?.body).toMatchObject({
      stream_id: 's3',
      reason: 'canceled',
    });
    expect(w.daemon.violations).toEqual([]);
  });
});

describe('15.4 consent denied', () => {
  it('never for this site: the grant is recorded and later releases for the origin are refused', async () => {
    const w = await new World().boot();
    scriptDecision(w, { ...siteGrant, scope: 'never', expires_at: null });
    w.ext.addDownload({ id: 320, state: 'in_progress' });
    w.ext.interrupt(320, 'NETWORK_DISCONNECTED');
    await w.settle();
    w.daemon.send('approval.pending', { approval: pendingApproval });
    await w.settle();
    const decided = (await w.ext.sendFromPage({
      ...decisionBinding(pendingApproval),
      cmd: 'approval.decide',
      approval_id: approvalId(1),
      decision: 'deny',
      scope: 'never',
      user_gesture: true,
      surface: 'extension_popup',
    })) as UiResponse;
    expect(decided).toMatchObject({ ok: true, data: { state: 'denied' } });
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 520,
        ts: '2026-10-05T09:15:35.000Z',
        type: 'job.failed',
        job_id: jobId(1),
        data: {
          error: {
            code: 'policy.approval_denied',
            class: 'policy_denied',
            message: 'denied',
            retryable: false,
          },
          suggested_next: { action: 'approve', tool: null },
        },
      },
    });
    await w.settle();

    w.ext.grant(ORIGIN);
    const reqId = w.daemon.send('session.request', {
      job_id: jobId(4),
      session_id: sessionId(3),
      grant_id: grantId(9),
      origin: ORIGIN,
      url: `${ORIGIN}/x`,
      purpose: 'download',
      request_headers: [],
      ttl_ms: 900_000,
      incognito: false,
    });
    await w.settle();
    expect(w.daemon.frames.find((f) => f.re === reqId)?.body).toMatchObject({
      status: 'denied',
      error: { code: 'session.consent_denied' },
    });
    expect(w.daemon.violations).toEqual([]);
  });

  it('legacy cookie export is denied even when the daemon has a grant', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    const reqId = w.daemon.send('session.request', {
      job_id: jobId(4),
      session_id: sessionId(4),
      grant_id: grantId(1),
      origin: ORIGIN,
      url: `${ORIGIN}/x`,
      purpose: 'download',
      request_headers: [],
      ttl_ms: 900_000,
      incognito: false,
    });
    await w.settle();
    expect(w.daemon.frames.find((f) => f.re === reqId)?.body).toMatchObject({
      status: 'denied',
      error: { code: 'session.consent_denied', class: 'policy_denied', retryable: false },
    });
  });
});

describe('15.5 service worker restart mid-transfer', () => {
  it('reconnects, re-subscribes from the cursor and continues from the first uncommitted offset', async () => {
    const first = await new World().boot();
    first.ext.grant(ORIGIN);
    await first.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: first.clock.now() + 1e9,
      source: 'ui',
    });
    first.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 530,
        ts: '2026-10-05T09:30:00.000Z',
        type: 'job.created',
        job_id: jobId(5),
        data: {
          source: { kind: 'agent', via: 'mcp' },
          state: 'queued',
          url_redacted: `${ORIGIN}/d`,
          priority: 'normal',
        },
      },
    });
    await first.advance(1_500);
    first.fetcher.respondWith({
      status: 206,
      headers: {},
      body: splitPieces(pattern(0, 6 * 4096), 4096),
      hang: true,
    });
    first.daemon.send('fetch.range', {
      stream_id: 's1',
      job_id: jobId(5),
      url: `${ORIGIN}/d`,
      origin: ORIGIN,
      range: { offset: 0, length: 6 * 4096 },
      chunk_bytes: 4096,
      credits: 3,
      deadline_ms: 25_000,
    });
    await first.settle(10);
    expect(first.daemon.sent('fetch.chunk')).toHaveLength(3);

    // the worker is terminated: the host exits, the daemon keeps its committed ranges
    first.ext.lastNativePort().hostDisconnect('Native host has exited.');
    await first.settle();
    expect(first.bg.fetchProxy.openCount()).toBe(0);

    // a new worker with the same storage (consent, cursor, profile) and a new instance id
    const second = new World({ seed: 77 });
    for (const [k, v] of first.ext.local.data) second.ext.local.data.set(k, v);
    await second.boot();
    second.ext.grant(ORIGIN);
    const hello = second.daemon.sent('hello')[0]?.body as {
      profile_id: string;
      sw_instance_id: string;
      resume?: { last_event_seq: number };
    };
    const firstHello = first.daemons[0]?.sent('hello')[0]?.body as {
      profile_id: string;
      sw_instance_id: string;
    };
    expect(hello.profile_id).toBe(firstHello.profile_id);
    expect(hello.sw_instance_id).not.toBe(firstHello.sw_instance_id);
    expect(hello.resume).toEqual({ last_event_seq: 530 });

    // D re-issues the range from the first uncommitted offset (3 chunks were committed)
    second.fetcher.respondWith((r) => {
      expect(r.headers.Range).toBe(`bytes=${3 * 4096}-${6 * 4096 - 1}`);
      return { status: 206, headers: {}, body: splitPieces(pattern(3 * 4096, 3 * 4096), 4096) };
    });
    second.daemon.send('fetch.range', {
      stream_id: 's1',
      job_id: jobId(5),
      url: `${ORIGIN}/d`,
      origin: ORIGIN,
      range: { offset: 3 * 4096, length: 3 * 4096 },
      chunk_bytes: 4096,
      credits: 3,
      deadline_ms: 25_000,
    });
    await second.settle(10);
    expect(second.daemon.sent('fetch.chunk').map((c) => c.body.offset)).toEqual([
      12_288, 16_384, 20_480,
    ]);
    expect(second.daemon.sent('fetch.end')[0]?.body).toMatchObject({
      reason: 'complete',
      bytes: 12_288,
    });
    expect(second.daemon.violations).toEqual([]);
    expect(first.daemons[0]?.violations).toEqual([]);
  });

  it('a retried handoff.offer after the restart carries the same offer_key', async () => {
    const first = new World();
    first.ext.addDownload({ id: 317, state: 'in_progress' });
    await first.boot();
    first.daemon.ignore('handoff.offer');
    first.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await first.advance(500);
    const key = (first.daemon.sent('handoff.offer')[0]?.body as { offer_key: string }).offer_key;

    const second = new World();
    for (const [k, v] of first.ext.local.data) second.ext.local.data.set(k, v);
    second.ext.addDownload({ id: 317, state: 'interrupted', error: 'NETWORK_DISCONNECTED' });
    await second.boot();
    const retried = second.daemon.sent('handoff.offer');
    expect(retried).toHaveLength(1);
    expect((retried[0]?.body as { offer_key: string }).offer_key).toBe(key);
  });
});

describe('terminal handoff consent', () => {
  it('negotiates control capabilities and accepts a human terminal grant only for a displayed approval', async () => {
    const w = await new World().boot();
    for (const capability of ['approvals', 'events', 'job_control', 'grants'])
      expect(w.daemon.negotiated).toContain(capability);
    expect(w.daemon.sent('events.subscribe')).toHaveLength(1);
    expect(w.daemon.sent('job.list').length).toBeGreaterThan(0);
    await w.ext.api.permissions.request({ origins: [`${ORIGIN}/*`] });
    const grant = {
      ...siteGrant,
      scope: 'once',
      job_id: jobId(1),
      decided_by: { kind: 'human', surface: 'cli_interactive' },
    };
    const sendGrant = (seq: number) =>
      w.daemon.send('job.event', {
        subscription_id: 'sub1',
        event: { seq, ts: '2026-10-05T09:15:34.870Z', type: 'grant.created', data: { grant } },
      });
    sendGrant(101);
    await w.settle();
    expect(await w.bg.store.listConsent()).toHaveLength(0);
    w.daemon.send('approval.pending', { approval: pendingApproval });
    await w.settle();
    sendGrant(102);
    await w.settle();
    expect(
      await w.bg.gate.evaluate({
        kind: 'fetch',
        origin: ORIGIN,
        url: `${ORIGIN}/download/8841`,
        job_id: jobId(1),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await w.bg.gate.evaluate({
        kind: 'fetch',
        origin: ORIGIN,
        url: `${ORIGIN}/download/8841`,
        job_id: jobId(2),
      }),
    ).toMatchObject({ ok: false });
    expect(w.daemon.violations).toEqual([]);
  });
});
