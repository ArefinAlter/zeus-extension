import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyForward,
  classifyInterrupted,
  classifyInterruptReason,
  toInterruptReason,
} from '../../src/background/classify';
import { buildOfferBody } from '../../src/background/downloads';
import { detectBrowser } from '../../src/lib/browser';
import type { DownloadItem } from '../../src/lib/platform';
import { InterruptReasonValues } from '../helpers/interrupt-reasons';
import { approvalId, jobId } from '../helpers/ids';
import { World } from '../harness/world';

const OWN_ID = 'nfiaihlklfadnbcfadmhbmddabmafilo';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function item(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 317,
    url: 'https://portal.example.org/download/8841',
    finalUrl:
      'https://cdn.example.org/blobs/dataset-v3.tar.zst?X-Amz-Expires=300&X-Amz-Signature=EXAMPLE',
    referrer: 'https://portal.example.org/datasets/v3',
    filename: 'C:\\Users\\ada\\Downloads\\dataset-v3.tar.zst',
    incognito: false,
    danger: 'safe',
    mime: 'application/zstd',
    startTime: '2026-10-05T09:15:12.004Z',
    state: 'interrupted',
    paused: false,
    canResume: false,
    error: 'NETWORK_DISCONNECTED',
    bytesReceived: 402_653_184,
    totalBytes: 1_288_490_188,
    fileSize: 0,
    exists: false,
    ...over,
  };
}

function inProgress(): DownloadItem {
  const running = item({ state: 'in_progress' });
  delete running.error;
  return running;
}

