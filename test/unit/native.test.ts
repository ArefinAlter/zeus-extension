import { withBinding } from '../helpers/approvals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_NAME } from '../../src/lib/protocol';
import { World } from '../harness/world';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('handshake (spec 02 section 5)', () => {
  it('opens the port at start and sends a schema-valid hello with v=1', async () => {
    const w = await new World().boot();
    expect(w.ext.nativePorts).toHaveLength(1);
    const hello = w.daemon.sent('hello')[0];
    expect(hello).toBeDefined();
    expect(hello?.v).toBe(1);
    expect(hello?.id).toBe('e1');
    const body = hello?.body as Record<string, unknown>;
    expect(body.client).toBe('zeus-extension');
    expect(body.extension_id).toBe(w.ext.id);
    expect(body.protocol_versions).toEqual([1]);
    expect(body.profile_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.sw_instance_id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.browser).toMatchObject({ name: 'chrome', platform: 'win' });
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        'handoff',
        'session',
        'url_refresh.refetch',
        'url_refresh.download_api',
        'fetch_proxy',
      ]),
    );
    expect(body.capabilities).not.toContain('incognito');
    expect(w.daemon.violations).toEqual([]);
  });

  it('declares the incognito capability only when private windows are allowed', async () => {
    const w = await new World({ ext: { allowedIncognito: true } }).boot();
    expect((w.daemon.sent('hello')[0]?.body as { capabilities: string[] }).capabilities).toContain(
      'incognito',
    );
  });

  it('becomes ready after hello.ack and subscribes to events and jobs', async () => {
    const w = await new World().boot();
    expect(w.bg.link.isReady()).toBe(true);
    expect(w.bg.link.status().info?.daemon.version).toBe('0.1.0');
    expect(w.daemon.sent('events.subscribe')).toHaveLength(1);
    expect(w.daemon.sent('job.list')).toHaveLength(1);
    expect(w.daemon.violations).toEqual([]);
  });

  it('keeps the same profile id across worker restarts and creates a new instance id', async () => {
    const first = await new World().boot();
    const profile = (first.daemon.sent('hello')[0]?.body as { profile_id: string }).profile_id;
    const instance = (first.daemon.sent('hello')[0]?.body as { sw_instance_id: string })
      .sw_instance_id;
    const second = new World();
    for (const [k, v] of first.ext.local.data) second.ext.local.data.set(k, v);
    await second.boot();
    const body = second.daemon.sent('hello')[0]?.body as {
      profile_id: string;
      sw_instance_id: string;
    };
    expect(body.profile_id).toBe(profile);
    expect(body.sw_instance_id).toMatch(/^[0-9a-f]{16}$/);
    expect(instance).toMatch(/^[0-9a-f]{16}$/);
  });

  it('closes when no hello.ack arrives within 10 s', async () => {
    const w = await new World({ daemon: { silentHello: true } }).boot();
    expect(w.bg.link.status().state).toBe('connecting');
    await w.advance(10_100);
    expect(w.ext.nativePorts[0]?.disconnectedByExtension).toBe(true);
    expect(w.bg.link.status().closeReason).toBe('handshake_timeout');
  });

  it('refuses a protocol version it does not speak', async () => {
    const w = new World({ daemon: { protocolVersion: 2 } });
    await w.boot();
    const daemon = w.daemons[0];
    expect(w.bg.link.isReady()).toBe(false);
    expect(w.bg.link.status().closeReason).toBe('version_unsupported');
    const bye = daemon?.sent('bye')[0];
    expect(bye?.body).toMatchObject({ reason: 'protocol_error' });
  });

  it('gives up cleanly on nm.version_unsupported from the daemon', async () => {
    const w = new World({ noDaemon: true });
    w.ext.onConnectNative = (port) => {
      port.onPosted = (raw) => {
        const frame = raw as { id: string; type: string };
        if (frame.type === 'hello') {
          port.deliver({
            v: 1,
            id: 'd1',
            re: frame.id,
            type: 'error',
            body: {
              error: {
                code: 'nm.version_unsupported',
                class: 'unsupported',
                message: 'no',
                retryable: false,
                details: { supported: [2] },
              },
            },
          });
        }
      };
    };
    await w.boot();
    expect(w.bg.link.status().closeReason).toBe('version_unsupported');
  });
});

