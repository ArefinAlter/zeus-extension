// The error envelope (spec 00 section 9) and the codes the extension raises (spec 02 section 14,
// 01 section 8.2). A code maps to exactly one class; `retryable` is fixed per code.
import type { ErrorEnvelope } from './protocol.generated';
import { scrubUrls } from './redact';

export type ErrorClass = ErrorEnvelope['class'];

const SPECS = {
  // native messaging
  'nm.schema_violation': { class: 'invalid_request', retryable: false },
  'nm.frame_too_large': { class: 'invalid_request', retryable: false },
  'nm.unknown_type': { class: 'unsupported', retryable: false },
  'nm.capability_missing': { class: 'unsupported', retryable: false },
  'nm.rate_limited': { class: 'unavailable', retryable: true },
  'nm.timeout': { class: 'timeout', retryable: true },
  'nm.duplicate_id': { class: 'invalid_request', retryable: false },
  'nm.conflict': { class: 'conflict', retryable: false },
  'nm.stream_unknown': { class: 'not_found', retryable: false },
  'nm.too_many_streams': { class: 'unavailable', retryable: true },
  'nm.internal': { class: 'internal', retryable: false },
  // policy and session
  'policy.origin_never': { class: 'policy_denied', retryable: false },
  'session.consent_required': { class: 'auth_expired', retryable: true },
  'session.consent_denied': { class: 'policy_denied', retryable: false },
  'session.origin_mismatch': { class: 'invalid_request', retryable: false },
  'session.store_unavailable': { class: 'unavailable', retryable: true },
  'session.extension_busy': { class: 'unavailable', retryable: true },
  // url refresh
  'url.refresh_failed': { class: 'url_expired', retryable: false },
  'url.login_required': { class: 'auth_expired', retryable: true },
  'url.refresh_unsupported': { class: 'unsupported', retryable: false },
  // in-browser fetch proxy
  'fetch.network_error': { class: 'transient_network', retryable: true },
  'fetch.timeout': { class: 'transient_network', retryable: true },
  'fetch.body_error': { class: 'transient_network', retryable: true },
  'fetch.aborted': { class: 'transient_network', retryable: true },
  'fetch.content_encoded': { class: 'permanent', retryable: false },
  'fetch.cross_origin_denied': { class: 'policy_denied', retryable: false },
  'fetch.extension_busy': { class: 'unavailable', retryable: true },
} as const satisfies Record<string, { class: ErrorClass; retryable: boolean }>;

export type ErrorCode = keyof typeof SPECS;

export const ERROR_CODES = Object.keys(SPECS) as ErrorCode[];

export function errorSpec(code: ErrorCode): { class: ErrorClass; retryable: boolean } {
  return SPECS[code];
}

const MAX_MESSAGE = 1024;
const MAX_DETAILS_BYTES = 8 * 1024;

/** Build an envelope. The message is scrubbed of URLs and clipped; details are dropped if oversized. */
export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): ErrorEnvelope {
  const spec = SPECS[code];
  const text = scrubUrls(message);
  const envelope: ErrorEnvelope = {
    code,
    class: spec.class,
    message: text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE - 1) + '…' : text,
    retryable: spec.retryable,
  };
  if (details && new TextEncoder().encode(JSON.stringify(details)).length <= MAX_DETAILS_BYTES) {
    envelope.details = details;
  }
  return envelope;
}

/** Throwable wrapper so request helpers can reject with a typed envelope. */
export class ZeusError extends Error {
  readonly envelope: ErrorEnvelope;
  constructor(envelope: ErrorEnvelope) {
    super(`${envelope.code}: ${envelope.message}`);
    this.name = 'ZeusError';
    this.envelope = envelope;
  }
}

export function isZeusError(value: unknown): value is ZeusError {
  return value instanceof ZeusError;
}

/** A numeric member of an envelope's `details`, or null. Details are open-ended peer data. */
export function detailNumber(envelope: ErrorEnvelope, key: string): number | null {
  const details = envelope.details as Record<string, unknown> | undefined;
  const value = details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Message key under which UIs look up the localised text for a code (dots become underscores). */
export function errorMessageKey(code: string): string {
  return 'err_' + code.replace(/[^a-z0-9_]/g, '_');
}
