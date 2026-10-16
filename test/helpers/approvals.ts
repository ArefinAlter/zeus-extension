import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalFacts } from '../../src/lib/approval';
import { specExamples } from './examples';

/** Build current spec07 fixtures explicitly at the call site; the fake daemon never repairs frames. */
export function withBinding(base: Record<string, unknown>): Record<string, unknown> {
  const example = specExamples.find(
    (e) =>
      e.ref.endsWith('/ApprovalRequest') && (e.value as Record<string, unknown>).kind === base.kind,
  );
  if (!example) throw new Error(`missing approval example for ${String(base.kind)}`);
  const request = structuredClone(example.value) as Record<string, unknown>;
  Object.assign(request, base);
  const facts = request.facts as Record<string, unknown>;
  facts.approval_id = request.id;
  facts.revision = request.revision;
  facts.kind = request.kind;
  facts.expires_at = request.expires_at;
  facts.allowed_scopes = request.allowed_scopes;
  facts.reason_codes = request.reason_codes;
  if ('origin' in facts) facts.origin = request.origin ?? null;
  const scopes = request.allowed_scopes as string[];
  facts.confirmation = Object.fromEntries(
    (scopes.length ? scopes.filter((s) => s !== 'never') : ['approve']).map((s) => [s, 'gesture']),
  );
  if (request.job_id) {
    if ('job_id' in facts) facts.job_id = request.job_id;
    if (facts.transfer) (facts.transfer as Record<string, unknown>).job_ids = [request.job_id];
  }
  const text = request.agent_says as string | undefined;
  facts.agent_says_blake3 = text ? bytesToHex(blake3(utf8ToBytes(text))) : null;
  request.request_hash = bytesToHex(blake3(utf8ToBytes(canonicalFacts(facts))));
  return request;
}

export function decisionBinding(request: Record<string, unknown>): Record<string, unknown> {
  return {
    request_hash: request.request_hash,
    revision: request.revision,
    confirmation: 'gesture',
  };
}
