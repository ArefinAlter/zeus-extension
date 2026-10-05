import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POPUP_PORT_NAME,
  parseUiRequest,
  type Snapshot,
  type UiResponse,
} from '../../src/lib/ui-protocol';
import { approvalId, grantId, jobId } from '../helpers/ids';
import { World } from '../harness/world';

const ORIGIN = 'https://portal.example.org';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function approval(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...over,
  };
}

function grant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...over,
  };
}

/** Make the daemon answer approval.decide the way zeusd would for an approve or deny. */
function daemonDecides(
  w: World,
  grantOver: Record<string, unknown> | null = {},
  approvalOver: Record<string, unknown> = {},
): void {
  w.daemon.on('approval.decide', (f, d) => {
    const decision = f.body.decision as string;
    const scope = f.body.scope as string | undefined;
    const decided = approval({
      state: decision === 'approve' ? 'approved' : 'denied',
      decided_at: '2026-10-05T09:15:34.870Z',
      decision: {
        outcome: decision,
        ...(scope ? { scope } : {}),
        actor: { kind: 'human', surface: 'extension_popup' },
      },
      ...approvalOver,
    });
    d.reply(
      f,
      'approval.decide.response',
      grantOver === null
        ? { approval: decided }
        : { approval: decided, grant: grant({ scope: scope ?? 'site', ...grantOver }) },
    );
  });
}

async function showApproval(w: World, over: Record<string, unknown> = {}): Promise<void> {
  w.daemon.send('approval.pending', { approval: approval(over) });
  await w.settle();
}

const decide = (w: World, over: Record<string, unknown> = {}) =>
  w.ext.sendFromPage({
    cmd: 'approval.decide',
    approval_id: approvalId(1),
    decision: 'approve',
    scope: 'site',
    user_gesture: true,
    surface: 'extension_popup',
    ...over,
  }) as Promise<UiResponse>;

async function snapshot(w: World): Promise<Snapshot> {
  const r = (await w.ext.sendFromPage({ cmd: 'snapshot' })) as UiResponse<Snapshot>;
  if (!r.ok) throw new Error('snapshot failed');
  return r.data;
}

describe('showing approvals', () => {
  it('lists a pending approval, notifies once and sets the badge', async () => {
    const w = await new World().boot();
    await showApproval(w);
    const snap = await snapshot(w);
    expect(snap.approvals).toHaveLength(1);
    expect(snap.approvals[0]?.summary.title).toBe('dataset-v3.tar.zst');
    expect(w.ext.notificationsShown).toHaveLength(1);
    expect(w.ext.notificationsShown[0]?.spec.title).toBe('Zeus needs your decision');
    expect(w.ext.notificationsShown[0]?.spec.message).toContain('dataset-v3.tar.zst');
    expect(w.ext.notificationsShown[0]?.spec.message).toContain(ORIGIN);
    expect(w.ext.notificationsShown[0]?.spec.requireInteraction).toBe(true);
    // a replay after reconnect (spec 02 section 5) does not notify again
    w.ext.lastNativePort().hostDisconnect('Native host has exited.');
    await w.advance(1_500);
    await showApproval(w);
    expect(w.ext.notificationsShown).toHaveLength(1);
    expect(w.missingKeys()).toEqual([]);
  });

  it('leaves out notification options Firefox does not implement', async () => {
    const w = await new World({
      ext: {
        isFirefox: true,
        userAgentData: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0',
      },
    }).boot();
    await showApproval(w);
    expect(w.ext.notificationsShown).toHaveLength(1);
    expect(w.ext.notificationsShown[0]?.spec).not.toHaveProperty('requireInteraction');
  });

  it('removes an approval decided elsewhere (TUI, CLI) when the event arrives', async () => {
    const w = await new World().boot();
    await showApproval(w);
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 200,
        ts: '2026-10-05T09:16:00.000Z',
        type: 'approval.decided',
        job_id: jobId(1),
        data: {
          approval_id: approvalId(1),
          kind: 'handoff',
          outcome: 'deny',
          actor: { kind: 'human', surface: 'tui' },
        },
      },
    });
    await w.settle();
    expect((await snapshot(w)).approvals).toHaveLength(0);
  });

  it('shows remote text only as sanitised data, never as markup', async () => {
    const w = await new World().boot();
    await showApproval(w, {
      summary: {
        title: `<img src=x onerror=alert(1)>${String.fromCodePoint(0x202e)}fdp.exe`,
        source_kind: 'browser_handoff',
      },
    });
    const snap = await snapshot(w);
    expect(snap.approvals[0]?.summary.title).toContain('<img'); // raw data stays raw in the snapshot; pages use textContent
    const note = w.ext.notificationsShown[0]?.spec.message ?? '';
    expect(note).not.toContain(String.fromCodePoint(0x202e));
  });
});

