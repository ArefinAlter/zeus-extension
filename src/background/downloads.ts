// Download rescue (spec 02 section 7): watches the browser's downloads, offers interrupted ones to
// Zeus, tracks the resulting jobs and withdraws an offer when the browser finishes the download
// itself. Offer bookkeeping is persisted without any URL (the offer body is rebuilt from the
// browser's own download item), so a worker restart neither loses nor duplicates an offer.
import { detectBrowser, type BrowserInfo } from '../lib/browser';
import type { Env } from '../lib/env';
import { ZeusError, detailNumber } from '../lib/errors';
import { isEligibleUrl, originOf } from '../lib/origin';
import type { DownloadDelta, DownloadItem } from '../lib/platform';
import type { Capability, ExtBody, DaemonMessage } from '../lib/protocol';
import { displayText, offerFileName } from '../lib/sanitize';
import { toWireTimestamp } from '../lib/time';
import { classifyForward, classifyInterrupted, type RefusalReason, type Verdict } from './classify';
import type { NativeLink } from './native';
import type { OfferRecord, StateStore } from './state';

type OfferBody = ExtBody<'handoff.offer'>;
type WithdrawReason = ExtBody<'handoff.withdraw'>['reason'];

/** The slice of the native link this module uses. */
export type OfferTransport = Pick<
  NativeLink,
  'isReady' | 'request' | 'send' | 'ensureConnected'
> & {
  hasCapability(capability: Capability): boolean;
};

const GLOBAL_OFFERS_PER_MIN = 30;
const ORIGIN_OFFERS_PER_MIN = 5;
const WINDOW_MS = 60_000;
const MAX_RETRY_WAIT_MS = 5 * 60_000;

/** Pure: the handoff.offer body for a browser download item (spec 02 section 7.1). */
export function buildOfferBody(
  item: DownloadItem,
  verdict: Extract<Verdict, { offer: true }>,
  browser: BrowserInfo,
  nowMs: number,
): OfferBody | null {
  if (!isEligibleUrl(item.url)) return null;
  const finalUrl = item.finalUrl !== '' && isEligibleUrl(item.finalUrl) ? item.finalUrl : item.url;
  const start =
    toWireTimestamp(item.startTime) ?? toWireTimestamp(nowMs) ?? '1970-01-01T00:00:00.000Z';
  const download: OfferBody['download'] = {
    browser_download_id: item.id,
    url: item.url,
    final_url: finalUrl,
    referrer: item.referrer !== '' && isEligibleUrl(item.referrer) ? item.referrer : null,
    // Basename only: absolute paths must never leave the browser (spec 02 section 7.1).
    filename: offerFileName(item.filename, item.url),
    mime: item.mime !== '' && item.mime.length <= 255 ? item.mime : null,
    bytes_received: Math.max(0, Math.floor(item.bytesReceived)),
    total_bytes: item.totalBytes >= 0 ? Math.floor(item.totalBytes) : null,
    start_time: start,
    incognito: item.incognito,
    can_resume: item.canResume,
    interrupt_reason: verdict.reason,
  };
  if (item.byExtensionId !== undefined && item.byExtensionId.length <= 128) {
    download.by_extension_id = item.byExtensionId;
  }
  return {
    offer_key: `${browser.name}:${item.id}:${start}`,
    trigger: verdict.trigger,
    download,
    validators: null,
  };
}

/** Sliding-window limiter: how long until another event is allowed (0 = now). */
class RateWindow {
  private readonly stamps: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  wait(now: number): number {
    while (this.stamps.length > 0 && now - (this.stamps[0] ?? now) >= this.windowMs)
      this.stamps.shift();
    if (this.stamps.length < this.limit) return 0;
    return this.windowMs - (now - (this.stamps[0] ?? now));
  }
  take(now: number): void {
    this.stamps.push(now);
  }
}

export interface Candidate {
  id: number;
  /** Sanitised file name (remote data: display with textContent only). */
  filename: string;
  origin: string | null;
  state: DownloadItem['state'];
  bytes_received: number;
  total_bytes: number | null;
  error: string | null;
  eligible: boolean;
  refusal: RefusalReason | null;
  offer_status: OfferRecord['status'] | null;
}

export interface ForwardResult {
  ok: boolean;
  reason?: RefusalReason | 'not_found' | 'url_unsupported';
}

