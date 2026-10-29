import { describe, expect, it } from 'vitest';
import {
  DAEMON_MESSAGE_DEFS,
  EVENT_DEFS,
  EXT_MESSAGE_DEFS,
  REQUESTS,
  classifyEvent,
  frameBytes,
  makeFrame,
  parseDaemonFrame,
  type EventBase,
} from '../../src/lib/protocol';
import { daemonExamples, eventExamples, extensionExamples } from '../helpers/examples';

describe('protocol tables derived from the schema', () => {
  it('know every message type of both directions', () => {
    expect([...DAEMON_MESSAGE_DEFS.keys()].sort()).toEqual(
      [
        'approval.decide.response',
        'approval.list.response',
        'approval.pending',
        'bye',
        'error',
        'events.subscribe.response',
        'fetch.cancel',
        'fetch.credit',
        'fetch.range',
        'grant.list.response',
        'grant.revoke.response',
        'handoff.accept',
        'handoff.reject',
        'hello.ack',
        'job.control.response',
        'job.event',
        'job.list.response',
        'kill_switch.response',
        'ping',
        'pong',
        'session.request',
        'session.page.request',
        'session.page.cancel',
        'url.refresh.request',
      ].sort(),
    );
    expect(EXT_MESSAGE_DEFS.has('fetch.chunk')).toBe(true);
    expect(EXT_MESSAGE_DEFS.has('fetch.range')).toBe(false);
  });

  it('request catalogue only names real response types', () => {
    for (const spec of Object.values(REQUESTS)) {
      for (const r of spec.responses) expect(DAEMON_MESSAGE_DEFS.has(r)).toBe(true);
    }
    for (const type of Object.keys(REQUESTS)) expect(EXT_MESSAGE_DEFS.has(type)).toBe(true);
  });

  it('knows all events of the current catalogue', () => {
    expect(EVENT_DEFS.size).toBe(21);
  });
});

describe('parseDaemonFrame', () => {
  it('accepts every daemon-to-extension example of the spec', () => {
    expect(daemonExamples.length).toBeGreaterThanOrEqual(13);
    for (const ex of daemonExamples) {
      const result = parseDaemonFrame(ex.value);
      expect(
        result.ok,
        `${ex.source}:${ex.line} ${JSON.stringify(!result.ok ? result.issues : [])}`,
      ).toBe(true);
    }
  });

  it('rejects every extension-to-daemon-only type as unknown', () => {
    for (const ex of extensionExamples) {
      const type = (ex.value as { type: string }).type;
      if (DAEMON_MESSAGE_DEFS.has(type)) continue; // ping, pong, bye, error travel both ways
      const result = parseDaemonFrame(ex.value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('unknown_type');
    }
  });

  it('classifies malformed input without throwing', () => {
    const cases: [unknown, string][] = [
      [null, 'not_object'],
      [[], 'not_object'],
      ['text', 'not_object'],
      [{ v: 1, id: 'd1' }, 'schema_violation'],
      [{ v: 1, id: 'd1', type: 'nope', body: {} }, 'unknown_type'],
      [{ v: 2, id: 'd1', type: 'ping', body: {} }, 'schema_violation'],
      [{ v: 1, id: 'bad id!', type: 'ping', body: {} }, 'schema_violation'],
      [{ v: 1, id: 'd1', type: 'pong', body: {} }, 'schema_violation'], // pong needs re
      [
        { v: 1, id: 'd1', type: 'fetch.credit', body: { stream_id: 's1', credits: 0 } },
        'schema_violation',
      ],
    ];
    for (const [input, kind] of cases) {
      const result = parseDaemonFrame(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe(kind);
    }
  });

  it('reports readable id and response-ness so the caller can answer with re', () => {
    const result = parseDaemonFrame({ v: 1, id: 'd7', type: 'mystery', body: {} });
    expect(result).toMatchObject({ ok: false, kind: 'unknown_type', id: 'd7', isResponse: false });
    const response = parseDaemonFrame({ v: 1, id: 'd8', re: 'e1', type: 'mystery', body: {} });
    expect(response).toMatchObject({ ok: false, isResponse: true });
  });

  it('rejects nesting deeper than 32 (spec 02 section 13.2)', () => {
    let deep: unknown = {};
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const result = parseDaemonFrame({ v: 1, id: 'd1', type: 'ping', body: { nonce: 'x', deep } });
    expect(result).toMatchObject({ ok: false, kind: 'too_deep' });
  });

  it('limits reported issues to five', () => {
    const result = parseDaemonFrame({ v: 1, id: 'd1', type: 'hello.ack', re: 'e1', body: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('job.event leniency (spec 00 section 4 rule 7)', () => {
  const base = { v: 1, id: 'd1', type: 'job.event' } as const;

  it('accepts an event type this build does not know', () => {
    const frame = {
      ...base,
      body: {
        subscription_id: 'sub1',
        event: { seq: 5, ts: '2026-10-05T09:15:30.250Z', type: 'job.mystery', data: { a: 1 } },
      },
    };
    const parsed = parseDaemonFrame(frame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const event = (parsed.message.body as { event: EventBase }).event;
      expect(classifyEvent(event)).toEqual({
        known: false,
        type: 'job.mystery',
        reason: 'unknown_type',
      });
    }
  });

  it('still rejects an event without seq or after_seq', () => {
    const parsed = parseDaemonFrame({
      ...base,
      body: {
        subscription_id: 'sub1',
        event: { ts: '2026-10-05T09:15:30.250Z', type: 'job.created', data: {} },
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it('classifies every spec event example as known', () => {
    expect(eventExamples.length).toBeGreaterThanOrEqual(29);
    for (const ex of eventExamples) {
      expect(classifyEvent(ex.value as EventBase), `${ex.source}:${ex.line}`).toMatchObject({
        known: true,
      });
    }
  });

  it('flags a known type with a malformed payload as invalid', () => {
    const event = {
      seq: 1,
      ts: '2026-10-05T09:15:30.250Z',
      type: 'grant.created',
      data: { grant: {} },
    };
    expect(classifyEvent(event as EventBase)).toEqual({
      known: false,
      type: 'grant.created',
      reason: 'invalid',
    });
  });
});

describe('outbound frames', () => {
  it('builds the envelope and measures UTF-8 bytes like the length prefix', () => {
    const frame = makeFrame('e1', 'ping', {});
    expect(frame).toEqual({ v: 1, id: 'e1', type: 'ping', body: {} });
    expect(frameBytes(frame)).toBe(41); // spec 02 section 3.3 worked example
    expect(frameBytes({ s: 'é' })).toBe(JSON.stringify({ s: 'é' }).length + 1);
  });

  it('adds re only for responses', () => {
    expect(makeFrame('e2', 'pong', { nonce: 'n' }, 'd1')).toMatchObject({ re: 'd1' });
    expect('re' in makeFrame('e3', 'pong', {})).toBe(false);
  });
});