describe('keepalive (spec 02 section 4)', () => {
  it('pings every 20 s and answers daemon pings', async () => {
    const w = await new World().boot();
    expect(w.daemon.sent('ping')).toHaveLength(0);
    await w.advance(20_100);
    expect(w.daemon.sent('ping')).toHaveLength(1);
    const pingId = w.daemon.send('ping', { nonce: 'abc' });
    await w.settle();
    const pong = w.daemon.sent('pong')[0];
    expect(pong?.body).toEqual({ nonce: 'abc' });
    expect(pong?.re).toBe(pingId);
    expect(w.daemon.violations).toEqual([]);
  });

  it('reconnects after two missed pongs', async () => {
    const w = await new World().boot();
    w.daemon.ignore('ping');
    await w.advance(20_000 + 5_000 + 20_000 + 5_100);
    expect(w.ext.nativePorts[0]?.disconnectedByExtension).toBe(true);
    await w.advance(2_000);
    expect(w.ext.nativePorts.length).toBeGreaterThanOrEqual(2);
    expect(w.bg.link.isReady()).toBe(true);
  });
});

describe('reconnect with backoff', () => {
  it('reconnects after the host exits, with a delay', async () => {
    const w = await new World().boot();
    w.ext.lastNativePort().hostDisconnect('Native host has exited.');
    await w.settle(2);
    expect(w.bg.link.status().state).toBe('backoff');
    expect(w.bg.link.status().closeReason).toBe('host_exited');
    await w.advance(1_000);
    expect(w.ext.nativePorts).toHaveLength(2);
    expect(w.bg.link.isReady()).toBe(true);
  });

  it('reports a missing host and stops hammering after five short connections', async () => {
    const w = new World({ noDaemon: true });
    w.ext.connectNativeFailure = 'Specified native messaging host not found.';
    await w.boot();
    for (let i = 0; i < 40 && w.bg.link.status().state !== 'suspended'; i++)
      await w.advance(31_000);
    const status = w.bg.link.status();
    expect(status.state).toBe('suspended');
    expect(status.closeReason).toBe('host_not_found');
    expect(w.ext.nativePorts.length).toBe(5);
    const before = w.ext.nativePorts.length;
    await w.advance(120_000);
    expect(w.ext.nativePorts.length).toBe(before);
    await w.advance(200_000);
    expect(w.ext.nativePorts.length).toBeGreaterThan(before);
  });

  it('classifies disconnect texts', async () => {
    const w = await new World().boot();
    w.ext
      .lastNativePort()
      .hostDisconnect('Access to the specified native messaging host is forbidden.');
    await w.settle(2);
    expect(w.bg.link.status().closeReason).toBe('forbidden');
  });

  it('reconnectNow resets backoff and the flapping guard', async () => {
    const w = await new World().boot();
    w.bg.link.reconnectNow();
    await w.settle();
    expect(w.ext.nativePorts).toHaveLength(2);
    expect(w.bg.link.isReady()).toBe(true);
  });
});

