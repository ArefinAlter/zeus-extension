import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobBook } from '../../src/background/jobs';
import { StateStore } from '../../src/background/state';
import type { DomainEvent } from '../../src/lib/protocol';
import { approvalId, grantId, jobId, runId } from '../helpers/ids';
import { World } from '../harness/world';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ev = (seq: number, type: string, data: Record<string, unknown>, job?: string) => ({
  subscription_id: 'sub1',
  event: {
    seq,
    ts: `2026-10-05T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    type,
    ...(job ? { job_id: job } : {}),
    data,
  },
});

const created = (
  id: string,
  state = 'queued',
  source: Record<string, unknown> = { kind: 'browser_handoff', via: 'native_messaging' },
) => ({
  source,
  state,
  url_redacted: 'https://portal.example.org/download/8841',
  filename_hint: 'dataset-v3.tar.zst',
  origin: 'https://portal.example.org',
  session_origin: 'https://portal.example.org',
  priority: 'high',
  id,
});

describe('event stream (spec 02 section 11, 01 section 9.2)', () => {
  it('de-duplicates by seq, persists the cursor and resumes after a restart', async () => {
    const w = await new World().boot();
    w.daemon.send('job.event', ev(150, 'job.created', created(jobId(1)), jobId(1)));
    w.daemon.send('job.event', ev(150, 'job.created', created(jobId(1)), jobId(1))); // replay overlap
    w.daemon.send(
      'job.event',
      ev(
        151,
        'job.state_changed',
        {
          from: 'queued',
          to: 'probing',
          transition: 'S03',
          cause: 'scheduler',
          actor: { kind: 'engine' },
        },
        jobId(1),
      ),
    );
    await w.settle();
    expect(w.bg.events.cursor).toBe(151);
    expect(w.bg.jobs.list()).toHaveLength(1);
    expect(w.bg.jobs.get(jobId(1))?.state).toBe('probing');
    await w.advance(1_500); // the cursor is flushed at most once a second
    expect(await w.bg.store.getLastEventSeq()).toBe(151);

    const restarted = new World();
    for (const [k, v] of w.ext.local.data) restarted.ext.local.data.set(k, v);
    await restarted.boot();
    expect(
      (restarted.daemon.sent('hello')[0]?.body as { resume?: { last_event_seq: number } }).resume,
    ).toEqual({ last_event_seq: 151 });
    expect(restarted.daemon.sent('events.subscribe')[0]?.body).toMatchObject({
      since_seq: 151,
      scope: 'all',
    });
    expect(restarted.daemon.violations).toEqual([]);
  });

  it('does not send a resume cursor on a first run', async () => {
    const w = await new World().boot();
    expect((w.daemon.sent('hello')[0]?.body as Record<string, unknown>).resume).toBeUndefined();
    expect(w.daemon.sent('events.subscribe')[0]?.body).not.toHaveProperty('since_seq');
  });

  it('ignores event types it does not know and malformed events without dropping the connection', async () => {
    const w = await new World().boot();
    // not valid against the strict contract (a newer daemon, or a bug): delivered raw
    w.daemon.raw({ v: 1, id: 'd60', type: 'job.event', body: ev(160, 'job.teleported', { x: 1 }) });
    w.daemon.raw({
      v: 1,
      id: 'd61',
      type: 'job.event',
      body: ev(161, 'grant.created', { grant: { id: 'nope' } }),
    });
    w.daemon.send('job.event', ev(162, 'job.created', created(jobId(2)), jobId(2)));
    await w.settle();
    expect(w.bg.link.isReady()).toBe(true);
    expect(w.bg.jobs.get(jobId(2))).toBeDefined();
    expect(w.bg.events.cursor).toBe(162);
  });

  it('keeps ephemeral progress out of the cursor and updates the job mirror', async () => {
    const w = await new World().boot();
    w.daemon.send('job.event', ev(170, 'job.created', created(jobId(3)), jobId(3)));
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        after_seq: 170,
        ts: '2026-10-05T10:01:00.000Z',
        type: 'job.progress',
        job_id: jobId(3),
        data: {
          progress: {
            bytes_done: 5,
            bytes_total: 10,
            rate_ewma: 1,
            eta_s: 5,
            segments_active: 1,
            last_error_class: null,
            updated_at: '2026-10-05T10:01:00.000Z',
          },
        },
      },
    });
    await w.settle();
    expect(w.bg.events.cursor).toBe(170);
    expect(w.bg.jobs.get(jobId(3))).toMatchObject({ bytes_done: 5, bytes_total: 10 });
  });

  it('records the run of workflow jobs for the release gate', async () => {
    const w = await new World().boot();
    w.daemon.send(
      'job.event',
      ev(
        180,
        'job.created',
        created(jobId(4), 'queued', { kind: 'workflow', via: 'workflow_runner', run_id: runId(1) }),
        jobId(4),
      ),
    );
    await w.settle();
    expect((await w.bg.store.getJobRuns())[jobId(4)]).toBe(runId(1));
  });
});

describe('completion notifications', () => {
  async function ownJobWorld(): Promise<World> {
    const w = await new World().boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle(); // the fake daemon accepts and names the job job_..01
    w.daemon.send('job.event', ev(190, 'job.created', created(jobId(1)), jobId(1)));
    await w.settle();
    return w;
  }

  it('tells the user when a rescued download is saved', async () => {
    const w = await ownJobWorld();
    w.daemon.send(
      'job.event',
      ev(
        191,
        'job.completed',
        {
          path: '/home/ada/Downloads/Zeus/dataset-v3.tar.zst',
          size_bytes: 1_288_490_188,
          sha256: 'eba4a8587ad422baa9bb314f660b11dfd73563c9af06c6c6ed6ec4bf2da2bc47',
          blake3: '1e0f07a3c0beca17e28b2d889c3e78a743e9c931e3d5efbff76921fe028ce231',
          quarantined: false,
          duration_ms: 101_770,
        },
        jobId(1),
      ),
    );
    await w.settle();
    const note = w.ext.notificationsShown.find((n) => n.id === `zeus-job-${jobId(1)}`);
    expect(note?.spec.title).toBe('Zeus saved a file');
    expect(note?.spec.message).toBe('dataset-v3.tar.zst (SHA-256 eba4a8587ad4…)');
    expect(note?.spec.message).not.toContain('/home/ada');
  });

  it('explains a failure in words, by error class when the code has no text', async () => {
    const w = await ownJobWorld();
    w.daemon.send(
      'job.event',
      ev(
        192,
        'job.failed',
        {
          error: {
            code: 'http.blocked_challenge',
            class: 'blocked',
            message: 'challenge',
            retryable: false,
          },
          suggested_next: { action: 'open_in_browser', tool: null },
        },
        jobId(1),
      ),
    );
    await w.settle();
    const note = w.ext.notificationsShown.find((n) => n.id === `zeus-job-${jobId(1)}`);
    expect(note?.spec.message).toBe('dataset-v3.tar.zst: The site blocks automated downloads');
  });

  it('stays silent for jobs started by agents or the CLI', async () => {
    const w = await new World().boot();
    w.daemon.send(
      'job.event',
      ev(
        195,
        'job.created',
        created(jobId(9), 'queued', { kind: 'agent', via: 'mcp', client_id: 'x' }),
        jobId(9),
      ),
    );
    w.daemon.send(
      'job.event',
      ev(
        196,
        'job.completed',
        {
          path: '/x',
          size_bytes: 1,
          sha256: 'a'.repeat(64),
          blake3: 'b'.repeat(64),
          quarantined: false,
          duration_ms: 1,
        },
        jobId(9),
      ),
    );
    await w.settle();
    expect(w.ext.notificationsShown).toHaveLength(0);
  });

  it('honours the notifications setting', async () => {
    const w = await ownJobWorld();
    await w.bg.store.setSettings({ notifications: false });
    w.daemon.send(
      'job.event',
      ev(
        197,
        'job.completed',
        {
          path: '/x',
          size_bytes: 1,
          sha256: 'a'.repeat(64),
          blake3: 'b'.repeat(64),
          quarantined: false,
          duration_ms: 1,
        },
        jobId(1),
      ),
    );
    await w.settle();
    expect(w.ext.notificationsShown).toHaveLength(0);
  });
});

describe('job mirror', () => {
  const t = '2026-10-05T10:00:00.000Z';
  const created: DomainEvent = {
    seq: 1,
    ts: t,
    type: 'job.created',
    job_id: jobId(1),
    data: {
      source: { kind: 'cli' },
      state: 'queued',
      url_redacted: 'https://a.example/x',
      priority: 'normal',
    },
  };

  it('ignores updates for jobs it never saw created and caps the list at 100', () => {
    const book = new JobBook();
    book.apply({
      seq: 2,
      ts: t,
      type: 'job.state_changed',
      job_id: jobId(1),
      data: {
        from: 'queued',
        to: 'probing',
        transition: 'S03',
        cause: 'scheduler',
        actor: { kind: 'engine' },
      },
    });
    expect(book.list()).toHaveLength(0);
    for (let i = 0; i < 130; i++) {
      book.apply({
        ...(created as object),
        job_id: jobId(i % 1000),
        ts: `2026-10-05T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      } as DomainEvent);
    }
    expect(book.list(200).length).toBeLessThanOrEqual(100);
  });

  it('knows whether anything is still running', () => {
    const book = new JobBook();
    book.apply(created);
    expect(book.hasActive()).toBe(true);
    book.apply({
      seq: 3,
      ts: t,
      type: 'job.failed',
      job_id: jobId(1),
      data: {
        error: { code: 'http.status_404', class: 'permanent', message: 'x', retryable: false },
        suggested_next: { action: 'none', tool: null },
      },
    });
    expect(book.hasActive()).toBe(false);
    expect(book.get(jobId(1))?.last_error?.code).toBe('http.status_404');
  });
});

