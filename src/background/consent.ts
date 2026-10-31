// The release gate (spec 02 section 10.2). The extension is the last gate before cookies leave
// the browser: the daemon's grant alone is not enough. Consent to release session material is
// authoritative here (spec 02 section 12). Every `session.request`, `url.refresh.request` and
// `fetch.range` passes through `ConsentGate.evaluate`, and a failure at any step answers
// consent_required or denied and sends nothing else.
import type { Env } from '../lib/env';
import { makeError } from '../lib/errors';
import { hostPattern, isReleasableOrigin, originOf } from '../lib/origin';
import type { ErrorEnvelope, SessionPageSubject } from '../lib/protocol';
import type { ConsentRecord, StateStore } from './state';

/** Session material never lives longer than 15 minutes (spec 00 section 10). */
export const MAX_SESSION_TTL_MS = 900_000;

interface JobConsentGateRequest {
  kind: 'session' | 'url_refresh' | 'fetch';
  origin: string;
  /** The URL that will be requested; its origin must equal `origin`. */
  url: string;
  job_id: string;
  /** Present on session.request only; the other two requests do not name a grant. */
  grant_id?: string;
}

/** Page data has an explicit durable subject; no synthetic job or cookie release is used. */
export interface PageConsentGateRequest {
  kind: 'page';
  origin: string;
  url: string;
  grant_id: string;
  profile_id: string;
  subject: SessionPageSubject;
}

export type ConsentGateRequest = JobConsentGateRequest | PageConsentGateRequest;

export type GateFailure =
  | 'origin_mismatch'
  | 'profile_mismatch'
  | 'insecure_origin'
  | 'never_listed'
  | 'no_consent'
  | 'expired'
  | 'no_browser_permission';

export type GateResult =
  | { ok: true; ttl_ms: number; record: ConsentRecord }
  | {
      ok: false;
      /** consent_required and denied map to session.response statuses; invalid is a protocol error. */
      status: 'consent_required' | 'denied' | 'invalid';
      reason: GateFailure;
      error: ErrorEnvelope;
    };

export class ConsentGate {
  constructor(
    private readonly env: Env,
    private readonly store: StateStore,
  ) {}

  /**
   * Decide whether session material (or a credentialed fetch) may be released for a request.
   * `requestedTtlMs` applies to session releases only.
   */
  async evaluate(
    req: ConsentGateRequest,
    requestedTtlMs = MAX_SESSION_TTL_MS,
  ): Promise<GateResult> {
    // Step 1: origin consistency and the scheme rule (spec 01 section 4 rule 3).
    const actual = originOf(req.url);
    if (actual === null || actual !== req.origin) {
      return fail(
        'invalid',
        'origin_mismatch',
        makeError('session.origin_mismatch', 'The origin does not match the URL.'),
      );
    }
    if (!isReleasableOrigin(req.origin)) {
      return fail(
        'denied',
        'insecure_origin',
        makeError(
          'session.consent_denied',
          'Session material is released only for https origins and loopback http.',
        ),
      );
    }
    if (req.kind === 'page' && req.profile_id !== (await this.store.getProfileId())) {
      return fail(
        'invalid',
        'profile_mismatch',
        makeError('session.consent_denied', 'The page grant belongs to another browser profile.'),
      );
    }
    if ((await this.store.listNever()).some((e) => e.origin === req.origin)) {
      return fail(
        'denied',
        'never_listed',
        makeError('policy.origin_never', 'This origin is on the never list.'),
      );
    }

    // Step 2: a consent record that covers this request.
    const now = this.env.clock.now();
    const records = (await this.store.listConsent()).filter((r) => r.origin === req.origin);
    const jobRuns = await this.store.getJobRuns();
    const matching = records.filter((r) => this.covers(r, req, jobRuns));
    if (matching.length === 0) {
      return fail(
        'consent_required',
        'no_consent',
        makeError('session.consent_required', `No consent record covers ${req.origin}.`),
      );
    }
    const live = matching.filter((r) => r.expires_at_ms > now);
    const record = live.sort((a, b) => b.expires_at_ms - a.expires_at_ms)[0];
    if (!record) {
      return fail(
        'consent_required',
        'expired',
        makeError('session.consent_required', `Consent for ${req.origin} has expired.`),
      );
    }

    // Step 3: browser-enforced scoping: the optional host (and for cookies, cookie) permission.
    const granted = await this.env.api.permissions.contains({
      origins: [hostPattern(req.origin)],
    });
    if (!granted) {
      return fail(
        'consent_required',
        'no_browser_permission',
        makeError(
          'session.consent_required',
          `The browser has not granted access to ${req.origin}.`,
        ),
      );
    }

    // Step 4: the lifetime never exceeds the request, 15 minutes or the remaining consent time.
    const ttl = Math.min(requestedTtlMs, MAX_SESSION_TTL_MS, record.expires_at_ms - now);
    if (ttl < 1000) {
      return fail(
        'consent_required',
        'expired',
        makeError('session.consent_required', `Consent for ${req.origin} is about to expire.`),
      );
    }
    return { ok: true, ttl_ms: Math.floor(ttl), record };
  }

  /**
   * Does a record cover the request? `session.request` names the grant; the other two requests
   * carry only the job, so the job (once) or the job's run (workflow) is matched instead.
   */
  private covers(
    r: ConsentRecord,
    req: ConsentGateRequest,
    jobRuns: Record<string, string>,
  ): boolean {
    if (req.grant_id !== undefined && r.grant_id !== req.grant_id) return false;
    if (req.kind === 'page') {
      return req.subject.purpose === 'plan'
        ? r.scope === 'site'
        : r.scope === 'workflow' && r.run_id === req.subject.run_id;
    }
    if (r.scope === 'once') return r.job_id === req.job_id;
    if (r.scope === 'workflow') {
      const run = jobRuns[req.job_id];
      // A grant id names the grant, but the job's run is checked whenever it is known.
      if (run !== undefined) return r.run_id === run;
      return req.grant_id !== undefined;
    }
    return true; // site
  }

  /**
   * Cross-origin redirect rule (spec 02 section 9.3). Called after a credentialed fetch resolved to
   * `finalUrl`. Same origin: continue. Different origin: continue unless the browser holds cookies
   * for the final URL and the human gave no consent for that origin. Without host permission the
   * browser applied its ordinary CORS rules to the hop, so nothing privileged was attached.
   */
  async checkRedirectTarget(finalUrl: string, origin: string): Promise<'ok' | 'denied'> {
    const finalOrigin = originOf(finalUrl);
    if (finalOrigin === null) return 'denied';
    if (finalOrigin === origin) return 'ok';
    const hasHostPermission = await this.env.api.permissions.contains({
      origins: [hostPattern(finalOrigin)],
    });
    if (!hasHostPermission) return 'ok';
    // Never inspect cookie values to decide whether a redirect needs consent.
    // A privileged cross-origin target always needs its own explicit grant.
    const now = this.env.clock.now();
    const consented = (await this.store.listConsent()).some(
      (r) => r.origin === finalOrigin && r.expires_at_ms > now,
    );
    return consented ? 'ok' : 'denied';
  }
}

function fail(
  status: 'consent_required' | 'denied' | 'invalid',
  reason: Extract<GateResult, { ok: false }>['reason'],
  error: ErrorEnvelope,
): GateResult {
  return { ok: false, status, reason, error };
}
