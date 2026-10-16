import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  approvalBinding,
  bindCode,
  canonicalFacts,
  normalizeBindCode,
} from '../../src/lib/approval';
import type { Approval } from '../../src/lib/protocol';
import { specExamples } from '../helpers/examples';
import { World } from '../harness/world';

const sample = (): Record<string, unknown> =>
  structuredClone(
    specExamples.find(
      (e) => e.ref.endsWith('/ApprovalRequest') && (e.value as Approval).kind === 'handoff',
    )!.value,
  ) as Record<string, unknown>;
const bind = (r: Record<string, unknown>) => approvalBinding(r as unknown as Approval);
const hash = (r: Record<string, unknown>): void => {
  r.request_hash = bytesToHex(blake3(utf8ToBytes(canonicalFacts(r.facts))));
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('approval integrity, spec07', () => {
  it('recomputes the normative handoff vector and bind code', () => {
    const binding = bind(sample());
    expect(binding?.hash).toBe('09e8478513076b8b79ed19675402421a3cee9eb3d4c73487daa7bd63a55003ae');
    expect(binding?.code).toBe('17M-4F1');
    expect(bindCode('d4d34c4b2f2a7b6e3ec7e0d3dc742647bf84b9324eecb54980503876467b5324')).toBe(
      'TK9-MRJ',
    );
  });
  it('refuses altered facts, unknown nested members and unsafe numbers', () => {
    const changed = sample();
    (changed.facts as Record<string, unknown>).first_time_for_origin = false;
    expect(bind(changed)).toBeNull();
    const unknown = sample();
    ((unknown.facts as Record<string, unknown>).requester as Record<string, unknown>).extra = true;
    hash(unknown);
    expect(bind(unknown)).toBeNull();
    expect(() => canonicalFacts({ n: 2 ** 53 })).toThrow();
    expect(() => canonicalFacts({ n: 0.5 })).toThrow();
    expect(() => canonicalFacts({ text: '\ud800' })).toThrow();
  });
  it('binds revision, expiry, identity and agent text outside the facts', () => {
    for (const [key, value] of [
      ['revision', 2],
      ['expires_at', '2027-10-06T00:00:00.000Z'],
      ['requested_by', 'daemon'],
      ['agent_says', 'changed'],
    ] as const) {
      const request = sample();
      request[key] = value;
      expect(bind(request)).toBeNull();
    }
  });
  it('normalizes only the documented Crockford aliases', () => {
    expect(normalizeBindCode('oIl-23 4')).toBe('011234');
    expect(normalizeBindCode('x/y')).toBe('X/Y');
  });
  it('rejects a click from an older revision without sending a decision', async () => {
    const w = await new World().boot();
    w.ext.grant('https://portal.example.org');
    const old = sample();
    const latest = structuredClone(old);
    latest.revision = 2;
    (latest.facts as Record<string, unknown>).revision = 2;
    hash(latest);
    w.daemon.send('approval.pending', { approval: old });
    await w.settle();
    w.daemon.send('approval.pending', { approval: latest });
    await w.settle();
    const answer = await w.ext.sendFromPage({
      cmd: 'approval.decide',
      approval_id: old.id,
      request_hash: old.request_hash,
      revision: 1,
      decision: 'approve',
      scope: 'once',
      confirmation: 'gesture',
      user_gesture: true,
      surface: 'extension_popup',
    });
    expect(answer).toMatchObject({ ok: false, error: { code: 'policy.request_hash_mismatch' } });
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
  });
  it('requires the actual typed code for typed-code confirmation', async () => {
    const w = await new World().boot();
    w.ext.grant('https://portal.example.org');
    const request = sample();
    ((request.facts as Record<string, unknown>).confirmation as Record<string, unknown>).site =
      'typed_code';
    hash(request);
    w.daemon.send('approval.pending', { approval: request });
    await w.settle();
    const answer = await w.ext.sendFromPage({
      cmd: 'approval.decide',
      approval_id: request.id,
      request_hash: request.request_hash,
      revision: 1,
      decision: 'approve',
      scope: 'site',
      confirmation: 'typed_code',
      typed_code: 'WRONG',
      user_gesture: true,
      surface: 'extension_popup',
    });
    expect(answer).toMatchObject({ ok: false, error: { code: 'policy.human_required' } });
    expect(w.daemon.sent('approval.decide')).toHaveLength(0);
  });
});
