// The native-messaging link to zeus-native-host and zeusd (spec 02). Owns the port, the
// handshake and negotiation, request/response correlation with the catalogue's timeouts, the
// keepalive (ping and pong, reconnect with backoff, the flapping guard), malformed-frame handling
// and the idle policy that closes the port when Zeus has nothing to do. It knows nothing about
// handoffs, sessions or approvals: those are handlers registered by the application.
import type { Env } from '../lib/env';
import { ZeusError, makeError } from '../lib/errors';
import { MessageIds } from '../lib/ids';
import type { NativePort } from '../lib/platform';
import {
  DEFAULT_LIMITS,
  HOST_NAME,
  NOTIFICATION_CAPABILITY,
  REQUESTS,
  SUPPORTED_VERSIONS,
  frameBytes,
  makeFrame,
  parseDaemonFrame,
  type Capability,
  type DaemonMessage,
  type DaemonMessageOf,
  type ExtBody,
  type ExtMessageType,
  type Limits,
  type ParseFailure,
  type RequestType,
} from '../lib/protocol';

export type LinkState = 'idle' | 'connecting' | 'ready' | 'backoff' | 'suspended';

export type CloseReason =
  | 'host_not_found'
  | 'forbidden'
  | 'host_exited'
  | 'handshake_timeout'
  | 'pong_timeout'
  | 'protocol_error'
  | 'version_unsupported'
  | 'daemon_gone'
  | 'superseded'
  | 'idle'
  | 'stopped'
  | 'unknown';

/** What hello.ack taught us about the peer. */
export interface LinkInfo {
  connection_id: string;
  protocol_version: number;
  capabilities: readonly string[];
  limits: Limits;
  daemon: { version: string; instance_id: string };
  host_version: string;
  head_seq: number;
  server_time: string;
}

export interface LinkStatus {
  state: LinkState;
  closeReason: CloseReason | null;
  info: LinkInfo | null;
  /** Epoch ms until which reconnecting is suspended (flapping guard), else null. */
  suspendedUntilMs: number | null;
  /** Consecutive reconnect attempts since the last stable connection. */
  attempt: number;
}

export interface LinkHandlers {
  /** The handshake finished; the link is usable. */
  onReady(info: LinkInfo): void;
  /** A frame the daemon initiated (request or notification), after negotiation. */
  onFrame(message: DaemonMessage): void;
  /** The connection ended for any reason. */
  onClosed(reason: CloseReason): void;
  /** Any change of the externally visible status. */
  onStatus(status: LinkStatus): void;
}

export interface LinkDeps {
  handlers: LinkHandlers;
  /** Builds the hello body (profile id, capabilities, resume cursor). */
  buildHello(): Promise<ExtBody<'hello'>>;
  /** True while something needs the connection: open streams, pending requests, popup open. */
  isBusy(): boolean;
  /** Timing knobs, overridable in tests. */
  timing?: Partial<LinkTiming>;
}

export interface LinkTiming {
  helloTimeoutMs: number;
  idleCloseMs: number;
  stableAfterMs: number;
  shortLivedMs: number;
  suspendMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  backoffFloorMs: number;
}

const DEFAULT_TIMING: LinkTiming = {
  helloTimeoutMs: 10_000,
  idleCloseMs: 60_000,
  stableAfterMs: 60_000,
  shortLivedMs: 2_000,
  suspendMs: 300_000,
  backoffBaseMs: 500,
  backoffCapMs: 30_000,
  backoffFloorMs: 250,
};

const SHORT_LIVED_LIMIT = 5;
const VIOLATION_WINDOW_MS = 60_000;
const VIOLATION_LIMIT = 10;
const ERROR_REPLY_BUDGET_PER_MIN = 10;

