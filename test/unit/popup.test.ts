import { cloudApproval, withBinding } from '../helpers/approvals';
// @vitest-environment happy-dom
// The popup and options pages run against the real background worker (wired to a scripted daemon
// in the World harness) in a DOM environment: what a person sees, and what a click sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOptions } from '../../src/options/app';
import { mountPopup } from '../../src/popup/app';
import { approvalId, grantId, jobId } from '../helpers/ids';
import { World } from '../harness/world';

const ORIGIN = 'https://portal.example.org';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  for (const [tag, id] of [
    ['span', 'status'],
    ['main', 'app'],
    ['a', 'open-options'],
  ] as const) {
    const el = document.createElement(tag);
    el.id = id;
    document.body.append(el);
  }
});
afterEach(() => {
  vi.useRealTimers();
});

function pendingApproval(over: Record<string, unknown> = {}): Record<string, unknown> {
  return withBinding({
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
  });
}

const app = (): HTMLElement => document.getElementById('app') as HTMLElement;
const text = (): string => app().textContent;
const buttons = (): HTMLButtonElement[] => [...app().querySelectorAll('button')];
const button = (label: string): HTMLButtonElement => {
  const found = buttons().find((b) => b.textContent === label);
  if (!found)
    throw new Error(
      `no button "${label}" among ${buttons()
        .map((b) => b.textContent)
        .join(' | ')}`,
    );
  return found;
};

/** A click the browser would call trusted. (A scripted click has isTrusted false.) */
function trustedClick(el: HTMLElement): void {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  el.dispatchEvent(event);
}

async function flush(w: World): Promise<void> {
  await w.settle(8);
}

async function showApproval(w: World, over: Record<string, unknown> = {}): Promise<void> {
  w.daemon.send('approval.pending', { approval: pendingApproval(over) });
  await flush(w);
  await w.advance(800);
}