describe('interrupt reason table (spec 01 section 8.4)', () => {
  it('covers every InterruptReason of the protocol schema', () => {
    for (const reason of InterruptReasonValues)
      expect(() => classifyInterruptReason(reason)).not.toThrow();
  });

  it('never offers security decisions, certificate problems, user intent or malformed requests', () => {
    for (const r of [
      'FILE_VIRUS_INFECTED',
      'FILE_BLOCKED',
      'FILE_SECURITY_CHECK_FAILED',
      'SERVER_CERT_PROBLEM',
      'USER_CANCELED',
      'FILE_SAME_AS_SOURCE',
      'NETWORK_INVALID_REQUEST',
      'UNKNOWN',
    ] as const) {
      expect(classifyInterruptReason(r).offer, r).toBe('never');
    }
  });

  it('offers the network and server reasons automatically and the shutdown reasons with low priority', () => {
    for (const r of [
      'NETWORK_FAILED',
      'NETWORK_TIMEOUT',
      'NETWORK_DISCONNECTED',
      'NETWORK_SERVER_DOWN',
      'SERVER_FAILED',
      'SERVER_UNREACHABLE',
      'SERVER_CONTENT_LENGTH_MISMATCH',
      'SERVER_NO_RANGE',
      'SERVER_UNAUTHORIZED',
      'SERVER_FORBIDDEN',
      'SERVER_CROSS_ORIGIN_REDIRECT',
      'FILE_NO_SPACE',
      'FILE_TOO_SHORT',
      'FILE_HASH_MISMATCH',
    ] as const) {
      expect(classifyInterruptReason(r).offer, r).toBe('prompt');
    }
    for (const r of ['SERVER_BAD_CONTENT', 'USER_SHUTDOWN', 'CRASH'] as const) {
      expect(classifyInterruptReason(r).offer, r).toBe('prompt_low_priority');
    }
  });

  it('maps unknown strings to UNKNOWN and absent values to null', () => {
    expect(toInterruptReason('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(toInterruptReason(undefined)).toBeNull();
    expect(toInterruptReason('NETWORK_FAILED')).toBe('NETWORK_FAILED');
  });
});

describe('eligibility', () => {
  it('offers an interrupted http(s) download', () => {
    expect(classifyInterrupted(item(), OWN_ID)).toEqual({
      offer: true,
      trigger: 'interrupted',
      reason: 'NETWORK_DISCONNECTED',
      priority: 'normal',
    });
  });

  it('refuses Safe Browsing and unknown danger verdicts, accepts the benign ones', () => {
    for (const danger of ['content', 'uncommon', 'host', 'unwanted', 'url', 'someNewDangerType']) {
      expect(classifyInterrupted(item({ danger }), OWN_ID), danger).toEqual({
        offer: false,
        why: 'dangerous',
      });
    }
    for (const danger of ['safe', 'accepted', 'file', ''])
      expect(classifyInterrupted(item({ danger }), OWN_ID).offer, danger).toBe(true);
  });

  it('refuses downloads the extension started itself, and non-http URLs', () => {
    expect(classifyInterrupted(item({ byExtensionId: OWN_ID }), OWN_ID)).toEqual({
      offer: false,
      why: 'own_download',
    });
    expect(classifyInterrupted(item({ byExtensionId: 'someoneelse' }), OWN_ID).offer).toBe(true);
    for (const url of [
      'blob:https://a.example/1',
      'data:text/plain,hi',
      'file:///c:/a.zip',
      'ftp://a.example/x',
    ]) {
      expect(classifyInterrupted(item({ url }), OWN_ID)).toEqual({
        offer: false,
        why: 'unsupported_url',
      });
    }
  });

  it('forwarding keeps the security refusals but lets the user hand over a running or user-canceled download', () => {
    expect(classifyForward(item({ error: 'FILE_BLOCKED' }), OWN_ID)).toEqual({
      offer: false,
      why: 'security_decision',
    });
    expect(classifyForward(item({ error: 'SERVER_CERT_PROBLEM' }), OWN_ID)).toEqual({
      offer: false,
      why: 'security_decision',
    });
    expect(classifyForward(inProgress(), OWN_ID)).toEqual({
      offer: true,
      trigger: 'user_initiated',
      reason: null,
      priority: 'normal',
    });
    expect(classifyForward(item({ error: 'USER_CANCELED' }), OWN_ID)).toMatchObject({
      offer: true,
      trigger: 'user_initiated',
      reason: null,
    });
    expect(classifyForward(item({ state: 'complete' }), OWN_ID)).toEqual({
      offer: false,
      why: 'complete',
    });
    expect(classifyForward(item(), OWN_ID)).toMatchObject({
      offer: true,
      trigger: 'interrupted',
      reason: 'NETWORK_DISCONNECTED',
    });
  });
});

describe('buildOfferBody (spec 02 section 7.1)', () => {
  const browser = detectBrowser(new World().ext.api.env);
  const verdict = {
    offer: true as const,
    trigger: 'interrupted' as const,
    reason: 'NETWORK_DISCONNECTED' as const,
    priority: 'normal' as const,
  };

  it('matches the spec example field for field', () => {
    const body = buildOfferBody(item(), verdict, browser, 0);
    expect(body).toEqual({
      offer_key: 'chrome:317:2026-10-05T09:15:12.004Z',
      trigger: 'interrupted',
      download: {
        browser_download_id: 317,
        url: 'https://portal.example.org/download/8841',
        final_url:
          'https://cdn.example.org/blobs/dataset-v3.tar.zst?X-Amz-Expires=300&X-Amz-Signature=EXAMPLE',
        referrer: 'https://portal.example.org/datasets/v3',
        filename: 'dataset-v3.tar.zst',
        mime: 'application/zstd',
        bytes_received: 402_653_184,
        total_bytes: 1_288_490_188,
        start_time: '2026-10-05T09:15:12.004Z',
        incognito: false,
        can_resume: false,
        interrupt_reason: 'NETWORK_DISCONNECTED',
      },
      validators: null,
    });
  });

  it('converts unknown size to null, drops empty referrer and mime, never sends an absolute path', () => {
    const body = buildOfferBody(
      item({ totalBytes: -1, referrer: '', mime: '', filename: '/home/ada/secret dir/report.pdf' }),
      verdict,
      browser,
      0,
    );
    expect(body?.download.total_bytes).toBeNull();
    expect(body?.download.referrer).toBeNull();
    expect(body?.download.mime).toBeNull();
    expect(body?.download.filename).toBe('report.pdf');
    expect(JSON.stringify(body)).not.toMatch(/ada|secret dir/);
  });

  it('normalises the start time to three fractional digits', () => {
    const body = buildOfferBody(item({ startTime: '2026-10-05T09:15:12Z' }), verdict, browser, 0);
    expect(body?.download.start_time).toBe('2026-10-05T09:15:12.000Z');
  });

  it('records which extension started the download', () => {
    const body = buildOfferBody(item({ byExtensionId: 'abc' }), verdict, browser, 0);
    expect(body?.download.by_extension_id).toBe('abc');
  });
});

describe('detectBrowser', () => {
  const env = (userAgent: string, brands: string[] | null) => ({
    userAgent,
    userAgentData: brands
      ? {
          brands: brands.map((brand) => ({ brand, version: '1' })),
          mobile: false,
          platform: 'Windows',
        }
      : null,
    isUserActive: () => true,
    isFirefox: /Firefox/.test(userAgent),
  });
  it('tells the browsers apart', () => {
    expect(
      detectBrowser(
        env('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36', [
          'Chromium',
          'Google Chrome',
        ]),
      ),
    ).toMatchObject({ name: 'chrome', version: '141.0.0.0', platform: 'win' });
    expect(
      detectBrowser(
        env('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57', [
          'Microsoft Edge',
          'Chromium',
        ]),
      ),
    ).toMatchObject({ name: 'edge', version: '141.0.3537.57' });
    expect(
      detectBrowser(
        env('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36', ['Brave', 'Chromium']),
      ),
    ).toMatchObject({ name: 'brave' });
    expect(
      detectBrowser(
        env('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36', ['Chromium']),
      ),
    ).toMatchObject({ name: 'chromium' });
    expect(
      detectBrowser(
        env('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', null),
      ),
    ).toMatchObject({ name: 'firefox', version: '140.0', platform: 'linux' });
    expect(detectBrowser(env('curl/8', null))).toMatchObject({ name: 'other' });
  });
});

describe('rescue flow end to end (spec 02 section 15.1)', () => {
  it('offers an interrupted download and records the accepted job', async () => {
    const w = await new World().boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    const offers = w.daemon.sent('handoff.offer');
    expect(offers).toHaveLength(1);
    expect(offers[0]?.body).toMatchObject({
      offer_key: 'chrome:317:2026-10-05T09:15:12.004Z',
      trigger: 'interrupted',
      download: {
        browser_download_id: 317,
        filename: 'dataset-v3.tar.zst',
        interrupt_reason: 'NETWORK_DISCONNECTED',
        total_bytes: 1_288_490_188,
      },
      validators: null,
    });
    expect(w.daemon.violations).toEqual([]);
    const record = await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z');
    expect(record).toMatchObject({
      status: 'accepted',
      job_id: jobId(1),
      approval_id: approvalId(1),
      download_id: 317,
    });
    // no URL is persisted: the offer is rebuilt from the browser's own item
    expect(w.ext.local.dump()).not.toContain('X-Amz-Signature');
    expect(w.ext.local.dump()).not.toContain('portal.example.org');
  });

  it('does not offer security decisions or user cancellations', async () => {
    const w = await new World().boot();
    let id = 600;
    for (const error of [
      'FILE_VIRUS_INFECTED',
      'FILE_BLOCKED',
      'FILE_SECURITY_CHECK_FAILED',
      'SERVER_CERT_PROBLEM',
      'USER_CANCELED',
    ]) {
      w.ext.addDownload({ id: ++id, state: 'in_progress' });
      w.ext.interrupt(id, error);
    }
    w.ext.addDownload({ id: ++id, state: 'in_progress', danger: 'content' });
    w.ext.interrupt(id, 'NETWORK_FAILED');
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(0);
  });

  it('offers a download once even if the browser reports the change twice', async () => {
    const w = await new World().boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    w.ext.onDownloadChanged.emit({ id: 317, error: { current: 'NETWORK_DISCONNECTED' } });
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(1);
  });

  it("ignores the extension's own refresh downloads", async () => {
    const w = await new World().boot();
    w.ext.addDownload({ id: 700, state: 'in_progress', byExtensionId: w.ext.id });
    w.ext.interrupt(700, 'NETWORK_FAILED');
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(0);
  });

  it('keeps an offer made while the host is down and sends it once on reconnect, with the same key', async () => {
    const w = new World({ noDaemon: true });
    w.ext.connectNativeFailure = 'Specified native messaging host not found.';
    await w.boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    expect(await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z')).toMatchObject({
      status: 'queued',
    });
    // a fresh worker sharing the storage, as after a browser restart, now finds the host
    const restarted = new World();
    for (const [k, v] of w.ext.local.data) restarted.ext.local.data.set(k, v);
    restarted.ext.addDownload({ id: 317, state: 'interrupted', error: 'NETWORK_DISCONNECTED' });
    await restarted.boot();
    const offers = restarted.daemon.sent('handoff.offer');
    expect(offers).toHaveLength(1);
    expect((offers[0]?.body as { offer_key: string }).offer_key).toBe(
      'chrome:317:2026-10-05T09:15:12.004Z',
    );
  });

  it('retries an unanswered offer after reconnecting', async () => {
    const w = await new World().boot();
    w.daemon.ignore('handoff.offer');
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.advance(10_500);
    expect(await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z')).toMatchObject({
      status: 'queued',
    });
    w.ext.lastNativePort().hostDisconnect('Native host has exited.');
    await w.advance(2_000);
    expect(w.daemon.sent('handoff.offer')).toHaveLength(1);
    expect(await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z')).toMatchObject({
      status: 'accepted',
    });
  });

  it('records a rejection and does not retry it', async () => {
    const w = await new World().boot();
    w.daemon.on('handoff.offer', (f, d) => {
      d.reply(f, 'handoff.reject', {
        error: {
          code: 'policy.origin_never',
          class: 'policy_denied',
          message: 'never',
          retryable: false,
        },
      });
    });
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.advance(120_000);
    expect(w.daemon.sent('handoff.offer')).toHaveLength(1);
    expect(await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z')).toMatchObject({
      status: 'rejected',
      reject_code: 'policy.origin_never',
    });
  });

  it('retries after handoff.rate_limited once retry_after_ms passed', async () => {
    const w = await new World().boot();
    let calls = 0;
    w.daemon.on('handoff.offer', (f, d) => {
      calls += 1;
      if (calls === 1) {
        d.reply(f, 'handoff.reject', {
          error: {
            code: 'handoff.rate_limited',
            class: 'unavailable',
            message: 'slow',
            retryable: true,
            details: { retry_after_ms: 20_000 },
          },
        });
      } else {
        d.reply(f, 'handoff.accept', { job_id: jobId(1), state: 'queued', deduplicated: false });
      }
    });
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    expect(calls).toBe(1);
    await w.advance(21_000);
    expect(calls).toBe(2);
    expect(await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z')).toMatchObject({
      status: 'accepted',
    });
  });

  it('respects the per-origin limit of five offers a minute and sends the sixth later', async () => {
    const w = await new World().boot();
    for (let i = 0; i < 6; i++) {
      w.ext.addDownload({
        id: 800 + i,
        state: 'in_progress',
        startTime: `2026-10-05T09:15:1${i}.004Z`,
      });
      w.ext.interrupt(800 + i, 'NETWORK_FAILED');
    }
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(5);
    await w.advance(61_000);
    expect(w.daemon.sent('handoff.offer')).toHaveLength(6);
  });

  it('does not offer when auto-offer is off, but the user can still forward from the popup', async () => {
    const w = await new World().boot();
    await w.bg.store.setSettings({ auto_offer: false });
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(0);
    const reply = await w.ext.sendFromPage({ cmd: 'download.forward', download_id: 317 });
    expect(reply).toMatchObject({ ok: true });
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(1);
    expect(w.daemon.sent('handoff.offer')[0]?.body).toMatchObject({ trigger: 'interrupted' });
  });

  it('forwards a running download as user_initiated with a null reason', async () => {
    const w = await new World().boot();
    w.ext.addDownload({ id: 318, state: 'in_progress', startTime: '2026-10-05T09:20:00.000Z' });
    await w.ext.sendFromPage({ cmd: 'download.forward', download_id: 318 });
    await w.settle();
    expect(w.daemon.sent('handoff.offer')[0]?.body).toMatchObject({
      trigger: 'user_initiated',
      download: { interrupt_reason: null, browser_download_id: 318 },
    });
    expect(w.daemon.violations).toEqual([]);
  });

  it('refuses to forward a security-blocked download', async () => {
    const w = await new World().boot();
    w.ext.addDownload({ id: 319, state: 'interrupted', error: 'FILE_BLOCKED' });
    const reply = await w.ext.sendFromPage({ cmd: 'download.forward', download_id: 319 });
    expect(reply).toMatchObject({ ok: false, error: { code: 'handoff.security_decision' } });
    await w.settle();
    expect(w.daemon.sent('handoff.offer')).toHaveLength(0);
  });
});

