// Facts about approvals shared by the background and the popup.
import type { Approval } from './protocol.generated';

/** Approval kinds whose approval lets the extension release session material for `origin`. */
const SESSION_KINDS: ReadonlySet<string> = new Set(['handoff', 'session_grant', 'workflow_plan']);

/** Cloud writes are currently approved only on the physical Zeus terminal trust surface. */
export function approvalRequiresTerminal(approval: Approval): boolean {
  return approval.kind === 'cloud_delivery';
}

/**
 * True when approving this approval will lead to a release of cookies for its origin, so the
 * browser's optional host and cookie permissions must be granted first.
 */
export function needsBrowserAccess(approval: Approval): boolean {
  return approval.origin !== undefined && SESSION_KINDS.has(approval.kind);
}

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { schemas } from './protocol';

const APPROVAL_SCHEMA = 'https://zeus.invalid/schema/approvals.v1';
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** RFC 8785 for the spec's integer-only JSON subset. UTF-16 key ordering is JavaScript's default. */
export function canonicalFacts(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Facts require safe integers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('Invalid Unicode');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid Unicode');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFacts).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${canonicalFacts(k)}:${canonicalFacts(value[k])}`)
      .join(',')}}`;
  throw new Error('Facts must be JSON');
}

export function bindCode(hash: string): string {
  let n = parseInt(hash.slice(0, 8), 16) >>> 2;
  let code = '';
  for (let i = 0; i < 6; i++) {
    code = (BASE32[n & 31] ?? '0') + code;
    n >>>= 5;
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
export function normalizeBindCode(code: string): string {
  return code.toUpperCase().replace(/[ -]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
export interface ApprovalBinding {
  hash: string;
  revision: number;
  code: string;
  facts: Record<string, unknown>;
  confirmation: Record<string, unknown>;
  agentSays: string | null;
}

/** Recompute the binding before offering Approve. Unsupported facts fail closed. */
export function approvalBinding(approval: Approval): ApprovalBinding | null {
  if (approvalRequiresTerminal(approval)) return null;
  try {
    const raw = approval as unknown as Record<string, unknown>;
    if (!schemas.isValid(`${APPROVAL_SCHEMA}#/$defs/ApprovalRequest`, approval)) return null;
    const facts = raw.facts;
    if (!record(facts) || !schemas.isValidClosed(`${APPROVAL_SCHEMA}#/$defs/RequestFacts`, facts))
      return null;
    const bytes = utf8ToBytes(canonicalFacts(facts));
    if (bytes.byteLength > 16_384) return null;
    const hash = bytesToHex(blake3(bytes));
    if (
      hash !== raw.request_hash ||
      facts.approval_id !== approval.id ||
      facts.revision !== raw.revision ||
      facts.kind !== approval.kind ||
      facts.expires_at !== approval.expires_at
    )
      return null;
    if (
      canonicalFacts(facts.allowed_scopes) !== canonicalFacts(approval.allowed_scopes) ||
      canonicalFacts(facts.reason_codes) !== canonicalFacts(approval.reason_codes)
    )
      return null;
    if (facts.origin !== undefined && facts.origin !== (approval.origin ?? null)) return null;
    if (!record(facts.requester) || raw.requested_by !== (facts.requester.client_id ?? 'daemon'))
      return null;
    const agentSays = typeof raw.agent_says === 'string' ? raw.agent_says : null;
    if (
      facts.agent_says_blake3 !==
      (agentSays === null ? null : bytesToHex(blake3(utf8ToBytes(agentSays))))
    )
      return null;
    if (!record(facts.confirmation) || typeof raw.revision !== 'number') return null;
    return {
      hash,
      revision: raw.revision,
      code: bindCode(hash),
      facts,
      confirmation: facts.confirmation,
      agentSays,
    };
  } catch {
    return null;
  }
}
