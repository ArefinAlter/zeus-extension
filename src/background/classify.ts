// Which browser downloads may be offered to Zeus (spec 01 section 8.4, 02 section 7). The browser's
// interrupt reason is only a hint; the daemon's own probe decides the real error class. What the
// extension decides here is eligibility, and one rule is absolute: security decisions by the
// browser, an antivirus or enterprise policy are never laundered by downloading the file elsewhere.
import type { InterruptReason } from '../lib/protocol';
import type { DownloadItem } from '../lib/platform';
import { isEligibleUrl } from '../lib/origin';
import type { ErrorClass } from '../lib/errors';

export type OfferPolicy = 'prompt' | 'prompt_low_priority' | 'never';

export interface ReasonClass {
  /** First-probe hint for the daemon, null for reasons that carry no class. */
  hint: ErrorClass | null;
  offer: OfferPolicy;
}

// Spec 01 section 8.4, row by row.
const TABLE: Record<InterruptReason, ReasonClass> = {
  NETWORK_FAILED: { hint: 'transient_network', offer: 'prompt' },
  NETWORK_TIMEOUT: { hint: 'transient_network', offer: 'prompt' },
  NETWORK_DISCONNECTED: { hint: 'transient_network', offer: 'prompt' },
  NETWORK_SERVER_DOWN: { hint: 'transient_network', offer: 'prompt' },
  SERVER_FAILED: { hint: 'transient_network', offer: 'prompt' },
  SERVER_UNREACHABLE: { hint: 'transient_network', offer: 'prompt' },
  SERVER_CONTENT_LENGTH_MISMATCH: { hint: 'transient_network', offer: 'prompt' },
  SERVER_NO_RANGE: { hint: 'transient_network', offer: 'prompt' },
  SERVER_UNAUTHORIZED: { hint: 'auth_expired', offer: 'prompt' },
  SERVER_FORBIDDEN: { hint: null, offer: 'prompt' }, // ambiguous: the probe decides among D1 to D5
  SERVER_BAD_CONTENT: { hint: 'permanent', offer: 'prompt_low_priority' },
  SERVER_CROSS_ORIGIN_REDIRECT: { hint: 'transient_network', offer: 'prompt' },
  FILE_NO_SPACE: { hint: 'disk', offer: 'prompt' },
  FILE_TRANSIENT_ERROR: { hint: 'disk', offer: 'prompt' },
  FILE_FAILED: { hint: 'disk', offer: 'prompt' },
  FILE_ACCESS_DENIED: { hint: 'disk', offer: 'prompt' },
  FILE_NAME_TOO_LONG: { hint: 'disk', offer: 'prompt' },
  FILE_TOO_LARGE: { hint: 'disk', offer: 'prompt' },
  FILE_TOO_SHORT: { hint: 'integrity', offer: 'prompt' },
  FILE_HASH_MISMATCH: { hint: 'integrity', offer: 'prompt' },
  USER_SHUTDOWN: { hint: 'transient_network', offer: 'prompt_low_priority' },
  CRASH: { hint: 'transient_network', offer: 'prompt_low_priority' },
  NETWORK_INVALID_REQUEST: { hint: 'permanent', offer: 'never' },
  SERVER_CERT_PROBLEM: { hint: 'permanent', offer: 'never' }, // Zeus never bypasses certificate errors
  FILE_VIRUS_INFECTED: { hint: 'policy_denied', offer: 'never' },
  FILE_BLOCKED: { hint: 'policy_denied', offer: 'never' },
  FILE_SECURITY_CHECK_FAILED: { hint: 'policy_denied', offer: 'never' },
  USER_CANCELED: { hint: null, offer: 'never' }, // user intent
  FILE_SAME_AS_SOURCE: { hint: null, offer: 'never' },
  UNKNOWN: { hint: null, offer: 'never' },
};

const KNOWN: ReadonlySet<string> = new Set(Object.keys(TABLE));