describe('deciding (spec 02 section 10.1)', () => {
  it('approve: needs the browser permission first, then sends a gesture-attested decision and keeps a consent record', async () => {
    const w = await new World().boot();
    daemonDecides(w);
    await showApproval(w);

    const blocked = await decide(w);
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'approval.browser_permission_required' },
    });
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);

    w.ext.grant(ORIGIN); // the popup's permissions.request was granted
    const result = await decide(w);
    expect(result).toMatchObject({
      ok: true,
      data: { approval_id: approvalId(1), state: 'approved', granted: true },
    });
    const frame = w.daemon.sent('approval.decide')[0];
    expect(frame?.body).toEqual({
      approval_id: approvalId(1),
      decision: 'approve',
      scope: 'site',
      ui: { surface: 'extension_popup', user_gesture: true },
    });
    expect(w.daemon.violations).toEqual([]);

    const consent = await w.bg.store.listConsent();
    expect(consent).toEqual([
      {
        grant_id: grantId(1),
        origin: ORIGIN,
        scope: 'site',
        expires_at_ms: Date.parse('2026-10-06T09:15:34.870Z'),
        source: 'ui',
      },
    ]);
    expect((await snapshot(w)).approvals).toHaveLength(0);
    // the consent record holds no cookie and no URL
    expect(w.ext.local.dump()).not.toMatch(/cookie|download\/8841/i);
  });

  it('once: records the job the grant is bound to', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    daemonDecides(w, { job_id: jobId(1), expires_at: '2026-10-06T09:15:34.870Z' });
    await showApproval(w);
    await decide(w, { scope: 'once' });
    expect((await w.bg.store.listConsent())[0]).toMatchObject({ scope: 'once', job_id: jobId(1) });
  });

  it('deny with never: keeps a local never entry so later releases are refused', async () => {
    const w = await new World().boot();
    daemonDecides(w, { scope: 'never', expires_at: null });
    await showApproval(w);
    const result = await decide(w, { decision: 'deny', scope: 'never' });
    expect(result).toMatchObject({ ok: true, data: { state: 'denied' } });
    expect(await w.bg.store.listNever()).toEqual([
      { origin: ORIGIN, grant_id: grantId(1), created_at_ms: expect.any(Number) },
    ]);
    expect(await w.bg.store.listConsent()).toEqual([]);
    const gate = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: ORIGIN,
      url: `${ORIGIN}/x`,
      job_id: jobId(1),
    });
    expect(gate).toMatchObject({ ok: false, error: { code: 'policy.origin_never' } });
  });

  it('plain deny creates no record', async () => {
    const w = await new World().boot();
    daemonDecides(w, null);
    await showApproval(w);
    expect(await decide(w, { decision: 'deny', scope: undefined })).toMatchObject({ ok: true });
    expect(await w.bg.store.listConsent()).toEqual([]);
    expect(await w.bg.store.listNever()).toEqual([]);
    expect(w.daemon.sent('approval.decide')[0]?.body).not.toHaveProperty('scope');
  });

  it('kinds without scopes (retry escalation) are a plain yes or no and need no browser access', async () => {
    const w = await new World().boot();
    daemonDecides(w, null);
    await showApproval(w, {
      kind: 'retry_escalation',
      allowed_scopes: [],
      origin: ORIGIN,
      reason_codes: ['retry.exhausted'],
    });
    const result = await decide(w, { scope: undefined });
    expect(result).toMatchObject({ ok: true });
    expect(w.daemon.sent('approval.decide')[0]?.body).toEqual({
      approval_id: approvalId(1),
      decision: 'approve',
      ui: { surface: 'extension_popup', user_gesture: true },
    });
  });

  it('refuses a decision without a click', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    daemonDecides(w);
    await showApproval(w);
    expect(await decide(w, { user_gesture: false })).toMatchObject({
      ok: false,
      error: { code: 'nm.user_gesture_required' },
    });
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
  });

  it('refuses scopes the approval does not allow, and approve with never', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    daemonDecides(w);
    await showApproval(w);
    expect(await decide(w, { scope: 'workflow' })).toMatchObject({
      ok: false,
      error: { code: 'nm.schema_violation' },
    });
    expect(await decide(w, { scope: 'never' })).toMatchObject({ ok: false });
    expect(await decide(w, { scope: undefined })).toMatchObject({ ok: false });
    expect(await decide(w, { decision: 'deny', scope: 'site' })).toMatchObject({ ok: false });
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
  });

  it('refuses an approval it never showed, or one that expired', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    daemonDecides(w);
    expect(await decide(w)).toMatchObject({ ok: false, error: { code: 'nm.conflict' } });
    await showApproval(w, { expires_at: '2026-10-05T09:16:00.000Z' });
    await w.advance(120_000);
    expect(await decide(w)).toMatchObject({ ok: false, error: { code: 'nm.conflict' } });
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
  });

  it('forgets an approval the daemon says was already decided', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    w.daemon.on('approval.decide', (f, d) => {
      d.reply(f, 'error', {
        error: {
          code: 'nm.conflict',
          class: 'conflict',
          message: 'already decided',
          retryable: false,
        },
      });
    });
    await showApproval(w);
    expect(await decide(w)).toMatchObject({ ok: false, error: { code: 'nm.conflict' } });
    expect((await snapshot(w)).approvals).toHaveLength(0);
  });

  it('cannot decide when the daemon lacks the approvals capability', async () => {
    const w = await new World({ daemon: { capabilities: ['handoff', 'session'] } }).boot();
    w.ext.grant(ORIGIN);
    await showApproval(w);
    expect(await decide(w)).toMatchObject({ ok: false, error: { code: 'nm.capability_missing' } });
  });
});

