// Authenticated workflow documents stay inside the explicitly approved browser profile.
// This service never reads cookies, copies credentials, follows redirects or interprets page text.
import { encodeBase64 } from '../lib/base64';
import type { Env } from '../lib/env';
import { makeError, ZeusError } from '../lib/errors';
import type { ExtBody, SessionPageRequestBody } from '../lib/protocol';
import { toWireTimestamp } from '../lib/time';
import type { ConsentGate } from './consent';

const ACCEPT = {
  html: 'text/html, application/xhtml+xml',
  json: 'application/json',
  xml: 'application/xml, text/xml',
  text: 'text/plain',
} as const;
const MAX_BYTES = 524_288;
const MAX_ACTIVE = 2;
type Reply = ExtBody<'session.page.response'>;

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function contentAllowed(value: string): boolean {
  const type = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    [
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'application/json',
      'application/xml',
      'text/xml',
    ].includes(type) || /^application\/[a-z0-9!#$&^_.+-]+\+(json|xml)$/.test(type)
  );
}

/** A bounded, cancelable page oracle whose only output is document data. */
export class PageService {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly env: Env,
    private readonly gate: ConsentGate,
    private readonly ready: () => boolean,
  ) {}

  /** Keep the native link alive while a reviewed page read is in progress. */
  openCount(): number {
    return this.active.size;
  }

  /** Disconnect loses authority immediately; no page reply can survive a new connection. */
  abortAll(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  /** Read one exact URL after an explicit plan/site or run/workflow grant check. */
  cancel(requestId: string): void {
    this.active.get(requestId)?.abort();
  }

  async read(body: SessionPageRequestBody, requestId: string): Promise<Reply> {
    if (!this.ready())
      return this.unavailable('nm.capability_missing', 'Browser page access was not negotiated.');
    if (body.incognito || this.env.api.env.isIncognitoContext)
      return this.unavailable(
        'session.store_unavailable',
        'Private-context page access is unavailable; no ordinary profile fallback is permitted.',
      );
    const url = new URL(body.url);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:' ||
      !host.includes('.') ||
      host.includes(':') ||
      /^[0-9.]+$/.test(host) ||
      ['localhost', 'local', 'internal', 'home', 'lan'].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    )
      return this.unavailable(
        'session.consent_denied',
        'Browser workflow pages require an exact public HTTPS origin.',
      );
    if (
      !Number.isInteger(body.max_body_bytes) ||
      body.max_body_bytes < 1 ||
      body.max_body_bytes > MAX_BYTES ||
      !Number.isInteger(body.deadline_ms) ||
      body.deadline_ms < 1000 ||
      body.deadline_ms > 25_000 ||
      !(body.representation in ACCEPT) ||
      url.hash !== ''
    )
      return this.unavailable('nm.schema_violation', 'Invalid bounded page request.');
    const request = {
      kind: 'page' as const,
      origin: body.origin,
      url: body.url,
      grant_id: body.grant_id,
      profile_id: body.profile_id,
      subject: body.subject,
    };
    const first = await this.gate.evaluate(request, body.deadline_ms);
    if (!first.ok) return { status: 'unavailable', error: first.error };
    if (this.active.size >= MAX_ACTIVE)
      return this.unavailable('fetch.extension_busy', 'Too many active page requests.');
    const controller = new AbortController();
    if (this.active.has(requestId))
      return this.unavailable('nm.schema_violation', 'Duplicate page request.');
    this.active.set(requestId, controller);
    const started = this.env.clock.mono();
    const maximum = Math.min(first.ttl_ms, body.deadline_ms);
    const state: { poll?: ReturnType<typeof setTimeout>; failure?: ZeusError } = {};
    const chunks: Uint8Array[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const check = async (): Promise<void> => {
      if (!this.ready() || controller.signal.aborted)
        throw new ZeusError(makeError('fetch.aborted', 'Page access was canceled.'));
      if (this.env.clock.mono() - started >= maximum)
        throw new ZeusError(makeError('fetch.timeout', 'The page deadline expired.'));
      const current = await this.gate.evaluate(request, maximum);
      if (!current.ok) throw new ZeusError(current.error);
    };
    const monitor = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      try {
        await check();
      } catch (error) {
        state.failure =
          error instanceof ZeusError
            ? error
            : new ZeusError(makeError('session.consent_denied', 'Page authority is unavailable.'));
        controller.abort();
        return;
      }
      state.poll = setTimeout(() => {
        void monitor();
      }, 100);
    };
    const timeout = setTimeout(() => {
      state.failure = new ZeusError(makeError('fetch.timeout', 'The page deadline expired.'));
      controller.abort();
    }, maximum);
    void monitor();
    try {
      await check();
      const response = await this.env.fetch(body.url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { Accept: ACCEPT[body.representation] },
        signal: controller.signal,
      });
      await check();
      if (
        response.redirected ||
        response.url !== new URL(body.url).href ||
        (response.status >= 300 && response.status < 400)
      )
        throw new ZeusError(
          makeError('fetch.cross_origin_denied', 'Page redirects are not authorized.'),
        );
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.length > 256 || hasControl(contentType) || !contentAllowed(contentType))
        throw new ZeusError(
          makeError('fetch.body_error', 'The response is not a supported document.'),
        );
      const link = response.headers.get('link');
      if (link !== null && (link.length > 4096 || hasControl(link)))
        throw new ZeusError(
          makeError('fetch.body_error', 'Document pagination metadata exceeds its limit.'),
        );
      reader = response.body?.getReader() ?? null;
      let bytes = 0;
      while (reader !== null) {
        await check();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > body.max_body_bytes)
          throw new ZeusError(
            makeError(
              'nm.frame_too_large',
              'The decoded document exceeds its reviewed byte limit.',
            ),
          );
        chunks.push(next.value);
      }
      await check();
      const bytesOut = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytesOut.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        // Refuse invalid UTF-8 instead of silently changing selectors' input.
        new TextDecoder('utf-8', { fatal: true }).decode(bytesOut);
        const issuedAt = toWireTimestamp(this.env.clock.now());
        if (issuedAt === null)
          throw new ZeusError(makeError('nm.internal', 'The browser clock is unavailable.'));
        return {
          status: 'fetched',
          document: {
            subject: body.subject,
            grant_id: body.grant_id,
            profile_id: body.profile_id,
            final_url: response.url,
            http_status: response.status,
            content_type: contentType,
            link,
            data: encodeBase64(bytesOut),
            issued_at: issuedAt,
          },
        };
      } finally {
        bytesOut.fill(0);
      }
    } catch (error) {
      const envelope = state.failure ?? (error instanceof ZeusError ? error : null);
      return envelope
        ? { status: 'unavailable', error: envelope.envelope }
        : this.unavailable('fetch.network_error', 'The authenticated page could not be read.');
    } finally {
      clearTimeout(timeout);
      if (state.poll !== undefined) clearTimeout(state.poll);
      controller.abort();
      if (reader !== null) await reader.cancel().catch(() => {});
      for (const chunk of chunks) chunk.fill(0);
      this.active.delete(requestId);
    }
  }

  private unavailable(code: Parameters<typeof makeError>[0], message: string): Reply {
    return { status: 'unavailable', error: makeError(code, message) };
  }
}
