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

/** Valid cloud facts are carried for display, but only the terminal may decide them. */
export function cloudApproval(): Record<string, unknown> {
  const request = structuredClone(
    specExamples.find(
      (e) =>
        e.ref.endsWith('/ApprovalRequest') &&
        (e.value as Record<string, unknown>).kind === 'handoff',
    )!.value,
  ) as Record<string, unknown>;
  const original = request.facts as Record<string, unknown>;
  const plan = {
    plan_id: 'clp_01M45NHJ2AHWMXT8JVJ7BEEJ01',
    delivery_id: 'cld_01M45NHJ2AHWMXT8JVJ7BEEJ01',
    plan_hash: 'a'.repeat(64),
    account_id: 'archive',
    account_revision: 1,
    provider: 'google_drive',
    mode: 'staged_upload',
    source_redacted: 'https://downloads.example.org/',
    source_hash: 'b'.repeat(64),
    destination: 'drive-folder',
    remote_name: 'dataset.zip.zeus-cld_01M45NHJ2AHWMXT8JVJ7BEEJ01',
    size_bytes: 4,
    max_bytes: 4,
    max_seconds: 60,
    expected_sha256: 'c'.repeat(64),
    supported: true,
    allow_unbounded_remote: false,
    remote_cancellation_supported: false,
    hard_byte_cap: true,
    expires_at: request.expires_at,
  };
  request.kind = 'cloud_delivery';
  request.allowed_scopes = [];
  request.reason_codes = ['cloud.external_write'];
  delete request.origin;
  delete request.job_id;
  delete request.agent_says;
  request.summary = { title: 'Deliver dataset.zip to archive', source_kind: 'cli' };
  request.facts = {
    t: original.t,
    approval_id: request.id,
    revision: request.revision,
    kind: request.kind,
    requester: original.requester,
    issued_at: original.issued_at,
    expires_at: request.expires_at,
    allowed_scopes: request.allowed_scopes,
    confirmation: { approve: 'typed_code' },
    reason_codes: request.reason_codes,
    agent_says_blake3: null,
    delivery_id: plan.delivery_id,
    plan_blake3: plan.plan_hash,
    plan,
    shares_full_source_url_with_provider: false,
    remote_byte_cap_enforced: true,
    remote_cancellation_supported: false,
  };
  request.request_hash = bytesToHex(blake3(utf8ToBytes(canonicalFacts(request.facts))));
  return request;
}