describe('popup: approvals', () => {
  it('directs cloud review to the terminal without offering browser decisions', async () => {
    const w = await new World().boot();
    w.daemon.send('approval.pending', { approval: cloudApproval() });
    await flush(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(text()).toContain('Deliver to cloud storage');
    expect(text()).toContain('Review this cloud delivery in an interactive Zeus terminal.');
    expect(buttons()).toHaveLength(0);
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
    expect(w.missingKeys()).toEqual([]);
  });

  it('preserves an unchanged armed review across progress refreshes and rearms changed facts', async () => {
    const w = await new World().boot();
    await showApproval(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    const original = button('Allow once');
    expect(original.disabled).toBe(true);
    await w.advance(800);
    expect(original.disabled).toBe(false);
    await popup.refresh();
    expect(button('Allow once')).toBe(original);
    expect(original.disabled).toBe(false);
    w.daemon.send('approval.pending', { approval: pendingApproval({ revision: 2 }) });
    await flush(w);
    await popup.refresh();
    expect(button('Allow once')).not.toBe(original);
    expect(button('Allow once').disabled).toBe(true);
  });

  it('shows the daemon-computed facts and one button per allowed decision', async () => {
    const w = await new World().boot();
    await showApproval(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(document.getElementById('status')?.textContent).toBe('Connected to Zeus');
    expect(text()).toContain('Finish a failed download');
    expect(text()).toContain('dataset-v3.tar.zst');
    expect(text()).toContain(ORIGIN);
    expect(text()).toContain('1.20 GiB');
    expect(text()).toContain('this browser');
    expect(text()).toContain('Your browser’s download was interrupted.');
    expect(text()).toContain('reads your cookies for this site only');
    expect(buttons().map((b) => b.textContent)).toEqual([
      'Allow once',
      'Allow this site for 24 hours',
      'Don’t allow',
      'Never for this site',
    ]);
    expect(w.missingKeys()).toEqual([]);
  });

  it('asks the browser for the site permission inside the click, then sends the attested decision', async () => {
    const w = await new World().boot();
    w.daemon.on('approval.decide', (f, d) => {
      d.reply(f, 'approval.decide.response', {
        approval: pendingApproval({
          state: 'approved',
          decided_at: '2026-10-05T09:15:34.870Z',
          decision: {
            outcome: 'approve',
            scope: 'site',
            actor: { kind: 'human', surface: 'extension_popup' },
            grant_id: grantId(1),
          },
        }),
        grant: {
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
        },
      });
    });
    await showApproval(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);

    trustedClick(button('Allow this site for 24 hours'));
    await flush(w);

    expect(w.ext.permissionRequests).toEqual([
      { permissions: ['cookies'], origins: [`${ORIGIN}/*`] },
    ]);
    const decide = w.daemon.sent('approval.decide')[0];
    expect(decide?.body).toMatchObject({
      approval_id: approvalId(1),
      decision: 'approve',
      scope: 'site',
      ui: { surface: 'extension_popup', user_gesture: true },
    });
    expect(await w.bg.store.listConsent()).toHaveLength(1);
    expect(text()).not.toContain('Finish a failed download'); // the card is gone
  });

  it('sends nothing when the user declines the browser permission', async () => {
    const w = await new World().boot();
    w.ext.grantOnRequest = () => false;
    await showApproval(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    trustedClick(button('Allow once'));
    await flush(w);
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
    expect(text()).toContain('The browser did not grant access, so nothing was approved.');
    expect(text()).toContain('Finish a failed download'); // still waiting for a decision
  });

  it('does not claim a gesture for a scripted click, and the background refuses it', async () => {
    const w = await new World().boot();
    await showApproval(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    button('Don’t allow').click(); // element.click() is not a trusted event
    await flush(w);
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
    expect(text()).toContain('A decision needs a click.');
  });

  it('denying with never sends the never scope', async () => {
    const w = await new World().boot();
    w.daemon.on('approval.decide', (f, d) => {
      d.reply(f, 'approval.decide.response', {
        approval: pendingApproval({
          state: 'denied',
          decided_at: '2026-10-05T09:15:34.870Z',
          decision: {
            outcome: 'deny',
            scope: 'never',
            actor: { kind: 'human', surface: 'extension_popup' },
          },
        }),
      });
    });
    await showApproval(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    trustedClick(button('Never for this site'));
    await flush(w);
    expect(w.daemon.sent('approval.decide')[0]?.body).toMatchObject({
      decision: 'deny',
      scope: 'never',
    });
    expect(w.ext.permissionRequests).toEqual([]); // denying needs no browser permission
  });

  it('renders file names from remote servers as text, never as markup', async () => {
    const w = await new World().boot();
    await showApproval(w, {
      summary: {
        title: `<img src=x onerror=alert(1)>${String.fromCodePoint(0x202e)}fdp.exe`,
        source_kind: 'agent',
        requested_by: '<b>trust me</b>',
      },
    });
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(app().querySelector('img')).toBeNull();
    expect(app().querySelector('b')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
    expect(text()).toContain('<b>trust me</b>');
    expect(text()).not.toContain(String.fromCodePoint(0x202e));
    // the requester's own words are labelled as such
    expect(text()).toContain('Requested by (as stated by the requester)');
  });

  it('offers a plain yes or no for approvals without scopes', async () => {
    const w = await new World().boot();
    await showApproval(w, {
      kind: 'retry_escalation',
      allowed_scopes: [],
      reason_codes: ['retry.exhausted', 'url.expired'],
    });
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(buttons().map((b) => b.textContent)).toEqual(['Approve', 'Don’t allow']);
    expect(text()).toContain('A download keeps failing');
    expect(text()).toContain('Zeus used up its automatic retries.');
    expect(text()).not.toContain('reads your cookies'); // no session involved
  });
});

describe('popup: status and lists', () => {
  it('explains a missing host and offers a retry', async () => {
    const w = new World({ noDaemon: true });
    w.ext.connectNativeFailure = 'Specified native messaging host not found.';
    await w.boot();
    await w.advance(300);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(document.getElementById('status')?.textContent).toBe('Zeus app not found');
    expect(document.getElementById('status')?.dataset.tone).toBe('error');
    expect(text()).toContain('run: zeus native-host install');
    const before = w.ext.nativePorts.length;
    button('Try again now').click();
    await flush(w);
    expect(w.ext.nativePorts.length).toBeGreaterThan(before);
  });

  it('shows the empty state when nothing needs attention', async () => {
    const w = await new World().boot();
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(text()).toContain('Nothing needs your attention.');
  });

  it('lists jobs with progress and sends controls the state allows', async () => {
    const w = await new World().boot();
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 600,
        ts: '2026-10-05T10:00:00.000Z',
        type: 'job.created',
        job_id: jobId(1),
        data: {
          source: { kind: 'cli' },
          state: 'queued',
          url_redacted: `${ORIGIN}/f`,
          filename_hint: 'report.pdf',
          priority: 'normal',
        },
      },
    });
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        seq: 601,
        ts: '2026-10-05T10:00:01.000Z',
        type: 'job.state_changed',
        job_id: jobId(1),
        data: {
          from: 'probing',
          to: 'downloading',
          transition: 'S10',
          cause: 'probe_ok',
          actor: { kind: 'engine' },
        },
      },
    });
    w.daemon.send('job.event', {
      subscription_id: 'sub1',
      event: {
        after_seq: 601,
        ts: '2026-10-05T10:00:02.000Z',
        type: 'job.progress',
        job_id: jobId(1),
        data: {
          progress: {
            bytes_done: 512,
            bytes_total: 1024,
            rate_ewma: 1,
            eta_s: 1,
            segments_active: 1,
            last_error_class: null,
            updated_at: '2026-10-05T10:00:02.000Z',
          },
        },
      },
    });
    w.daemon.on('job.control', (f, d) => {
      d.reply(f, 'job.control.response', {
        job: {
          id: jobId(1),
          state: 'paused',
          quarantined: false,
          source_kind: 'cli',
          filename: 'report.pdf',
          url_redacted: `${ORIGIN}/f`,
          bytes_done: 512,
          bytes_total: 1024,
          created_at: '2026-10-05T10:00:00.000Z',
          updated_at: '2026-10-05T10:00:03.000Z',
        },
      });
    });
    await flush(w);
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(text()).toContain('report.pdf');
    expect(text()).toContain('Downloading');
    expect(text()).toContain('512 B / 1.00 KiB');
    const bar = app().querySelector('progress');
    expect(bar?.value).toBe(0.5);
    expect(buttons().map((b) => b.textContent)).toEqual(['Pause', 'Cancel']);
    button('Pause').click();
    await flush(w);
    expect(w.daemon.sent('job.control')[0]?.body).toEqual({ job_id: jobId(1), action: 'pause' });
    expect(text()).toContain('Paused');
    expect(w.daemon.violations).toEqual([]);
  });

  it('lets the user send an interrupted browser download to Zeus, and explains refusals', async () => {
    const w = await new World().boot();
    await w.bg.store.setSettings({ auto_offer: false });
    w.ext.addDownload({
      id: 11,
      state: 'interrupted',
      error: 'NETWORK_FAILED',
      startTime: '2026-10-05T09:00:00.000Z',
    });
    w.ext.addDownload({
      id: 12,
      state: 'interrupted',
      error: 'FILE_BLOCKED',
      startTime: '2026-10-05T09:01:00.000Z',
    });
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(text()).toContain(
      'The browser blocked this file for safety. Zeus will not override that.',
    );
    expect(buttons().filter((b) => b.textContent === 'Finish with Zeus')).toHaveLength(1);
    button('Finish with Zeus').click();
    await flush(w);
    expect(w.daemon.sent('handoff.offer')).toHaveLength(1);
    await popup.refresh();
    await w.advance(800);
    expect(text()).toContain('Sent to Zeus');
  });

  it('asks for browser access when consent exists but the browser permission is missing', async () => {
    const w = await new World().boot();
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 1e9,
      source: 'event',
    });
    const popup = mountPopup(w.ext.api);
    await popup.refresh();
    await w.advance(800);
    expect(text()).toContain('Browser access needed');
    trustedClick(button(`Allow browser access to ${ORIGIN}`));
    await flush(w);
    expect(w.ext.permissionRequests).toEqual([
      { permissions: ['cookies'], origins: [`${ORIGIN}/*`] },
    ]);
    expect(text()).not.toContain('Browser access needed');
  });

  it('opens the options page from the footer link', async () => {
    const w = await new World().boot();
    let opened = 0;
    w.ext.api.runtime.openOptionsPage = () => {
      opened += 1;
      return Promise.resolve();
    };
    mountPopup(w.ext.api);
    document.getElementById('open-options')?.click();
    expect(opened).toBe(1);
  });
});