describe("only the extension's own pages can command the trust surface (spec 02 section 10.2)", () => {
  const body = {
    cmd: 'approval.decide',
    approval_id: approvalId(1),
    decision: 'approve',
    scope: 'site',
    user_gesture: true,
    surface: 'extension_popup',
  };

  it('ignores messages from foreign extensions, web pages and content scripts', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    daemonDecides(w);
    await showApproval(w);
    const foreign = [
      {
        id: 'otherextensionidotherextensionid',
        url: 'chrome-extension://otherextensionidotherextensionid/page.html',
      },
      { id: w.ext.id, url: 'https://evil.example/page.html' }, // a content script running in a web page
      { id: w.ext.id },
      { url: `chrome-extension://${w.ext.id}/popup/popup.html` },
      { id: w.ext.id, url: `chrome-extension://${w.ext.id}.evil.example/x` },
      {},
    ];
    for (const sender of foreign) {
      expect(await w.ext.sendFromPage(body, sender)).toBeUndefined();
    }
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
    expect((await snapshot(w)).approvals).toHaveLength(1);
  });

  it("answers the extension's own options page as well as the popup", async () => {
    const w = await new World().boot();
    const reply = await w.ext.sendFromPage(
      { cmd: 'snapshot' },
      { id: w.ext.id, url: w.ext.api.runtime.getURL('options/options.html'), tabId: 12 },
    );
    expect(reply).toMatchObject({ ok: true });
  });

  it('rejects malformed commands without side effects', async () => {
    const w = await new World().boot();
    for (const bad of [
      null,
      'x',
      { cmd: 'nope' },
      { cmd: 'approval.decide' },
      { ...body, surface: 'extension_notification' },
      { ...body, user_gesture: 'yes' },
      { cmd: 'job.control', job_id: 'x', action: 'format-disk' },
    ]) {
      const reply = await w.ext.sendFromPage(bad);
      expect(reply).toMatchObject({ ok: false, error: { code: 'nm.schema_violation' } });
    }
    expect(parseUiRequest(body)).not.toBeNull();
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
  });

  it('has no content script or external messaging path that could reach the handler', async () => {
    const w = await new World().boot();
    // the only message listeners are the extension's own runtime.onMessage and the popup port
    expect(w.ext.onMessage.listeners).toHaveLength(1);
    const port = new (await import('../harness/mock-ext')).MockPagePort(POPUP_PORT_NAME, {
      id: 'someoneelse',
      url: 'https://evil.example/',
    });
    w.ext.onConnect.emit(port);
    expect(port.connected).toBe(false); // refused and closed
  });
});