describe('withdrawing offers (spec 02 section 7.3)', () => {
  async function accepted(): Promise<World> {
    const w = await new World().boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    return w;
  }

  it('withdraws when the browser completes the download itself', async () => {
    const w = await accepted();
    w.ext.onDownloadChanged.emit({
      id: 317,
      state: { previous: 'in_progress', current: 'complete' },
    });
    await w.settle();
    expect(w.daemon.sent('handoff.withdraw')[0]?.body).toEqual({
      job_id: jobId(1),
      offer_key: 'chrome:317:2026-10-05T09:15:12.004Z',
      reason: 'completed_in_browser',
    });
    expect(w.daemon.violations).toEqual([]);
    // and only once
    w.ext.onDownloadChanged.emit({
      id: 317,
      state: { previous: 'in_progress', current: 'complete' },
    });
    await w.settle();
    expect(w.daemon.sent('handoff.withdraw')).toHaveLength(1);
  });

  it('withdraws when the user resumes it in the browser', async () => {
    const w = await accepted();
    w.ext.onDownloadChanged.emit({
      id: 317,
      state: { previous: 'interrupted', current: 'in_progress' },
    });
    await w.settle();
    expect(w.daemon.sent('handoff.withdraw')[0]?.body).toMatchObject({
      reason: 'resumed_in_browser',
    });
  });

  it('withdraws when the user erases it', async () => {
    const w = await accepted();
    w.ext.onDownloadErased.emit(317);
    await w.settle();
    expect(w.daemon.sent('handoff.withdraw')[0]?.body).toMatchObject({ reason: 'download_erased' });
  });

  it('withdraws when the user cancels the handoff in the popup', async () => {
    const w = await accepted();
    const reply = await w.ext.sendFromPage({ cmd: 'handoff.cancel', job_id: jobId(1) });
    expect(reply).toMatchObject({ ok: true, data: true });
    await w.settle();
    expect(w.daemon.sent('handoff.withdraw')[0]?.body).toMatchObject({
      reason: 'canceled_by_user',
    });
  });

  it('drops a queued offer locally when the browser finished the download before it was sent', async () => {
    const w = new World({ noDaemon: true });
    w.ext.connectNativeFailure = 'Specified native messaging host not found.';
    await w.boot();
    w.ext.addDownload({ id: 317, state: 'in_progress' });
    w.ext.interrupt(317, 'NETWORK_DISCONNECTED');
    await w.settle();
    w.ext.onDownloadChanged.emit({
      id: 317,
      state: { previous: 'interrupted', current: 'complete' },
    });
    await w.settle();
    expect(await w.bg.store.getOffer('chrome:317:2026-10-05T09:15:12.004Z')).toMatchObject({
      status: 'withdrawn',
    });
  });
});

describe('popup candidates', () => {
  it('lists unfinished downloads with eligibility and sanitised names', async () => {
    const w = await new World().boot();
    w.ext.addDownload({
      id: 1,
      state: 'interrupted',
      error: 'NETWORK_FAILED',
      filename: `C:\\d\\evil${String.fromCodePoint(0x202e)}fdp.exe`,
    });
    w.ext.addDownload({ id: 2, state: 'interrupted', error: 'FILE_BLOCKED' });
    w.ext.addDownload({ id: 3, state: 'complete' });
    w.ext.addDownload({ id: 4, state: 'in_progress', byExtensionId: w.ext.id });
    const list = await w.bg.downloads.candidates();
    expect(list.map((c) => c.id).sort()).toEqual([1, 2]);
    const first = list.find((c) => c.id === 1);
    expect(first?.filename).not.toContain(String.fromCodePoint(0x202e));
    expect(first).toMatchObject({ eligible: true, refusal: null });
    expect(list.find((c) => c.id === 2)).toMatchObject({
      eligible: false,
      refusal: 'security_decision',
    });
  });
});