describe('persistent state hygiene (spec 02 section 4 rule 6)', () => {
  it('survives corrupt or foreign storage content', async () => {
    const w = new World({ noDaemon: true });
    const store = new StateStore(w.env);
    w.ext.local.data.set('zeus.v1.consent', 'garbage');
    w.ext.local.data.set('zeus.v1.never', [{ nope: 1 }, null, 5]);
    w.ext.local.data.set('zeus.v1.offers', { not: 'a list' });
    w.ext.local.data.set('zeus.v1.settings', { auto_offer: 'yes' });
    w.ext.local.data.set('zeus.v1.last_event_seq', -5);
    w.ext.local.data.set('zeus.v1.profile_id', 'not-hex');
    expect(await store.listConsent()).toEqual([]);
    expect(await store.listNever()).toEqual([]);
    expect(await store.listOffers()).toEqual([]);
    expect(await store.getSettings()).toEqual({ auto_offer: true, notifications: true });
    expect(await store.getLastEventSeq()).toBeNull();
    expect(await store.getProfileId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('survives a failing storage backend', async () => {
    const w = new World({ noDaemon: true });
    const store = new StateStore(w.env);
    w.ext.local.failNext = new Error('QUOTA_BYTES quota exceeded');
    await expect(
      store.putConsent({
        grant_id: grantId(1),
        origin: 'https://a.example',
        scope: 'site',
        expires_at_ms: Date.now() + 1e6,
        source: 'ui',
      }),
    ).resolves.toBeUndefined();
    w.ext.local.failNext = new Error('storage unavailable');
    expect(await store.listConsent()).toEqual([]);
  });

  it('does not lose concurrent updates', async () => {
    const w = new World({ noDaemon: true });
    const store = new StateStore(w.env);
    const now = w.clock.now();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.putConsent({
          grant_id: grantId(i),
          origin: `https://s${i}.example`,
          scope: 'site',
          expires_at_ms: now + 1e9,
          source: 'ui',
        }),
      ),
    );
    expect(await store.listConsent()).toHaveLength(25);
  });

  it('keeps the profile id stable and bounds every growing list', async () => {
    const w = new World({ noDaemon: true });
    const store = new StateStore(w.env);
    const first = await store.getProfileId();
    expect(await store.getProfileId()).toBe(first);
    for (let i = 0; i < 260; i++) {
      await store.putOffer({
        offer_key: `chrome:${i}:t`,
        download_id: i,
        trigger: 'interrupted',
        status: 'accepted',
        job_id: null,
        approval_id: null,
        created_at_ms: w.clock.now(),
      });
      await store.markApprovalDisplayed(approvalId(i % 1000) + String(i));
      await store.claimSessionId(`sess_${i}`);
    }
    expect((await store.listOffers()).length).toBeLessThanOrEqual(200);
    expect(
      JSON.parse(JSON.stringify(w.ext.session.data.get('zeus.s.released_sessions'))),
    ).toHaveLength(256);
    expect(
      Object.keys(w.ext.local.data.get('zeus.v1.displayed_approvals') as object).length,
    ).toBeLessThanOrEqual(200);
  });

  it('prunes expired consent records and stored offers age out', async () => {
    const w = new World({ noDaemon: true });
    const store = new StateStore(w.env);
    const now = w.clock.now();
    await store.putConsent({
      grant_id: grantId(1),
      origin: 'https://a.example',
      scope: 'site',
      expires_at_ms: now + 1000,
      source: 'ui',
    });
    w.clock.tick(2000);
    expect((await store.pruneConsent()).map((r) => r.grant_id)).toEqual([grantId(1)]);
    expect(await store.listConsent()).toEqual([]);
  });

  it('writes nothing that looks like a URL query, cookie or filename path', async () => {
    const w = await new World().boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    const dump = w.ext.local.dump() + w.ext.session.dump();
    expect(dump).not.toMatch(/X-Amz|Signature|Users|dataset-v3|https?:\/\//);
  });
});
