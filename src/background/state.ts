// Persistent state (spec 02 section 4 rule 6). Only non-secret data is ever stored:
//   chrome.storage.local   consent records, the local never-list, handoff offer bookkeeping,
//                          last_event_seq, profile_id, settings, ids of approvals that were shown.
//   chrome.storage.session memory-only: the desired_connected flag, released session ids (replay
//                          guard) and the job-to-run map.
// Cookies, URLs with query strings and frame bodies are never written here. Reads validate the
// shape and fall back to defaults, because a worker must survive corrupt or foreign storage.
import type { Env } from '../lib/env';
import { newProfileId } from '../lib/ids';

export type ConsentScope = 'once' | 'site' | 'workflow';

/** The extension's own note that the human allowed release of session material (spec 02 10.2). */
export interface ConsentRecord {
  grant_id: string;
  origin: string;
  scope: ConsentScope;
  job_id?: string;
  run_id?: string;
  expires_at_ms: number;
  source: 'ui' | 'event';
}

/** Local never-list entry, created by a human "never for this site" decision. */
export interface NeverEntry {
  origin: string;
  grant_id: string;
  created_at_ms: number;
}

export type OfferStatus = 'queued' | 'sent' | 'accepted' | 'rejected' | 'withdrawn';

/** Bookkeeping for one handoff offer. Holds no URL: the offer body is rebuilt from the browser. */
export interface OfferRecord {
  offer_key: string;
  download_id: number;
  trigger: 'interrupted' | 'user_initiated';
  status: OfferStatus;
  job_id: string | null;
  approval_id: string | null;
  created_at_ms: number;
  /** Error code from a handoff.reject, for display. */
  reject_code?: string;
}