describe('consent from events decided in the TUI or CLI (spec 02 section 10.2 (b))', () => {
  function grantCreated(seq: number, g: Record<string, unknown>): Record<string, unknown> {
    return {
      subscription_id: 'sub1',
      event: { seq, ts: '2026-10-05T09:16:00.000Z', type: 'grant.created', data: { grant: g } },
    };
  }

  it('creates a local consent record for an approval it displayed, and asks for the browser permission', async () => {
    const w = await new World().boot();
    await showApproval(w);
    w.daemon.send(
      'job.event',
      grantCreated(300, grant({ decided_by: { kind: 'human', surface: 'tui' } })),
    );
    await w.settle();
    expect(await w.bg.store.listConsent()).toEqual([
      {
        grant_id: grantId(1),
        origin: ORIGIN,
        scope: 'site',
        expires_at_ms: Date.parse('2026-10-06T09:15:34.870Z'),
        source: 'event',
      },
    ]);
    expect(w.ext.notificationsShown.map((n) => n.spec.title)).toContain(
      'Zeus needs browser access',
    );
    // without the browser permission nothing can be released
    const gate = await w.bg.gate.evaluate({
      kind: 'fetch',
      origin: ORIGIN,
      url: `${ORIGIN}/x`,
      job_id: jobId(1),
    });
    expect(gate).toMatchObject({ ok: false, reason: 'no_browser_permission' });
    const snap = await snapshot(w);
    expect(snap.consent[0]?.has_browser_permission).toBe(false);
  });

  it('ignores grants for approvals it never displayed and grants not decided by a human', async () => {
    const w = await new World().boot();
    w.daemon.send(
      'job.event',
      grantCreated(
        301,
        grant({ approval_id: approvalId(7), decided_by: { kind: 'human', surface: 'tui' } }),
      ),
    );
    await showApproval(w);
    w.daemon.send(
      'job.event',
      grantCreated(302, grant({ id: grantId(2), decided_by: { kind: 'agent', surface: 'mcp' } })),
    );
    w.daemon.send(
      'job.event',
      grantCreated(303, grant({ id: grantId(3), decided_by: { kind: 'engine' } })),
    );
    await w.settle();
    expect(await w.bg.store.listConsent()).toEqual([]);
  });

  it('records a never grant decided in the CLI as a never entry', async () => {
    const w = await new World().boot();
    await showApproval(w);
    w.daemon.send(
      'job.event',
      grantCreated(
        304,
        grant({
          scope: 'never',
          expires_at: null,
          decided_by: { kind: 'human', surface: 'cli_interactive' },
        }),
      ),
    );
    await w.settle();
    expect((await w.bg.store.listNever()).map((n) => n.origin)).toEqual([ORIGIN]);
  });

  it('drops consent and never entries when the grant is revoked or expires, and when a once job ends', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 1e9,
      source: 'ui',
    });
    await w.bg.store.putConsent({
      grant_id: grantId(2),
      origin: ORIGIN,
      scope: 'once',
      job_id: jobId(5),
      expires_at_ms: w.clock.now() + 1e9,
      source: 'ui',
    });
    await w.bg.store.putNever({
      origin: 'https://bad.example',
      grant_id: grantId(3),
      created_at_ms: 1,
    });
    const ev = (seq: number, type: string, data: Record<string, unknown>, job?: string) => ({
      subscription_id: 'sub1',
      event: { seq, ts: '2026-10-05T09:20:00.000Z', type, ...(job ? { job_id: job } : {}), data },
    });
    w.daemon.send(
      'job.event',
      ev(
        400,
        'job.state_changed',
        {
          from: 'downloading',
          to: 'completed',
          transition: 'S80',
          cause: 'finalized',
          actor: { kind: 'engine' },
        },
        jobId(5),
      ),
    );
    await w.settle();
    expect((await w.bg.store.listConsent()).map((c) => c.grant_id)).toEqual([grantId(1)]);
    w.daemon.send(
      'job.event',
      ev(401, 'grant.revoked', {
        grant_id: grantId(1),
        origin: ORIGIN,
        by: { kind: 'human', surface: 'tui' },
      }),
    );
    w.daemon.send(
      'job.event',
      ev(402, 'grant.expired', { grant_id: grantId(3), origin: 'https://bad.example' }),
    );
    await w.settle();
    expect(await w.bg.store.listConsent()).toEqual([]);
    expect(await w.bg.store.listNever()).toEqual([]);
  });

  it('revoking from the popup removes the local consent immediately', async () => {
    const w = await new World().boot();
    w.ext.grant(ORIGIN);
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 1e9,
      source: 'ui',
    });
    w.daemon.on('grant.revoke', (f, d) => {
      d.reply(f, 'grant.revoke.response', {
        grant: grant({ state: 'revoked', revoked_at: '2026-10-05T10:00:00.000Z' }),
      });
    });
    expect(await w.ext.sendFromPage({ cmd: 'grant.revoke', grant_id: grantId(1) })).toMatchObject({
      ok: true,
    });
    expect(await w.bg.store.listConsent()).toEqual([]);
    expect(w.daemon.violations).toEqual([]);
  });
});