interface Pending {
  type: string;
  expected: readonly string[];
  resolve: (message: DaemonMessage) => void;
  reject: (error: ZeusError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One native port from open to close. A new Conn is created for every reconnect. */
class Conn {
  readonly ids = new MessageIds();
  readonly pending = new Map<string, Pending>();
  readonly violations: number[] = [];
  readonly errorReplies: number[] = [];
  acked = false;
  info: LinkInfo | null = null;
  closing: CloseReason | null = null;
  openedMono = 0;
  helloTimer: ReturnType<typeof setTimeout> | null = null;
  pingTimer: ReturnType<typeof setInterval> | null = null;
  stableTimer: ReturnType<typeof setTimeout> | null = null;
  missedPongs = 0;
  pingCounter = 0;
  constructor(readonly port: NativePort) {}
}

function classifyDisconnect(text: string | undefined): CloseReason {
  if (text === undefined) return 'unknown';
  if (/not found|no such native application|not installed/i.test(text)) return 'host_not_found';
  if (/forbidden|not allowed|permission/i.test(text)) return 'forbidden';
  if (/exited|terminated|closed/i.test(text)) return 'host_exited';
  return 'unknown';
}

export class NativeLink {
  private readonly timing: LinkTiming;
  private state: LinkState = 'idle';
  private conn: Conn | null = null;
  private closeReason: CloseReason | null = null;
  private info: LinkInfo | null = null;
  private attempt = 0;
  private shortLived = 0;
  private suspendedUntil: number | null = null;
  private desired = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly env: Env,
    private readonly deps: LinkDeps,
  ) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  // ---------- public surface ----------

  status(): LinkStatus {
    return {
      state: this.state,
      closeReason: this.closeReason,
      info: this.info,
      suspendedUntilMs: this.suspendedUntil,
      attempt: this.attempt,
    };
  }

  isReady(): boolean {
    return this.state === 'ready' && this.conn?.acked === true;
  }

  hasCapability(capability: Capability): boolean {
    return this.info?.capabilities.includes(capability) === true && this.isReady();
  }

  limits(): Limits {
    return this.info?.limits ?? DEFAULT_LIMITS;
  }

  /** Open the port if it is not open (and the flapping guard allows it). */
  ensureConnected(): void {
    if (this.conn !== null) return;
    if (this.suspendedUntil !== null && this.env.clock.now() < this.suspendedUntil) return;
    this.suspendedUntil = null;
    this.open();
  }

  /** Drop the current connection (if any) and connect again now, clearing backoff and the flapping guard. */
  reconnectNow(): void {
    this.cancelReconnect();
    this.suspendedUntil = null;
    this.shortLived = 0;
    this.attempt = 0;
    if (this.conn !== null) this.closeConn(this.conn, 'stopped');
    this.open();
  }

  /** Called when the desired-connected condition changes (pending offers, approvals, browser jobs). */
  setDesired(desired: boolean): void {
    this.desired = desired;
    if (desired) this.ensureConnected();
    this.armIdle();
  }

  /** Something happened that should postpone the idle close. */
  touch(): void {
    this.armIdle();
  }

  /** Close deliberately (extension shutdown, tests). */
  stop(reason: CloseReason = 'stopped'): void {
    this.cancelReconnect();
    const conn = this.conn;
    if (conn === null) {
      this.setState('idle');
      return;
    }
    this.closeConn(conn, reason);
  }

  // ---------- sending ----------

  /**
   * Send a request and wait for its answer. Resolves with the typed response frame (handoff.reject
   * is a response, not an error). Rejects with a ZeusError for `error` frames, local timeouts and
   * missing capabilities.
   */
  request<T extends RequestType>(
    type: T,
    body: ExtBody<T & ExtMessageType>,
    opts: { timeoutMs?: number } = {},
  ): Promise<DaemonMessage> {
    const conn = this.conn;
    if (conn === null || (type !== 'hello' && !conn.acked)) {
      return Promise.reject(
        new ZeusError(makeError('nm.timeout', 'The native host is not connected.')),
      );
    }
    const spec = REQUESTS[type];
    if (spec.capability !== null && !this.info?.capabilities.includes(spec.capability)) {
      return Promise.reject(
        new ZeusError(
          makeError('nm.capability_missing', `The daemon does not offer ${spec.capability}.`, {
            capability: spec.capability,
          }),
        ),
      );
    }
    const id = conn.ids.next();
    return new Promise<DaemonMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new ZeusError(makeError('nm.timeout', `No answer to ${type} within the deadline.`)));
      }, opts.timeoutMs ?? spec.timeoutMs);
      conn.pending.set(id, { type, expected: spec.responses, resolve, reject, timer });
      try {
        this.post(conn, makeFrame(id, type as ExtMessageType, body as never));
      } catch (e) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(
          e instanceof ZeusError ? e : new ZeusError(makeError('nm.internal', 'Failed to send.')),
        );
      }
    });
  }

  /** Send a notification, or any frame that is not a request (replies, stream messages). */
  send<T extends ExtMessageType>(
    type: T,
    body: ExtBody<T>,
    opts: { re?: string; trusted?: boolean } = {},
  ): boolean {
    const conn = this.conn;
    if (conn === null || !conn.acked) return false;
    const capability = (NOTIFICATION_CAPABILITY as Record<string, Capability | null | undefined>)[
      type
    ];
    if (capability && !this.info?.capabilities.includes(capability)) return false;
    try {
      this.post(conn, makeFrame(conn.ids.next(), type, body, opts.re), opts.trusted === true);
      return true;
    } catch (e) {
      this.env.log.warn('send failed', {
        type,
        code: e instanceof ZeusError ? e.envelope.code : 'unknown',
      });
      return false;
    }
  }

  // ---------- connection lifecycle ----------

  private open(): void {
    this.cancelReconnect();
    this.setState('connecting');
    let port: NativePort;
    try {
      port = this.env.api.runtime.connectNative(HOST_NAME);
    } catch (e) {
      this.env.log.warn('connectNative threw', {
        error: e instanceof Error ? e.message : 'unknown',
      });
      this.afterClose(null, classifyDisconnect(e instanceof Error ? e.message : undefined), 0);
      return;
    }
    const conn = new Conn(port);
    conn.openedMono = this.env.clock.mono();
    this.conn = conn;
    port.onMessage.addListener((raw) => {
      if (this.conn === conn) this.onRaw(conn, raw);
    });
    port.onDisconnect.addListener((reason) => {
      this.onPortClosed(conn, reason);
    });
    conn.helloTimer = setTimeout(() => {
      this.closeConn(conn, 'handshake_timeout');
    }, this.timing.helloTimeoutMs);
    void this.handshake(conn);
  }

  private async handshake(conn: Conn): Promise<void> {
    let body: ExtBody<'hello'>;
    try {
      body = await this.deps.buildHello();
    } catch {
      this.closeConn(conn, 'unknown');
      return;
    }
    if (this.conn !== conn) return;
    this.request('hello', body).then(
      (ack) => {
        if (this.conn === conn && ack.type === 'hello.ack') this.onAck(conn, ack);
      },
      (e: unknown) => {
        if (this.conn !== conn) return;
        const code = e instanceof ZeusError ? e.envelope.code : '';
        this.closeConn(
          conn,
          code === 'nm.version_unsupported' ? 'version_unsupported' : 'protocol_error',
        );
      },
    );
  }

  private onAck(conn: Conn, ack: DaemonMessageOf<'hello.ack'>): void {
    const body = ack.body;
    if (!SUPPORTED_VERSIONS.includes(body.protocol_version)) {
      this.post(
        conn,
        makeFrame(conn.ids.next(), 'bye', {
          reason: 'protocol_error',
          message: 'unsupported protocol version',
        }),
      );
      this.closeConn(conn, 'version_unsupported');
      return;
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conn.acked = true;
    conn.info = {
      connection_id: body.connection_id,
      protocol_version: body.protocol_version,
      capabilities: body.capabilities,
      limits: body.limits,
      daemon: body.daemon,
      host_version: body.host.version,
      head_seq: body.head_seq,
      server_time: body.server_time,
    };
    this.info = conn.info;
    this.closeReason = null;
    this.setState('ready');
    conn.pingTimer = setInterval(() => {
      this.ping(conn);
    }, body.limits.ping_interval_ms);
    conn.stableTimer = setTimeout(() => {
      if (this.conn === conn) {
        this.attempt = 0;
        this.shortLived = 0;
      }
    }, this.timing.stableAfterMs);
    this.armIdle();
    this.deps.handlers.onReady(conn.info);
  }

  private ping(conn: Conn): void {
    if (this.conn !== conn || !conn.acked) return;
    conn.pingCounter += 1;
    this.request(
      'ping',
      { nonce: `p${conn.pingCounter}` },
      { timeoutMs: conn.info?.limits.pong_timeout_ms ?? 5000 },
    ).then(
      () => {
        conn.missedPongs = 0;
      },
      () => {
        conn.missedPongs += 1;
        if (conn.missedPongs >= 2 && this.conn === conn) this.closeConn(conn, 'pong_timeout');
      },
    );
  }

  /** The extension closes its own side. */
  private closeConn(conn: Conn, reason: CloseReason): void {
    if (conn.closing === null) conn.closing = reason;
    // A courtesy so the daemon can tell an idle close from a crash; delivery is best effort.
    if (reason === 'idle' && conn.acked) {
      try {
        this.post(conn, makeFrame(conn.ids.next(), 'bye', { reason: 'idle_timeout' }));
      } catch {
        /* the port is going away anyway */
      }
    }
    try {
      conn.port.disconnect();
    } catch {
      /* already gone */
    }
    // Chrome does not fire onDisconnect for a disconnect we initiated, so finish the teardown here.
    this.onPortClosed(conn, undefined);
  }

  private onPortClosed(conn: Conn, reasonText: string | undefined): void {
    if (this.conn !== conn) return;
    const reason = conn.closing ?? classifyDisconnect(reasonText);
    this.conn = null;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.stableTimer) clearTimeout(conn.stableTimer);
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new ZeusError(makeError('nm.timeout', 'The native connection closed.')));
      conn.pending.delete(id);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const lived = conn.acked ? this.env.clock.mono() - conn.openedMono : 0;
    this.afterClose(conn, reason, lived);
  }

  private afterClose(conn: Conn | null, reason: CloseReason, livedMs: number): void {
    this.closeReason = reason;
    this.info = conn?.info ?? this.info;
    this.deps.handlers.onClosed(reason);
    if (reason === 'idle' || reason === 'stopped') {
      this.setState('idle');
      return;
    }
    // Spec 02 section 4 rule 7: five connections in a row shorter than 2 s mean the host is broken.
    if (livedMs < this.timing.shortLivedMs) this.shortLived += 1;
    else this.shortLived = 0;
    if (this.shortLived >= SHORT_LIVED_LIMIT) {
      this.suspendedUntil = this.env.clock.now() + this.timing.suspendMs;
      this.shortLived = 0;
      this.setState('suspended');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.suspendedUntil = null;
        this.open();
      }, this.timing.suspendMs);
      return;
    }
    if (reason === 'superseded') {
      this.setState('idle'); // another instance owns the profile; the alarm reconnects if still desired
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState('backoff');
    const exponent = Math.min(this.attempt, 16);
    const cap = Math.min(this.timing.backoffCapMs, this.timing.backoffBaseMs * 2 ** exponent);
    const delay = Math.max(this.timing.backoffFloorMs, Math.floor(this.random() * cap));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private random(): number {
    const b = this.env.rng(4);
    return (
      ((((b[0] ?? 0) << 24) >>> 0) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) /
      4294967296
    );
  }

  // ---------- idle policy ----------

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.conn === null || this.desired) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const conn = this.conn;
      if (conn === null) return;
      if (this.desired || this.deps.isBusy() || conn.pending.size > 0) {
        this.armIdle();
        return;
      }
      this.closeConn(conn, 'idle');
    }, this.timing.idleCloseMs);
  }

  // ---------- inbound ----------

  private onRaw(conn: Conn, raw: unknown): void {
    const parsed = parseDaemonFrame(raw);
    if (!parsed.ok) {
      this.onBadFrame(conn, parsed);
      return;
    }
    const message = parsed.message;
    // Keepalive traffic says nothing about whether Zeus has work: it must not postpone the idle close.
    if (message.type !== 'ping' && message.type !== 'pong') this.touch();

    if (
      !conn.acked &&
      message.type !== 'hello.ack' &&
      message.type !== 'error' &&
      message.type !== 'bye'
    ) {
      this.env.log.debug('frame before hello.ack ignored', { type: message.type });
      return;
    }
    if (message.re !== undefined) {
      const pending = conn.pending.get(message.re);
      if (pending) {
        conn.pending.delete(message.re);
        clearTimeout(pending.timer);
        if (message.type === 'error') {
          pending.reject(new ZeusError(message.body.error));
        } else if (pending.expected.includes(message.type)) {
          pending.resolve(message);
        } else {
          pending.reject(
            new ZeusError(
              makeError(
                'nm.schema_violation',
                `Unexpected ${message.type} answering ${pending.type}.`,
              ),
            ),
          );
        }
        return;
      }
      if (message.type !== 'error' && message.type !== 'pong') {
        // A response with no waiting request: either a late answer after our timeout or a stray frame.
        this.env.log.debug('unmatched response dropped', { type: message.type });
      }
      if (message.type !== 'error') return;
    }

    switch (message.type) {
      case 'ping':
        this.send('pong', message.body.nonce === undefined ? {} : { nonce: message.body.nonce }, {
          re: message.id,
        });
        return;
      case 'pong':
        return;
      case 'bye':
        this.onBye(conn, message);
        return;
      case 'error':
        this.env.log.warn('daemon error', {
          code: message.body.error.code,
          class: message.body.error.class,
        });
        return;
      default:
        this.deps.handlers.onFrame(message);
    }
  }

  private onBye(conn: Conn, message: DaemonMessageOf<'bye'>): void {
    const reasonMap: Record<string, CloseReason> = {
      shutdown: 'daemon_gone',
      daemon_gone: 'daemon_gone',
      protocol_error: 'protocol_error',
      superseded: 'superseded',
      idle_timeout: 'idle',
      extension_unload: 'stopped',
    };
    const reason = reasonMap[message.body.reason] ?? 'unknown';
    this.env.log.info('daemon said bye', { reason: message.body.reason });
    this.closeConn(conn, reason);
  }

  /** Spec 02 sections 6.4 and 13.2: answer what can be answered, count violations, give up on floods. */
  private onBadFrame(conn: Conn, failure: ParseFailure): void {
    const now = this.env.clock.mono();
    if (failure.kind === 'unknown_type') {
      if (failure.isResponse || failure.id === undefined) {
        this.env.log.debug('unknown response type ignored', { type: failure.type });
        return;
      }
      this.replyError(
        conn,
        failure.id,
        makeError('nm.unknown_type', 'Unknown message type.', { type: failure.type ?? '' }),
      );
      return;
    }
    conn.violations.push(now);
    while (conn.violations.length > 0 && now - (conn.violations[0] ?? now) > VIOLATION_WINDOW_MS)
      conn.violations.shift();
    this.env.log.warn('invalid frame from daemon', { kind: failure.kind, type: failure.type });
    if (conn.violations.length >= VIOLATION_LIMIT) {
      this.send('bye', { reason: 'protocol_error', message: 'too many invalid frames' });
      this.closeConn(conn, 'protocol_error');
      return;
    }
    if (failure.id !== undefined && !failure.isResponse) {
      this.replyError(
        conn,
        failure.id,
        makeError('nm.schema_violation', 'The frame violates the protocol schema.', {
          errors: failure.issues
            .map((i) => `${i.path || '/'} ${i.message}`.slice(0, 120))
            .join('; '),
        }),
      );
    }
  }

  private replyError(conn: Conn, re: string, error: ReturnType<typeof makeError>): void {
    const now = this.env.clock.mono();
    while (conn.errorReplies.length > 0 && now - (conn.errorReplies[0] ?? now) > 60_000)
      conn.errorReplies.shift();
    if (conn.errorReplies.length >= ERROR_REPLY_BUDGET_PER_MIN) return;
    conn.errorReplies.push(now);
    this.send('error', { error }, { re });
  }

  // ---------- helpers ----------

  private post(conn: Conn, frame: ReturnType<typeof makeFrame>, trusted = false): void {
    if (!trusted) {
      const limit =
        conn.info?.limits.max_frame_to_daemon_bytes ?? DEFAULT_LIMITS.max_frame_to_daemon_bytes;
      if (frameBytes(frame) > limit) {
        throw new ZeusError(
          makeError('nm.frame_too_large', 'The frame exceeds the daemon-bound size limit.'),
        );
      }
    }
    conn.port.postMessage(frame);
    if (frame.type !== 'ping' && frame.type !== 'pong') this.touch();
  }

  private setState(state: LinkState): void {
    this.state = state;
    this.deps.handlers.onStatus(this.status());
  }
}
