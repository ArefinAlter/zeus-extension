// A scripted stand-in for zeus-native-host + zeusd on the far side of a MockNativePort.
// It answers the handshake and pings by default, lets tests script everything else, and validates
// every frame the extension sends against the normative schema with Ajv (the reference
// implementation), recording violations so tests can assert that the extension never emits an
// invalid frame.
import { ajvErrors, ajvValid } from '../helpers/ajv';
import { approvalId, connectionId, jobId } from '../helpers/ids';
import { fullRef } from '../helpers/examples';
import type { MockNativePort } from './mock-ext';

export type Frame = Record<string, unknown> & {
  type: string;
  id: string;
  body: Record<string, unknown>;
};

export interface DaemonOptions {
  /** Capabilities the daemon advertises; the ack carries the intersection with the extension's. */
  capabilities?: string[];
  limits?: Record<string, number>;
  headSeq?: number;
  /** Skip the automatic hello.ack (to test handshake timeouts). */
  silentHello?: boolean;
  /** Daemon-side protocol version reported in hello.ack. */
  protocolVersion?: number;
}

export const DAEMON_CAPABILITIES = [
  'handoff',
  'session',
  'url_refresh.refetch',
  'url_refresh.download_api',
  'fetch_proxy',
  'incognito',
  'approvals',
  'events',
  'job_control',
  'grants',
];

const DAEMON_ONLY = ['approvals', 'events', 'job_control', 'grants'];

export const DEFAULT_LIMITS = {
  max_frame_to_extension_bytes: 1_000_000,
  max_frame_to_daemon_bytes: 4_194_304,
  default_chunk_bytes: 262_144,
  max_chunk_bytes: 2_097_152,
  default_credit_window: 8,
  max_credit_window: 32,
  max_concurrent_streams: 4,
  max_range_bytes: 16_777_216,
  ping_interval_ms: 20_000,
  pong_timeout_ms: 5_000,
  max_cookie_count: 150,
  max_session_ttl_ms: 900_000,
};

type Handler = (frame: Frame, daemon: FakeDaemon) => void;

export class FakeDaemon {
  /** Every frame the extension sent, in order. */
  readonly frames: Frame[] = [];
  /** Schema violations in frames the extension sent. Must stay empty. */
  readonly violations: string[] = [];
  readonly handlers = new Map<string, Handler>();
  negotiated: string[] = [];
  private seq = 0;
  private offerCount = 0;

  constructor(
    readonly port: MockNativePort,
    opts: DaemonOptions = {},
  ) {
    port.onPosted = (raw) => {
      this.receive(raw as Frame);
    };
    this.handlers.set('hello', (f, d) => {
      if (opts.silentHello) return;
      const daemonCaps = opts.capabilities ?? DAEMON_CAPABILITIES;
      const offered = f.body.capabilities as string[];
      // Capabilities both sides declare are intersected; daemon-only ones are simply advertised.
      d.negotiated = daemonCaps.filter((c) => offered.includes(c) || DAEMON_ONLY.includes(c));
      d.reply(f, 'hello.ack', {
        protocol_version: opts.protocolVersion ?? 1,
        capabilities: d.negotiated,
        daemon: { version: '0.1.0', instance_id: '3f9a6c2d1b7e4a08c5d2e9f1a0b3c4d5' },
        host: { version: '0.1.0' },
        connection_id: connectionId(1),
        limits: { ...DEFAULT_LIMITS, ...opts.limits },
        server_time: '2026-10-05T09:14:50.120Z',
        head_seq: opts.headSeq ?? 100,
      });
    });
    this.handlers.set('ping', (f, d) => {
      d.reply(f, 'pong', f.body.nonce === undefined ? {} : { nonce: f.body.nonce });
    });
    this.handlers.set('events.subscribe', (f, d) => {
      d.reply(f, 'events.subscribe.response', {
        subscription_id: 'sub1',
        head_seq: opts.headSeq ?? 100,
        replay_count: 0,
        replay_truncated: false,
      });
    });
    this.handlers.set('job.list', (f, d) => {
      d.reply(f, 'job.list.response', { jobs: [], next_cursor: null });
    });
    this.handlers.set('handoff.offer', (f, d) => {
      this.offerCount += 1;
      d.reply(f, 'handoff.accept', {
        job_id: jobId(this.offerCount),
        state: 'awaiting_approval',
        approval_id: approvalId(this.offerCount),
        deduplicated: false,
      });
    });
  }

  private receive(frame: Frame): void {
    this.frames.push(frame);
    const ref = fullRef('native-messaging.v1#/$defs/ExtensionToDaemonMessage');
    if (!ajvValid(ref, frame)) {
      this.violations.push(`${frame.type}: ${ajvErrors(ref, frame)}`);
    }
    // Declared type decides which handler runs, so even invalid frames are answered consistently.
    this.handlers.get(frame.type)?.(frame, this);
  }

  /** Frames of one type the extension sent. */
  sent(type: string): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }

  /** Daemon-initiated frame with an auto-assigned id. Returns the id. Validates against the schema. */
  send(
    type: string,
    body: Record<string, unknown>,
    re?: string,
    opts: { skipValidation?: boolean } = {},
  ): string {
    this.seq += 1;
    const id = `d${this.seq}`;
    const frame: Record<string, unknown> = { v: 1, id, type, body };
    if (re !== undefined) frame.re = re;
    if (opts.skipValidation !== true) {
      const ref = fullRef('native-messaging.v1#/$defs/DaemonToExtensionMessage');
      if (!ajvValid(ref, frame)) {
        throw new Error(`test bug: invalid daemon frame ${type}: ${ajvErrors(ref, frame)}`);
      }
    }
    this.port.deliver(frame);
    return id;
  }

  reply(request: Frame, type: string, body: Record<string, unknown>): string {
    return this.send(type, body, request.id);
  }

  /** Deliver a raw object exactly as given (malformed frames, unknown types). */
  raw(frame: unknown): void {
    this.port.deliver(frame);
  }

  on(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  /** Remove the automatic reply for a type so the extension's request stays unanswered. */
  ignore(type: string): void {
    this.handlers.set(type, () => undefined);
  }
}