describe('popup lifecycle', () => {
  it('turns progress events on while the popup is open and off when it closes', async () => {
    const w = await new World().boot();
    expect(
      (w.daemon.sent('events.subscribe')[0]?.body as { include_progress: boolean })
        .include_progress,
    ).toBe(false);
    const { MockPagePort } = await import('../harness/mock-ext');
    const port = new MockPagePort(POPUP_PORT_NAME, {
      id: w.ext.id,
      url: w.ext.api.runtime.getURL('popup/popup.html'),
    });
    w.ext.onConnect.emit(port);
    await w.settle();
    expect(w.daemon.sent('events.subscribe').at(-1)?.body).toMatchObject({
      include_progress: true,
      scope: 'all',
    });
    port.close();
    await w.settle();
    expect(w.daemon.sent('events.subscribe').at(-1)?.body).toMatchObject({
      include_progress: false,
    });
  });

  it('pushes a changed message to an open popup when state changes', async () => {
    const w = await new World().boot();
    const { MockPagePort } = await import('../harness/mock-ext');
    const port = new MockPagePort(POPUP_PORT_NAME, {
      id: w.ext.id,
      url: w.ext.api.runtime.getURL('popup/popup.html'),
    });
    w.ext.onConnect.emit(port);
    await showApproval(w);
    expect(port.posted).toContainEqual({ type: 'changed' });
  });

  it('keeps the native port open while the popup is open', async () => {
    const w = await new World().boot();
    const { MockPagePort } = await import('../harness/mock-ext');
    const port = new MockPagePort(POPUP_PORT_NAME, {
      id: w.ext.id,
      url: w.ext.api.runtime.getURL('popup/popup.html'),
    });
    w.ext.onConnect.emit(port);
    await w.advance(130_000);
    expect(w.bg.link.isReady()).toBe(true);
    port.close();
    await w.advance(130_000);
    expect(w.bg.link.status().state).toBe('idle');
  });
});

describe('badge', () => {
  it('shows the number of pending approvals and a warning when the host is missing', async () => {
    const badge: string[] = [];
    const w = new World();
    w.ext.api.action.setBadgeText = (text) => {
      badge.push(text);
      return Promise.resolve();
    };
    await w.boot();
    await showApproval(w);
    await w.advance(200);
    expect(badge.at(-1)).toBe('1');
    const broken = new World({ noDaemon: true });
    const marks: string[] = [];
    broken.ext.api.action.setBadgeText = (text) => {
      marks.push(text);
      return Promise.resolve();
    };
    broken.ext.connectNativeFailure = 'Specified native messaging host not found.';
    await broken.boot();
    await broken.advance(500);
    expect(marks.at(-1)).toBe('!');
  });
});