describe('idle policy', () => {
  it('closes the port after 60 s with nothing to do, and not while work is desired', async () => {
    const w = await new World().boot();
    await w.advance(61_000);
    expect(w.bg.link.status().state).toBe('idle');
    expect(w.ext.nativePorts[0]?.disconnectedByExtension).toBe(true);
    expect(w.bg.link.status().closeReason).toBe('idle');
    expect(w.daemons[0]?.sent('bye')[0]?.body).toEqual({ reason: 'idle_timeout' });
    expect(w.daemons[0]?.violations).toEqual([]);
    // no reconnect storm after an idle close
    await w.advance(120_000);
    expect(w.ext.nativePorts).toHaveLength(1);
  });

  it('stays connected while an approval is pending and keeps the reconnect alarm', async () => {
    const w = await new World().boot();
    w.daemon.send('approval.pending', { approval: pendingApproval() });
    await w.settle();
    expect(await w.bg.store.getDesired()).toBe(true);
    expect(w.ext.alarms.get('zeus-reconnect')).toEqual({ periodInMinutes: 0.5 });
    await w.advance(120_000);
    expect(w.ext.nativePorts).toHaveLength(1);
    expect(w.bg.link.isReady()).toBe(true);
  });

  it('does not stay connected for agent downloads that need nothing from the browser', async () => {
    const w = await new World().boot();
    w.daemon.send('job.event', jobCreated(901, jobIdOf(9), { kind: 'agent', via: 'mcp' }));
    await w.advance(61_000);
    expect(w.bg.jobs.hasActive()).toBe(true);
    expect(w.bg.link.status().state).toBe('idle');
  });

  it('stays connected while a job waits for the extension or came from this browser', async () => {
    const w = await new World().boot();
    w.daemon.send('job.event', jobCreated(902, jobIdOf(8), { kind: 'agent', via: 'mcp' }));
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 903,
        ts: '2026-10-05T10:00:01.000Z',
        type: 'job.state_changed',
        job_id: jobIdOf(8),
        data: {
          from: 'probing',
          to: 'awaiting_session',
          transition: 'S12',
          cause: 'session_needed',
          actor: { kind: 'engine' },
        },
      },
    });
    await w.advance(120_000);
    expect(w.bg.link.isReady()).toBe(true);
    expect(await w.bg.store.getDesired()).toBe(true);
  });

  it('reconnects from the alarm when work is still desired', async () => {
    const w = await new World().boot();
    w.daemon.send('approval.pending', { approval: pendingApproval() });
    await w.settle();
    w.ext.lastNativePort().hostDisconnect('Native host has exited.');
    w.bg.link.stop('stopped');
    expect(w.bg.link.status().state).toBe('idle');
    w.ext.onAlarm.emit({ name: 'zeus-reconnect' });
    await w.settle();
    expect(w.ext.nativePorts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('request correlation and limits', () => {
  it('times out an unanswered request with nm.timeout', async () => {
    const w = await new World().boot();
    w.daemon.ignore('job.list');
    const pending = w.bg.link.request('job.list', {});
    const outcome = pending.then(
      () => 'resolved',
      (e: unknown) =>
        (e as { envelope: { code: string; class: string; retryable: boolean } }).envelope,
    );
    await w.advance(10_100);
    expect(await outcome).toMatchObject({ code: 'nm.timeout', class: 'timeout', retryable: true });
  });

  it('rejects requests whose capability the daemon did not negotiate', async () => {
    const w = await new World({ daemon: { capabilities: ['handoff', 'session'] } }).boot();
    await expect(w.bg.link.request('job.list', {})).rejects.toMatchObject({
      envelope: { code: 'nm.capability_missing', details: { capability: 'job_control' } },
    });
  });

  it('turns an error frame into a rejection carrying the envelope', async () => {
    const w = await new World().boot();
    w.daemon.on('job.list', (f, d) => {
      d.reply(f, 'error', {
        error: {
          code: 'nm.rate_limited',
          class: 'unavailable',
          message: 'slow down',
          retryable: true,
          details: { retry_after_ms: 500 },
        },
      });
    });
    await expect(w.bg.link.request('job.list', {})).rejects.toMatchObject({
      envelope: { code: 'nm.rate_limited' },
    });
  });

  it('refuses to send a frame above the daemon-bound limit', async () => {
    const w = await new World({ daemon: { limits: { max_frame_to_daemon_bytes: 4096 } } }).boot();
    const sent = w.bg.link.send('handoff.withdraw', {
      job_id: 'job_01M45NHJ2AHWMXT8JVJ7BEEJX7',
      offer_key: 'x'.repeat(190),
      reason: 'completed_in_browser',
    });
    expect(sent).toBe(true); // small enough
    await expect(
      w.bg.link.request('handoff.offer', {
        offer_key: 'k',
        trigger: 'user_initiated',
        download: bigDownload(5000),
        validators: null,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'nm.frame_too_large' } });
  });

  it('fails pending requests when the connection closes', async () => {
    const w = await new World().boot();
    w.daemon.ignore('job.list');
    const pending = w.bg.link.request('job.list', {});
    const outcome = pending.then(
      () => 'resolved',
      (e: unknown) => (e as { envelope: { code: string } }).envelope.code,
    );
    w.ext.lastNativePort().hostDisconnect('Native host has exited.');
    await w.settle(2);
    expect(await outcome).toBe('nm.timeout');
  });
});

describe('malformed and unknown frames (spec 02 section 6.4, 13.2)', () => {
  it('answers a schema violation with nm.schema_violation and keeps the connection', async () => {
    const w = await new World().boot();
    w.daemon.raw({ v: 1, id: 'd50', type: 'fetch.credit', body: { stream_id: 's1', credits: 0 } });
    await w.settle();
    const err = w.daemon.sent('error').at(-1);
    expect(err?.re).toBe('d50');
    expect(
      (err?.body as { error: { code: string; details?: { errors: string } } }).error.code,
    ).toBe('nm.schema_violation');
    expect(w.bg.link.isReady()).toBe(true);
    expect(w.daemon.violations).toEqual([]);
  });

  it('answers an unknown request type with nm.unknown_type and ignores unknown responses', async () => {
    const w = await new World().boot();
    w.daemon.raw({ v: 1, id: 'd51', type: 'mystery.thing', body: {} });
    w.daemon.raw({ v: 1, id: 'd52', re: 'e9', type: 'mystery.reply', body: {} });
    await w.settle();
    const errors = w.daemon.sent('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.re).toBe('d51');
    expect((errors[0]?.body as { error: { code: string } }).error.code).toBe('nm.unknown_type');
  });

  it('closes with bye protocol_error after ten violations in a minute', async () => {
    const w = await new World().boot();
    const daemon = w.daemon;
    for (let i = 0; i < 10; i++) daemon.raw({ v: 1, id: `x${i}`, type: 'fetch.credit', body: {} });
    expect(daemon.sent('bye')[0]?.body).toMatchObject({ reason: 'protocol_error' });
    expect(w.ext.nativePorts[0]?.disconnectedByExtension).toBe(true);
    expect(daemon.sent('error')).toHaveLength(9);
  });

  it('ignores non-object garbage without crashing', async () => {
    const w = await new World().boot();
    w.daemon.raw('hello');
    w.daemon.raw(null);
    w.daemon.raw([1, 2]);
    await w.settle();
    expect(w.bg.link.isReady()).toBe(true);
  });

  it('reconnects after the daemon says bye shutdown, and not after superseded', async () => {
    const w = await new World().boot();
    w.daemon.send('bye', { reason: 'shutdown' });
    await w.settle(2);
    expect(w.bg.link.status().closeReason).toBe('daemon_gone');
    await w.advance(1_000);
    expect(w.ext.nativePorts).toHaveLength(2);
    w.daemon.send('bye', { reason: 'superseded' });
    await w.advance(5_000);
    expect(w.bg.link.status().state).toBe('idle');
    expect(w.ext.nativePorts).toHaveLength(2);
  });
});

it('connects to the registered host name', async () => {
  const w = await new World().boot();
  expect(HOST_NAME).toBe('dev.zeus.native_host');
  expect(w.ext.nativePorts).toHaveLength(1);
});

function pendingApproval() {
  return withBinding({
    id: 'ap_01M45NHJ2AHWMXT8JVJ7BEEJ01',
    kind: 'handoff',
    state: 'pending',
    job_id: 'job_01M45NHJ2AHWMXT8JVJ7BEEJ01',
    origin: 'https://portal.example.org',
    allowed_scopes: ['once', 'site', 'never'],
    reason_codes: ['handoff.interrupted'],
    summary: {
      title: 'dataset.tar.zst',
      url_redacted: 'https://portal.example.org/download/1',
      total_bytes: 10,
      source_kind: 'browser_handoff',
    },
    created_at: '2026-10-05T09:15:30.301Z',
    expires_at: '2026-10-06T09:15:30.301Z',
    decided_at: null,
  });
}

function bigDownload(size: number) {
  return {
    browser_download_id: 1,
    url: 'https://a.example/x',
    final_url: 'https://a.example/x',
    referrer: null,
    filename: 'x'.repeat(Math.min(size, 255)),
    mime: 'x'.repeat(255),
    bytes_received: 0,
    total_bytes: null,
    start_time: '2026-10-05T09:15:12.004Z',
    incognito: false,
    can_resume: false,
    interrupt_reason: null,
    by_extension_id: 'y'.repeat(128),
    // not part of the schema but allowed (unknown keys): pads the frame past the limit
    padding: 'p'.repeat(size),
  };
}

function jobIdOf(n: number): string {
  return `job_01M45NHJ2AHWMXT8JVJ7BEEJ0${n}`;
}

function jobCreated(seq: number, id: string, source: Record<string, unknown>) {
  return {
    subscription_id: 'sub1',
    event: {
      seq,
      ts: '2026-10-05T10:00:00.000Z',
      type: 'job.created',
      job_id: id,
      data: {
        source,
        state: 'queued',
        url_redacted: 'https://a.example/x',
        priority: 'normal',
      },
    },
  };
}
