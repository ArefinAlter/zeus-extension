// The in-browser fetch proxy (spec 02 section 9): the daemon asks the user's real browser to fetch
// a byte range, inheriting the user's cookies, TLS fingerprint and device-bound session, and the
// extension streams the bytes back as base64 chunks under credit-based flow control. It only ever
// makes an ordinary credentialed request, exactly as if the user had clicked the link; it never
// alters headers to disguise anything. Every stream passes the consent gate first.
import type { Env } from '../lib/env';
import { makeError } from '../lib/errors';
import { encodeBase64 } from '../lib/base64';
import { originOf } from '../lib/origin';
import type {
  DaemonMessageOf,
  ErrorEnvelope,
  ExtBody,
  ExtMessageType,
  Limits,
} from '../lib/protocol';
import type { ConsentGate } from './consent';

const HEADER_ABORT_MAX_MS = 25_000;
const BODY_IDLE_MS = 25_000;
const CREDIT_STARVATION_MS = 90_000;
const HOLD_CANCEL_WAIT_MS = 10_000;

const RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'cf-mitigated',
  'content-digest',
  'content-disposition',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'date',
  'etag',
  'last-modified',
  'repr-digest',
  'retry-after',
  'server',
  'www-authenticate',
] as const;

type RangeBody = DaemonMessageOf<'fetch.range'>['body'];

export interface FetchProxyDeps {
  env: Env;
  gate: ConsentGate;
  limits: () => Limits;
  /** Post a frame on the native link; returns false when the link is not usable. */
  send: <T extends ExtMessageType>(
    type: T,
    body: ExtBody<T>,
    opts?: { re?: string; trusted?: boolean },
  ) => boolean;
}

/** What to do with a response body, decided without interpreting the status beyond safety. */
export type BodyPlan = { mode: 'stream'; limit: number | null } | { mode: 'hold' };

/**
 * The daemon classifies the status; the extension only guarantees it never labels bytes with
 * offsets they do not have. A 206 streams. A 200 to a ranged request that starts at 0 streams the
 * full body under the credit window; a 200 to a ranged request that starts later (the server ignored Range)
 * holds, because its bytes would carry the wrong offsets. Anything that is not a success holds
 * and waits for the daemon's cancel.
 */
export function planBody(status: number, range: RangeBody['range']): BodyPlan {
  if (status === 206) return { mode: 'stream', limit: range === null ? null : range.length };
  if (status === 200) {
    if (range === null) return { mode: 'stream', limit: null };
    return range.offset === 0 ? { mode: 'stream', limit: null } : { mode: 'hold' };
  }
  return { mode: 'hold' };
}

/** Re-chunks arbitrary reader output into pieces of exactly `size` bytes (the last may be shorter). */
export class ChunkAssembler {
  private buf: Uint8Array;
  private fill = 0;
  constructor(private readonly size: number) {
    this.buf = new Uint8Array(size);
  }
  /** Append bytes; returns every full chunk now available. */
  push(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let pos = 0;
    while (pos < bytes.length) {
      const take = Math.min(this.size - this.fill, bytes.length - pos);
      this.buf.set(bytes.subarray(pos, pos + take), this.fill);
      this.fill += take;
      pos += take;
      if (this.fill === this.size) {
        out.push(this.buf);
        this.buf = new Uint8Array(this.size);
        this.fill = 0;
      }
    }
    return out;
  }
  /** The final, possibly short, chunk; null when nothing is pending. */
  flush(): Uint8Array | null {
    if (this.fill === 0) return null;
    const rest = this.buf.slice(0, this.fill);
    this.fill = 0;
    return rest;
  }
}

class Stream {
  credits: number;
  chunks = 0;
  bytes = 0;
  ended = false;
  canceled = false;
  headSent = false;
  /**
   * True once a terminal message went out. A method, not a field read: the flags change across
   * awaits, which the compiler's flow analysis cannot see through property accesses.
   */
  isEnded(): boolean {
    return this.ended;
  }
  /** True when the daemon canceled the stream or consent for its origin disappeared. */
  shouldStop(): boolean {
    return this.canceled || this.abortError !== null;
  }
  /** Head sent for a response whose body is not streamed; waiting for the daemon's cancel. */
  held = false;
  abortError: ErrorEnvelope | null = null;
  timedOut = false;
  stalled = false;
  holdTimer: ReturnType<typeof setTimeout> | null = null;
  headerTimer: ReturnType<typeof setTimeout> | null = null;
  starveTimer: ReturnType<typeof setTimeout> | null = null;
  creditWaiter: (() => void) | null = null;
  readonly controller = new AbortController();
  constructor(
    readonly id: string,
    readonly requestId: string,
    readonly origin: string,
    readonly jobId: string,
    credits: number,
  ) {
    this.credits = credits;
  }
}