export interface Settings {
  /** Offer interrupted downloads to Zeus automatically (the user still approves each origin). */
  auto_offer: boolean;
  notifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = { auto_offer: true, notifications: true };

const KEYS = {
  profileId: 'zeus.v1.profile_id',
  consent: 'zeus.v1.consent',
  never: 'zeus.v1.never',
  offers: 'zeus.v1.offers',
  lastEventSeq: 'zeus.v1.last_event_seq',
  displayed: 'zeus.v1.displayed_approvals',
  settings: 'zeus.v1.settings',
  desired: 'zeus.s.desired_connected',
  released: 'zeus.s.released_sessions',
  jobRuns: 'zeus.s.job_runs',
} as const;

const MAX_OFFERS = 200;
const MAX_DISPLAYED = 200;
const MAX_RELEASED = 256;
const MAX_JOB_RUNS = 500;
const DISPLAYED_TTL_MS = 8 * 24 * 3600 * 1000;
const OFFER_TTL_MS = 3 * 24 * 3600 * 1000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseConsent(v: unknown): ConsentRecord | null {
  if (!isRecord(v)) return null;
  if (!isStr(v.grant_id) || !isStr(v.origin) || !isNum(v.expires_at_ms)) return null;
  if (v.scope !== 'once' && v.scope !== 'site' && v.scope !== 'workflow') return null;
  if (v.source !== 'ui' && v.source !== 'event') return null;
  const rec: ConsentRecord = {
    grant_id: v.grant_id,
    origin: v.origin,
    scope: v.scope,
    expires_at_ms: v.expires_at_ms,
    source: v.source,
  };
  if (isStr(v.job_id)) rec.job_id = v.job_id;
  if (isStr(v.run_id)) rec.run_id = v.run_id;
  return rec;
}

function parseNever(v: unknown): NeverEntry | null {
  if (!isRecord(v) || !isStr(v.origin) || !isStr(v.grant_id) || !isNum(v.created_at_ms))
    return null;
  return { origin: v.origin, grant_id: v.grant_id, created_at_ms: v.created_at_ms };
}

const OFFER_STATUSES: readonly string[] = ['queued', 'sent', 'accepted', 'rejected', 'withdrawn'];

function parseOffer(v: unknown): OfferRecord | null {
  if (!isRecord(v) || !isStr(v.offer_key) || !isNum(v.download_id) || !isNum(v.created_at_ms))
    return null;
  if (!isStr(v.status) || !OFFER_STATUSES.includes(v.status)) return null;
  if (v.trigger !== 'interrupted' && v.trigger !== 'user_initiated') return null;
  const rec: OfferRecord = {
    offer_key: v.offer_key,
    download_id: v.download_id,
    trigger: v.trigger,
    status: v.status as OfferStatus,
    job_id: isStr(v.job_id) ? v.job_id : null,
    approval_id: isStr(v.approval_id) ? v.approval_id : null,
    created_at_ms: v.created_at_ms,
  };
  if (isStr(v.reject_code)) rec.reject_code = v.reject_code;
  return rec;
}

function parseList<T>(raw: unknown, parse: (v: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export class StateStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: Env) {}

  private get local() {
    return this.env.api.storage.local;
  }
  private get session() {
    return this.env.api.storage.session;
  }

  /** Serialise read-modify-write sequences so concurrent handlers never lose an update. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(area: 'local' | 'session', key: string): Promise<unknown> {
    try {
      const got = await this[area].get(key);
      return got[key];
    } catch (e) {
      this.env.log.warn('storage read failed', {
        key,
        error: e instanceof Error ? e.name : 'unknown',
      });
      return undefined;
    }
  }

  private async write(area: 'local' | 'session', key: string, value: unknown): Promise<void> {
    try {
      await this[area].set({ [key]: value });
    } catch (e) {
      this.env.log.warn('storage write failed', {
        key,
        error: e instanceof Error ? e.name : 'unknown',
      });
    }
  }

  // ---------- profile ----------

  /** The random per-profile id that routes browser-bound jobs to this cookie jar. */
  getProfileId(): Promise<string> {
    return this.serial(async () => {
      const existing = await this.read('local', KEYS.profileId);
      if (isStr(existing) && /^[0-9a-f]{32}$/.test(existing)) return existing;
      const fresh = newProfileId(this.env.rng);
      await this.write('local', KEYS.profileId, fresh);
      return fresh;
    });
  }

  // ---------- settings ----------

  async getSettings(): Promise<Settings> {
    const raw = await this.read('local', KEYS.settings);
    if (!isRecord(raw)) return { ...DEFAULT_SETTINGS };
    return {
      auto_offer:
        typeof raw.auto_offer === 'boolean' ? raw.auto_offer : DEFAULT_SETTINGS.auto_offer,
      notifications:
        typeof raw.notifications === 'boolean' ? raw.notifications : DEFAULT_SETTINGS.notifications,
    };
  }

  setSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.serial(async () => {
      const next = { ...(await this.getSettings()), ...patch };
      await this.write('local', KEYS.settings, next);
      return next;
    });
  }

  // ---------- consent records ----------

  async listConsent(): Promise<ConsentRecord[]> {
    return parseList(await this.read('local', KEYS.consent), parseConsent);
  }

  /** Insert or replace by grant id, dropping records that already expired. */
  putConsent(record: ConsentRecord): Promise<void> {
    return this.serial(async () => {
      const now = this.env.clock.now();
      const all = (await this.listConsent()).filter(
        (r) => r.grant_id !== record.grant_id && r.expires_at_ms > now,
      );
      all.push(record);
      await this.write('local', KEYS.consent, all);
    });
  }

  removeConsent(predicate: (r: ConsentRecord) => boolean): Promise<ConsentRecord[]> {
    return this.serial(async () => {
      const all = await this.listConsent();
      const removed = all.filter(predicate);
      if (removed.length > 0) {
        await this.write(
          'local',
          KEYS.consent,
          all.filter((r) => !predicate(r)),
        );
      }
      return removed;
    });
  }

  /** Remove expired records; returns what was removed. */
  pruneConsent(): Promise<ConsentRecord[]> {
    const now = this.env.clock.now();
    return this.removeConsent((r) => r.expires_at_ms <= now);
  }

  // ---------- never-list ----------

  async listNever(): Promise<NeverEntry[]> {
    return parseList(await this.read('local', KEYS.never), parseNever);
  }

  putNever(entry: NeverEntry): Promise<void> {
    return this.serial(async () => {
      const all = (await this.listNever()).filter((e) => e.grant_id !== entry.grant_id);
      all.push(entry);
      await this.write('local', KEYS.never, all);
    });
  }