describe('options page', () => {
  it('shows status facts, lists approved sites with revoke, and toggles settings', async () => {
    const w = await new World().boot();
    await w.bg.store.putConsent({
      grant_id: grantId(1),
      origin: ORIGIN,
      scope: 'site',
      expires_at_ms: w.clock.now() + 3 * 3_600_000,
      source: 'ui',
    });
    await w.bg.store.putNever({
      origin: 'https://bad.example',
      grant_id: grantId(2),
      created_at_ms: 1,
    });
    w.daemon.on('grant.revoke', (f, d) => {
      d.reply(f, 'grant.revoke.response', {
        grant: {
          id: grantId(1),
          origin: ORIGIN,
          scope: 'site',
          state: 'revoked',
          created_at: '2026-10-05T09:15:34.870Z',
          expires_at: '2026-10-06T09:15:34.870Z',
          approval_id: approvalId(1),
          decided_by: { kind: 'human' },
          uses: 0,
          last_used_at: null,
          revoked_at: '2026-10-05T10:00:00.000Z',
          renewable: false,
          renewal_count: 0,
        },
      });
    });
    const page = mountOptions(w.ext.api);
    await page.refresh();
    const body = text();
    expect(body).toContain(w.ext.id);
    expect(body).toContain('0.1.0');
    expect(body).toContain('chrome 141.0.0.0 (win)');
    expect(body).toContain(ORIGIN);
    expect(body).toContain('Site, 24 hours');
    expect(body).toContain('3 h');
    expect(body).toContain('https://bad.example');
    expect(body).toContain('zeus native-host install');
    expect(body).toContain('sends nothing anywhere except to the Zeus app');

    const boxes = [...app().querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event('change'));
    await flush(w);
    expect((await w.bg.store.getSettings()).notifications).toBe(false);

    button('Revoke').click();
    await flush(w);
    expect(w.daemon.sent('grant.revoke')[0]?.body).toEqual({ grant_id: grantId(1) });
    expect(await w.bg.store.listConsent()).toEqual([]);
    expect(w.missingKeys()).toEqual([]);
  });
});