export class FetchProxy {
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly deps: FetchProxyDeps) {}

  /** Streams currently open; keeps the connection from idling out. */
  openCount(): number {
    return this.streams.size;
  }

  // ---------- inbound messages ----------

  handleRange(msg: DaemonMessageOf<'fetch.range'>): void {
    const b = msg.body;
    const limits = this.deps.limits();
    // The daemon slices ranges to max_range_bytes (spec 02 section 9.5 rule 7); a larger request is a protocol error.
    if (b.range !== null && b.range.length > limits.max_range_bytes) {
      this.deps.send(
        'error',
        {
          error: makeError('nm.schema_violation', 'The range exceeds max_range_bytes.', {
            max_range_bytes: limits.max_range_bytes,
          }),
        },
        { re: msg.id },
      );
      return;
    }
    if (this.streams.has(b.stream_id)) {
      this.deps.send(
        'error',
        {
          error: makeError('nm.duplicate_id', 'That stream id is already open.', {
            stream_id: b.stream_id,
          }),
        },
        { re: msg.id },
      );
      return;
    }
    if (this.streams.size >= limits.max_concurrent_streams) {
      this.deps.send(
        'error',
        { error: makeError('nm.too_many_streams', 'Too many open streams.') },
        { re: msg.id },
      );
      return;
    }
    const credits = Math.min(b.credits, limits.max_credit_window);
    const stream = new Stream(b.stream_id, msg.id, b.origin, b.job_id, credits);
    this.streams.set(stream.id, stream);
    void this.run(stream, b).catch((e: unknown) => {
      this.deps.env.log.error('fetch stream crashed', {
        stream_id: stream.id,
        error: e instanceof Error ? e.name : 'unknown',
      });
      this.fail(stream, makeError('nm.internal', 'The fetch stream failed unexpectedly.'));
    });
  }

  handleCredit(msg: DaemonMessageOf<'fetch.credit'>): void {
    const stream = this.streams.get(msg.body.stream_id);
    if (!stream) {
      this.deps.env.log.debug('credit for unknown stream', { stream_id: msg.body.stream_id });
      return;
    }
    stream.credits = Math.min(
      stream.credits + msg.body.credits,
      this.deps.limits().max_credit_window,
    );
    this.wakeCreditWaiter(stream);
  }

  handleCancel(msg: DaemonMessageOf<'fetch.cancel'>): void {
    const stream = this.streams.get(msg.body.stream_id);
    if (!stream) {
      this.deps.env.log.debug('cancel for unknown stream', { stream_id: msg.body.stream_id });
      return;
    }
    stream.canceled = true;
    stream.controller.abort();
    this.wakeCreditWaiter(stream);
    // A held stream has no body loop to finish it.
    if (stream.held) this.end(stream, 'canceled');
  }

  // ---------- lifecycle hooks ----------

  /** The connection closed: nothing can be sent any more. Drop all state. */
  abortAll(): void {
    for (const stream of this.streams.values()) {
      stream.ended = true;
      stream.canceled = true;
      this.clearTimers(stream);
      stream.controller.abort();
      this.wakeCreditWaiter(stream);
    }
    this.streams.clear();
  }

  /** Consent for an origin disappeared (revoked, expired or its permission was removed). */
  abortForOrigin(origin: string): void {
    for (const stream of this.streams.values()) {
      if (stream.origin !== origin || stream.ended) continue;
      stream.abortError = makeError(
        'session.consent_required',
        `Consent for ${origin} is no longer valid.`,
      );
      stream.controller.abort();
      this.wakeCreditWaiter(stream);
      if (stream.held) this.fail(stream, stream.abortError);
    }
  }

  // ---------- the stream ----------

  private async run(stream: Stream, b: RangeBody): Promise<void> {
    const gate = await this.deps.gate.evaluate({
      kind: 'fetch',
      origin: b.origin,
      url: b.url,
      job_id: b.job_id,
    });
    if (!gate.ok) {
      this.fail(stream, gate.error);
      return;
    }
    if (stream.ended) return;

    const headers: Record<string, string> = {};
    if (b.range !== null)
      headers.Range = `bytes=${b.range.offset}-${b.range.offset + b.range.length - 1}`;
    if (b.if_range !== undefined) headers['If-Range'] = b.if_range;
    if (b.request_headers?.accept !== undefined) headers.Accept = b.request_headers.accept;
    if (b.request_headers?.['accept-language'] !== undefined)
      headers['Accept-Language'] = b.request_headers['accept-language'];

    const headerTimer = setTimeout(
      () => {
        stream.timedOut = true;
        stream.controller.abort();
      },
      Math.min(b.deadline_ms, HEADER_ABORT_MAX_MS),
    );
    stream.headerTimer = headerTimer;

    let res: Response;
    try {
      res = await this.deps.env.fetch(b.url, {
        credentials: 'include',
        // A redirect can attach the browser's cookies before script sees its destination.
        // Until redirects can be authorized before following, refuse every redirect chain.
        redirect: 'error',
        cache: 'no-store',
        headers,
        signal: stream.controller.signal,
      });
    } catch {
      this.finishAborted(stream, 'fetch() rejected');
      return;
    } finally {
      clearTimeout(headerTimer);
      stream.headerTimer = null;
    }
    if (stream.isEnded()) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (stream.shouldStop()) {
      await res.body?.cancel().catch(() => undefined);
      this.finishAborted(stream, 'aborted');
      return;
    }

    // Content-Encoding: the browser decodes bodies itself, which would break byte ranges (spec 02 9.2 rule 2).
    const encoding = res.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      await res.body?.cancel().catch(() => undefined);
      this.fail(
        stream,
        makeError(
          'fetch.content_encoded',
          'The response is content-encoded; byte ranges would not be exact.',
        ),
      );
      return;
    }
    const finalUrl = res.url === '' ? b.url : res.url;
    if (
      originOf(finalUrl) === null ||
      (await this.deps.gate.checkRedirectTarget(finalUrl, b.origin)) === 'denied'
    ) {
      await res.body?.cancel().catch(() => undefined);
      this.fail(
        stream,
        makeError(
          'fetch.cross_origin_denied',
          'The redirect target has no consent for its cookies.',
        ),
      );
      return;
    }
    if (stream.isEnded()) return;

    const plan = planBody(res.status, b.range);
    stream.headSent = true;
    this.deps.send(
      'fetch.head',
      {
        stream_id: stream.id,
        status: res.status,
        final_url: finalUrl,
        redirected: res.redirected,
        headers: this.pickHeaders(res.headers),
      },
      { re: stream.requestId },
    );

    if (plan.mode === 'hold') {
      await res.body?.cancel().catch(() => undefined);
      // The daemon decides from the head and cancels; answer fetch.end then. Do not wait forever.
      stream.held = true;
      stream.holdTimer = setTimeout(() => {
        this.end(stream, 'canceled');
      }, HOLD_CANCEL_WAIT_MS);
      return;
    }
    await this.pump(stream, b, res, plan.limit);
  }

  private async pump(
    stream: Stream,
    b: RangeBody,
    res: Response,
    limit: number | null,
  ): Promise<void> {
    const chunkBytes = Math.min(b.chunk_bytes, this.deps.limits().max_chunk_bytes);
    const startOffset = b.range === null ? 0 : b.range.offset;
    const reader = res.body?.getReader();
    if (!reader) {
      this.end(stream, 'complete');
      return;
    }
    const assembler = new ChunkAssembler(chunkBytes);
    let received = 0;
    try {
      for (;;) {
        if (stream.canceled || stream.abortError !== null) break;
        const stallTimer = setTimeout(() => {
          stream.stalled = true;
          stream.controller.abort();
        }, BODY_IDLE_MS);
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } finally {
          clearTimeout(stallTimer);
        }
        if (step.done) break;
        let piece = step.value;
        if (limit !== null && received + piece.length > limit)
          piece = piece.subarray(0, limit - received);
        received += piece.length;
        for (const chunk of assembler.push(piece)) {
          if (!(await this.emit(stream, startOffset, chunk))) {
            this.finishAborted(stream, 'aborted');
            return;
          }
        }
        if (limit !== null && received >= limit) break;
      }
      if (stream.canceled || stream.abortError !== null) {
        this.finishAborted(stream, 'aborted');
        return;
      }
      const rest = assembler.flush();
      if (rest !== null && !(await this.emit(stream, startOffset, rest))) {
        this.finishAborted(stream, 'aborted');
        return;
      }
      this.end(stream, 'complete');
    } catch {
      this.finishAborted(stream, 'body read failed');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /** Wait for a credit, then send one chunk. Returns false when the stream was aborted meanwhile. */
  private async emit(stream: Stream, startOffset: number, chunk: Uint8Array): Promise<boolean> {
    while (stream.credits <= 0) {
      if (stream.ended || stream.canceled || stream.abortError !== null) return false;
      await new Promise<void>((resolve) => {
        stream.creditWaiter = resolve;
        stream.starveTimer = setTimeout(() => {
          stream.timedOut = true;
          stream.controller.abort();
          resolve();
        }, CREDIT_STARVATION_MS);
      });
      if (stream.starveTimer !== null) clearTimeout(stream.starveTimer);
      stream.starveTimer = null;
      stream.creditWaiter = null;
      if (stream.timedOut) return false;
    }
    if (stream.ended || stream.canceled || stream.abortError !== null) return false;
    stream.credits -= 1;
    const sent = this.deps.send(
      'fetch.chunk',
      {
        stream_id: stream.id,
        index: stream.chunks,
        offset: startOffset + stream.bytes,
        length: chunk.length,
        data: encodeBase64(chunk),
      },
      { trusted: true },
    );
    if (!sent) return false;
    stream.chunks += 1;
    stream.bytes += chunk.length;
    return true;
  }

  // ---------- terminal states ----------

  /** The stream stopped without completing: map why to the right terminal message. */
  private finishAborted(stream: Stream, detail: string): void {
    if (stream.ended) return;
    if (stream.abortError !== null) {
      this.fail(stream, stream.abortError);
      return;
    }
    if (stream.canceled) {
      this.end(stream, 'canceled');
      return;
    }
    if (stream.timedOut && !stream.headSent) {
      this.fail(stream, makeError('fetch.timeout', 'No response headers before the deadline.'));
      return;
    }
    if (stream.stalled) {
      this.fail(stream, makeError('fetch.body_error', 'The response body stalled.'));
      return;
    }
    if (stream.timedOut) {
      this.fail(stream, makeError('fetch.aborted', 'No credit arrived in time.'));
      return;
    }
    this.fail(
      stream,
      makeError(stream.headSent ? 'fetch.body_error' : 'fetch.network_error', `${detail}.`),
    );
  }

  private end(stream: Stream, reason: 'complete' | 'canceled'): void {
    if (stream.ended) return;
    stream.ended = true;
    this.clearTimers(stream);
    this.streams.delete(stream.id);
    this.deps.send('fetch.end', {
      stream_id: stream.id,
      reason,
      chunks: stream.chunks,
      bytes: stream.bytes,
    });
  }

  private fail(stream: Stream, error: ErrorEnvelope): void {
    if (stream.ended) return;
    stream.ended = true;
    this.clearTimers(stream);
    this.streams.delete(stream.id);
    stream.controller.abort();
    this.deps.send(
      'fetch.error',
      { stream_id: stream.id, error, bytes: stream.bytes },
      stream.headSent ? {} : { re: stream.requestId },
    );
  }

  private clearTimers(stream: Stream): void {
    for (const t of [stream.holdTimer, stream.headerTimer, stream.starveTimer])
      if (t !== null) clearTimeout(t);
    stream.holdTimer = null;
    stream.headerTimer = null;
    stream.starveTimer = null;
  }

  private wakeCreditWaiter(stream: Stream): void {
    const waiter = stream.creditWaiter;
    if (waiter) {
      stream.creditWaiter = null;
      waiter();
    }
  }

  private pickHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const v = headers.get(name);
      if (v !== null && v.length <= 8192) out[name] = v;
    }
    return out;
  }
}