export class DownloadWatcher {
  private readonly browser: BrowserInfo;
  private readonly inFlight = new Set<string>();
  private readonly globalWindow = new RateWindow(GLOBAL_OFFERS_PER_MIN, WINDOW_MS);
  private readonly originWindows = new Map<string, RateWindow>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly env: Env,
    private readonly store: StateStore,
    private readonly link: OfferTransport,
    private readonly hooks: { changed(): void; internalDownloadIds: ReadonlySet<number> },
  ) {
    this.browser = detectBrowser(env.api.env);
  }

  /** Register the browser listeners. Must run synchronously at worker start (MV3 rule). */
  register(): void {
    this.env.api.downloads.onChanged.addListener((delta) => {
      void this.onChanged(delta);
    });
    this.env.api.downloads.onErased.addListener((id) => {
      void this.withdrawForDownload(id, 'download_erased');
    });
  }

  // ---------- browser events ----------

  async onChanged(delta: DownloadDelta): Promise<void> {
    try {
      if (this.hooks.internalDownloadIds.has(delta.id)) return;
      const becameInterrupted =
        delta.state?.current === 'interrupted' || delta.error?.current !== undefined;
      if (becameInterrupted) {
        if (!(await this.store.getSettings()).auto_offer) return;
        const [item] = await this.env.api.downloads.search({ id: delta.id });
        if (!item) return;
        const verdict = classifyInterrupted(item, this.env.api.runtime.id);
        if (!verdict.offer) {
          this.env.log.debug('download not offered', { id: item.id, why: verdict.why });
          return;
        }
        await this.queue(item, verdict);
        return;
      }
      if (delta.state?.current === 'complete')
        await this.withdrawForDownload(delta.id, 'completed_in_browser');
      else if (delta.state?.current === 'in_progress' && delta.state.previous === 'interrupted') {
        await this.withdrawForDownload(delta.id, 'resumed_in_browser');
      }
    } catch (e) {
      this.env.log.warn('download event handling failed', {
        error: e instanceof Error ? e.name : 'unknown',
      });
    }
  }

  // ---------- offering ----------

  /** The user forwards a download from the popup. */
  async forward(downloadId: number): Promise<ForwardResult> {
    const [item] = await this.env.api.downloads.search({ id: downloadId });
    if (!item) return { ok: false, reason: 'not_found' };
    if (this.hooks.internalDownloadIds.has(item.id)) return { ok: false, reason: 'own_download' };
    const verdict = classifyForward(item, this.env.api.runtime.id);
    if (!verdict.offer) return { ok: false, reason: verdict.why };
    await this.queue(item, verdict);
    return { ok: true };
  }

  private async queue(
    item: DownloadItem,
    verdict: Extract<Verdict, { offer: true }>,
  ): Promise<void> {
    const body = buildOfferBody(item, verdict, this.browser, this.env.clock.now());
    if (body === null) return;
    const existing = await this.store.getOffer(body.offer_key);
    if (existing && existing.status !== 'queued') return; // already sent, answered or withdrawn
    if (!existing) {
      await this.store.putOffer({
        offer_key: body.offer_key,
        download_id: item.id,
        trigger: verdict.trigger,
        status: 'queued',
        job_id: null,
        approval_id: null,
        created_at_ms: this.env.clock.now(),
      });
    }
    this.hooks.changed();
    if (this.link.isReady()) await this.sendOffer(body.offer_key);
    else this.link.ensureConnected();
  }

  /** Send every queued offer (called when the link becomes ready and when a rate wait ends). */
  async flush(): Promise<void> {
    for (const offer of await this.store.listOffers()) {
      if (offer.status === 'queued' || offer.status === 'sent')
        await this.sendOffer(offer.offer_key);
    }
  }

  private async sendOffer(offerKey: string): Promise<void> {
    if (this.inFlight.has(offerKey) || !this.link.isReady() || !this.link.hasCapability('handoff'))
      return;
    this.inFlight.add(offerKey);
    try {
      const rec = await this.store.getOffer(offerKey);
      if (!rec || (rec.status !== 'queued' && rec.status !== 'sent')) return;
      const [item] = await this.env.api.downloads.search({ id: rec.download_id });
      if (!item) {
        await this.store.putOffer({ ...rec, status: 'withdrawn' });
        this.hooks.changed();
        return;
      }
      const verdict =
        rec.trigger === 'user_initiated'
          ? classifyForward(item, this.env.api.runtime.id)
          : classifyInterrupted(item, this.env.api.runtime.id);
      if (!verdict.offer) {
        // The browser resumed or finished the download while the offer waited, or it became ineligible.
        await this.store.putOffer({ ...rec, status: 'withdrawn' });
        this.hooks.changed();
        return;
      }
      const body = buildOfferBody(item, verdict, this.browser, this.env.clock.now());
      if (body === null || body.offer_key !== rec.offer_key) {
        await this.store.putOffer({ ...rec, status: 'withdrawn' });
        return;
      }
      const origin = originOf(item.url) ?? '';
      const wait = this.rateWait(origin);
      if (wait > 0) {
        this.scheduleRetry(wait);
        return;
      }
      this.globalWindow.take(this.env.clock.now());
      this.originWindow(origin).take(this.env.clock.now());
      await this.store.putOffer({ ...rec, status: 'sent' });
      await this.exchange(rec, body);
    } finally {
      this.inFlight.delete(offerKey);
    }
  }

  private async exchange(rec: OfferRecord, body: OfferBody): Promise<void> {
    let answer: DaemonMessage;
    try {
      answer = await this.link.request('handoff.offer', body);
    } catch (e) {
      // Timeout or closed connection: the offer stays 'sent' and is retried with the same key.
      this.env.log.warn('handoff.offer unanswered', {
        code: e instanceof ZeusError ? e.envelope.code : 'unknown',
      });
      await this.store.putOffer({ ...rec, status: 'queued' });
      return;
    }
    if (answer.type === 'handoff.accept') {
      await this.store.putOffer({
        ...rec,
        status: 'accepted',
        job_id: answer.body.job_id,
        approval_id: answer.body.approval_id ?? null,
      });
    } else if (answer.type === 'handoff.reject') {
      const err = answer.body.error;
      const retryAfter = detailNumber(err, 'retry_after_ms');
      if (err.retryable && retryAfter !== null) {
        await this.store.putOffer({ ...rec, status: 'queued' });
        this.scheduleRetry(Math.min(retryAfter, MAX_RETRY_WAIT_MS));
      } else {
        await this.store.putOffer({ ...rec, status: 'rejected', reject_code: err.code });
      }
    }
    this.hooks.changed();
  }

  // ---------- withdrawing ----------

  /** Tell the daemon to drop the job for a download the browser finished, resumed or erased. */
  async withdrawForDownload(downloadId: number, reason: WithdrawReason): Promise<void> {
    const offers = (await this.store.listOffers()).filter(
      (o) =>
        o.download_id === downloadId &&
        (o.status === 'queued' || o.status === 'sent' || o.status === 'accepted'),
    );
    for (const offer of offers) await this.withdraw(offer, reason);
  }

  /** The user cancels the handoff in the popup. */
  async withdrawForJob(jobId: string): Promise<boolean> {
    const offer = (await this.store.listOffers()).find(
      (o) => o.job_id === jobId && o.status === 'accepted',
    );
    if (!offer) return false;
    await this.withdraw(offer, 'canceled_by_user');
    return true;
  }

  private async withdraw(offer: OfferRecord, reason: WithdrawReason): Promise<void> {
    if (offer.job_id !== null) {
      this.link.send('handoff.withdraw', {
        job_id: offer.job_id,
        offer_key: offer.offer_key,
        reason,
      });
    }
    await this.store.putOffer({ ...offer, status: 'withdrawn' });
    this.hooks.changed();
  }

  // ---------- views ----------

  /** Offers that keep the connection wanted: not yet answered, or accepted and possibly still running. */
  async pendingOfferCount(): Promise<number> {
    return (await this.store.listOffers()).filter(
      (o) => o.status === 'queued' || o.status === 'sent',
    ).length;
  }

  /** True when the job was created from an offer made by this extension. */
  async ownsJob(jobId: string): Promise<boolean> {
    return (await this.store.listOffers()).some((o) => o.job_id === jobId);
  }

  /** Recent browser downloads for the popup, with eligibility. */
  async candidates(limit = 8): Promise<Candidate[]> {
    const items = await this.env.api.downloads.search({ orderBy: ['-startTime'], limit: 40 });
    const offers = await this.store.listOffers();
    const out: Candidate[] = [];
    for (const item of items) {
      if (item.state === 'complete' || this.hooks.internalDownloadIds.has(item.id)) continue;
      if (item.byExtensionId === this.env.api.runtime.id) continue; // our own URL-refresh downloads
      const verdict = classifyForward(item, this.env.api.runtime.id);
      const offer = offers.find((o) => o.download_id === item.id && o.status !== 'withdrawn');
      out.push({
        id: item.id,
        filename: displayText(offerFileName(item.filename, item.url), 120),
        origin: originOf(item.url),
        state: item.state,
        bytes_received: Math.max(0, item.bytesReceived),
        total_bytes: item.totalBytes >= 0 ? item.totalBytes : null,
        error: item.error ?? null,
        eligible: verdict.offer,
        refusal: verdict.offer ? null : verdict.why,
        offer_status: offer?.status ?? null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------- rate limiting (spec 00 section 10, 02 section 7.2) ----------

  private originWindow(origin: string): RateWindow {
    let w = this.originWindows.get(origin);
    if (!w) {
      w = new RateWindow(ORIGIN_OFFERS_PER_MIN, WINDOW_MS);
      this.originWindows.set(origin, w);
    }
    return w;
  }

  private rateWait(origin: string): number {
    const now = this.env.clock.now();
    return Math.max(this.globalWindow.wait(now), this.originWindow(origin).wait(now));
  }

  private scheduleRetry(waitMs: number): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        void this.flush();
      },
      Math.max(1000, waitMs),
    );
  }
}