  removeNever(predicate: (e: NeverEntry) => boolean): Promise<NeverEntry[]> {
    return this.serial(async () => {
      const all = await this.listNever();
      const removed = all.filter(predicate);
      if (removed.length > 0)
        await this.write(
          'local',
          KEYS.never,
          all.filter((e) => !predicate(e)),
        );
      return removed;
    });
  }

  // ---------- offers ----------

  async listOffers(): Promise<OfferRecord[]> {
    return parseList(await this.read('local', KEYS.offers), parseOffer);
  }

  async getOffer(offerKey: string): Promise<OfferRecord | undefined> {
    return (await this.listOffers()).find((o) => o.offer_key === offerKey);
  }

  /** Insert or update by offer key; old records are pruned so the list stays bounded. */
  putOffer(record: OfferRecord): Promise<void> {
    return this.serial(async () => {
      const now = this.env.clock.now();
      const all = (await this.listOffers()).filter(
        (o) => o.offer_key !== record.offer_key && now - o.created_at_ms < OFFER_TTL_MS,
      );
      all.push(record);
      await this.write('local', KEYS.offers, all.slice(-MAX_OFFERS));
    });
  }

  // ---------- event cursor ----------

  async getLastEventSeq(): Promise<number | null> {
    const raw = await this.read('local', KEYS.lastEventSeq);
    return isNum(raw) && Number.isInteger(raw) && raw >= 0 ? raw : null;
  }

  setLastEventSeq(seq: number): Promise<void> {
    return this.write('local', KEYS.lastEventSeq, seq);
  }

  // ---------- displayed approvals ----------

  /** Remember that an approval was shown to the human (grant.created events are honoured only for these). */
  markApprovalDisplayed(approvalId: string): Promise<void> {
    return this.serial(async () => {
      const now = this.env.clock.now();
      const raw = await this.read('local', KEYS.displayed);
      const map = isRecord(raw) ? raw : {};
      const kept: Record<string, number> = {};
      for (const [id, at] of Object.entries(map))
        if (isNum(at) && now - at < DISPLAYED_TTL_MS) kept[id] = at;
      kept[approvalId] = now;
      const entries = Object.entries(kept).slice(-MAX_DISPLAYED);
      await this.write('local', KEYS.displayed, Object.fromEntries(entries));
    });
  }

  async wasApprovalDisplayed(approvalId: string): Promise<boolean> {
    const raw = await this.read('local', KEYS.displayed);
    return isRecord(raw) && isNum(raw[approvalId]);
  }

  // ---------- session-scoped (memory only) ----------

  async getDesired(): Promise<boolean> {
    return (await this.read('session', KEYS.desired)) === true;
  }

  setDesired(value: boolean): Promise<void> {
    return this.write('session', KEYS.desired, value);
  }

  /**
   * Record a released `sess_` id. Returns false when it was already used: a replayed
   * session.request is refused (spec 02 section 13.3).
   */
  claimSessionId(sessionId: string): Promise<boolean> {
    return this.serial(async () => {
      const raw = await this.read('session', KEYS.released);
      const list = Array.isArray(raw) ? raw.filter(isStr) : [];
      if (list.includes(sessionId)) return false;
      list.push(sessionId);
      await this.write('session', KEYS.released, list.slice(-MAX_RELEASED));
      return true;
    });
  }

  /** Forget a claimed id (the release failed before any material left the browser). */
  releaseSessionClaim(sessionId: string): Promise<void> {
    return this.serial(async () => {
      const raw = await this.read('session', KEYS.released);
      const list = Array.isArray(raw) ? raw.filter(isStr) : [];
      await this.write(
        'session',
        KEYS.released,
        list.filter((s) => s !== sessionId),
      );
    });
  }

  async getJobRuns(): Promise<Record<string, string>> {
    const raw = await this.read('session', KEYS.jobRuns);
    const out: Record<string, string> = {};
    if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (isStr(v)) out[k] = v;
    return out;
  }

  rememberJobRun(jobId: string, runId: string): Promise<void> {
    return this.serial(async () => {
      const map = await this.getJobRuns();
      map[jobId] = runId;
      await this.write(
        'session',
        KEYS.jobRuns,
        Object.fromEntries(Object.entries(map).slice(-MAX_JOB_RUNS)),
      );
    });
  }
}