/** Map a browser-reported reason string to the protocol enum; anything unrecognised is UNKNOWN. */
export function toInterruptReason(raw: string | undefined): InterruptReason | null {
  if (raw === undefined || raw === '') return null;
  return KNOWN.has(raw) ? (raw as InterruptReason) : 'UNKNOWN';
}

export function classifyInterruptReason(reason: InterruptReason): ReasonClass {
  return TABLE[reason];
}

/**
 * Chrome danger types the browser reports for downloads it considers harmful. Safe Browsing and
 * enterprise verdicts are security decisions: not offered. Unknown values fail closed.
 */
const OFFERABLE_DANGER: ReadonlySet<string> = new Set([
  '',
  'safe',
  'accepted',
  'file',
  'allowlistedByPolicy',
]);

export type RefusalReason =
  | 'own_download'
  | 'unsupported_url'
  | 'security_decision'
  | 'dangerous'
  | 'user_canceled'
  | 'not_interrupted'
  | 'complete';

export type Verdict =
  | {
      offer: true;
      trigger: 'interrupted' | 'user_initiated';
      reason: InterruptReason | null;
      priority: 'normal' | 'low';
    }
  | { offer: false; why: RefusalReason };

const SECURITY_REASONS: ReadonlySet<InterruptReason> = new Set([
  'FILE_VIRUS_INFECTED',
  'FILE_BLOCKED',
  'FILE_SECURITY_CHECK_FAILED',
  'SERVER_CERT_PROBLEM',
]);

function common(item: DownloadItem, ownExtensionId: string): Verdict | null {
  if (item.byExtensionId === ownExtensionId) return { offer: false, why: 'own_download' };
  if (!isEligibleUrl(item.url) || (item.finalUrl !== '' && !isEligibleUrl(item.finalUrl))) {
    return { offer: false, why: 'unsupported_url' };
  }
  if (!OFFERABLE_DANGER.has(item.danger)) return { offer: false, why: 'dangerous' };
  return null;
}

/** An automatic offer for a download the browser reports as interrupted. */
export function classifyInterrupted(item: DownloadItem, ownExtensionId: string): Verdict {
  const early = common(item, ownExtensionId);
  if (early) return early;
  if (item.state !== 'interrupted') return { offer: false, why: 'not_interrupted' };
  const reason = toInterruptReason(item.error) ?? 'UNKNOWN';
  const policy = TABLE[reason].offer;
  if (policy === 'never') {
    if (reason === 'USER_CANCELED') return { offer: false, why: 'user_canceled' };
    return {
      offer: false,
      why: SECURITY_REASONS.has(reason) ? 'security_decision' : 'not_interrupted',
    };
  }
  return {
    offer: true,
    trigger: 'interrupted',
    reason,
    priority: policy === 'prompt' ? 'normal' : 'low',
  };
}

/**
 * A download the user explicitly forwards from the popup. An interrupted download keeps its reason
 * (and the same security refusals apply); a running one is sent with a null reason.
 */
export function classifyForward(item: DownloadItem, ownExtensionId: string): Verdict {
  const early = common(item, ownExtensionId);
  if (early) return early;
  if (item.state === 'complete') return { offer: false, why: 'complete' };
  if (item.state === 'interrupted') {
    const reason = toInterruptReason(item.error) ?? 'UNKNOWN';
    if (reason === 'USER_CANCELED')
      return { offer: true, trigger: 'user_initiated', reason: null, priority: 'normal' };
    if (SECURITY_REASONS.has(reason)) return { offer: false, why: 'security_decision' };
    if (TABLE[reason].offer === 'never')
      return { offer: true, trigger: 'user_initiated', reason: null, priority: 'normal' };
    return { offer: true, trigger: 'interrupted', reason, priority: 'normal' };
  }
  return { offer: true, trigger: 'user_initiated', reason: null, priority: 'normal' };
}
