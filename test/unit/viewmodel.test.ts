import { describe, expect, it } from 'vitest';
import type { Approval } from '../../src/lib/protocol';
import type { LinkView } from '../../src/lib/ui-protocol';
import {
  candidateNote,
  decisionButtons,
  formatBytes,
  formatDuration,
  jobActions,
  jobStateKey,
  linkBanner,
  progressOf,
  reasonKey,
} from '../../src/popup/viewmodel';
import { approvalId, jobId } from '../helpers/ids';

const link = (over: Partial<LinkView> = {}): LinkView => ({
  state: 'ready',
  close_reason: null,
  suspended_until_ms: null,
  connected: true,
  daemon_version: '0.1.0',
  protocol_version: 1,
  connection_id: null,
  capabilities: [],
  head_seq: 1,
  ...over,
});

const approval = (scopes: Approval['allowed_scopes']): Approval => ({
  id: approvalId(1),
  kind: 'handoff',
  state: 'pending',
  allowed_scopes: scopes,
  reason_codes: [],
  summary: { title: 'x' },
  created_at: '2026-10-05T09:15:30.301Z',
  expires_at: '2026-10-06T09:15:30.301Z',
  job_id: jobId(1),
});

describe('linkBanner', () => {
  it('tells a connected, idle, missing-host, forbidden and flapping link apart', () => {
    expect(linkBanner(link())).toMatchObject({
      tone: 'ok',
      titleKey: 'statusConnected',
      canReconnect: false,
    });
    expect(linkBanner(link({ connected: false, state: 'idle' }))).toMatchObject({
      tone: 'idle',
      titleKey: 'statusIdle',
    });
    expect(
      linkBanner(link({ connected: false, state: 'backoff', close_reason: 'host_not_found' })),
    ).toMatchObject({ tone: 'error', hintKey: 'hintHostMissing', canReconnect: true });
    expect(
      linkBanner(link({ connected: false, state: 'backoff', close_reason: 'forbidden' })),
    ).toMatchObject({ titleKey: 'statusForbidden' });
    expect(
      linkBanner(link({ connected: false, state: 'suspended', close_reason: 'host_not_found' })),
    ).toMatchObject({ titleKey: 'statusSuspended', canReconnect: true });
    expect(linkBanner(link({ connected: false, state: 'connecting' }))).toMatchObject({
      titleKey: 'statusConnecting',
    });
    expect(
      linkBanner(link({ connected: false, state: 'backoff', close_reason: 'host_exited' })),
    ).toMatchObject({ tone: 'warn', titleKey: 'statusDisconnected' });
  });
});

describe('decisionButtons', () => {
  it('offers exactly what the daemon allows, never offering a scope it did not list', () => {
    expect(
      decisionButtons(approval(['once', 'site', 'never'])).map((b) => [b.id, b.decision, b.scope]),
    ).toEqual([
      ['once', 'approve', 'once'],
      ['site', 'approve', 'site'],
      ['deny', 'deny', null],
      ['never', 'deny', 'never'],
    ]);
    expect(
      decisionButtons(approval(['once', 'site', 'workflow', 'never'])).map((b) => b.id),
    ).toEqual(['once', 'site', 'workflow', 'deny', 'never']);
    expect(decisionButtons(approval(['workflow'])).map((b) => b.id)).toEqual(['workflow', 'deny']);
  });
  it('turns an approval without scopes into a plain yes or no', () => {
    expect(decisionButtons(approval([])).map((b) => [b.id, b.decision, b.scope])).toEqual([
      ['approve', 'approve', null],
      ['deny', 'deny', null],
    ]);
  });
});

describe('job presentation', () => {
  it('offers only controls the state machine allows (spec 01 section 7)', () => {
    expect(jobActions('downloading')).toEqual(['pause', 'cancel']);
    expect(jobActions('paused')).toEqual(['resume', 'cancel']);
    expect(jobActions('failed')).toEqual(['retry']);
    expect(jobActions('finalizing')).toEqual([]);
    expect(jobActions('completed')).toEqual([]);
    expect(jobActions('verifying')).toEqual(['cancel']);
    expect(jobActions('awaiting_approval')).toEqual(['cancel']);
  });
  it('maps every state to a message key and computes progress', () => {
    for (const s of [
      'queued',
      'probing',
      'awaiting_approval',
      'awaiting_session',
      'downloading',
      'paused',
      'retry_scheduled',
      'verifying',
      'finalizing',
      'completed',
      'failed',
      'canceled',
    ]) {
      expect(jobStateKey(s)).toMatch(/^jobState[A-Z]/);
    }
    expect(progressOf({ bytes_done: 5, bytes_total: 10 })).toBe(0.5);
    expect(progressOf({ bytes_done: 5, bytes_total: null })).toBeNull();
    expect(progressOf({ bytes_done: 50, bytes_total: 10 })).toBe(1);
    expect(progressOf({ bytes_done: 0, bytes_total: 0 })).toBeNull();
  });
});

describe('formatting', () => {
  it('uses binary units only', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(1_288_490_188)).toBe('1.20 GiB');
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
  it('formats durations compactly', () => {
    expect(formatDuration(10_000)).toBe('< 1 min');
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(23 * 3_600_000)).toBe('23 h');
    expect(formatDuration(5 * 24 * 3_600_000)).toBe('5 d');
  });
  it('knows reason texts and leaves unknown codes to be shown as they are', () => {
    expect(reasonKey('handoff.interrupted')).toBe('reasonHandoffInterrupted');
    expect(reasonKey('weird.code')).toBeNull();
  });
});

describe('candidateNote', () => {
  const base = {
    id: 1,
    filename: 'a',
    origin: null,
    state: 'interrupted',
    bytes_received: 0,
    total_bytes: null,
    error: null,
    eligible: true,
    refusal: null,
    offer_status: null,
  } as const;
  it('explains refusals and only lets eligible, unsent downloads be forwarded', () => {
    expect(candidateNote({ ...base })).toMatchObject({
      canForward: true,
      refusalKey: null,
      stateKey: 'dlInterrupted',
    });
    expect(candidateNote({ ...base, eligible: false, refusal: 'security_decision' })).toMatchObject(
      { canForward: false, refusalKey: 'dlRefusedSecurity' },
    );
    expect(candidateNote({ ...base, eligible: false, refusal: 'dangerous' })).toMatchObject({
      refusalKey: 'dlRefusedDangerous',
    });
    expect(candidateNote({ ...base, offer_status: 'accepted' })).toMatchObject({
      canForward: false,
    });
    expect(candidateNote({ ...base, state: 'in_progress' })).toMatchObject({
      stateKey: 'dlInProgress',
    });
  });
});
