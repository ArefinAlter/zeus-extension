// Browser session credentials stay inside the browser. Legacy cookie-export requests
// are rejected; URL refreshes continue through the scoped consent gate.
import type { Env } from '../lib/env';
import { makeError } from '../lib/errors';
import type { DaemonMessageOf, ErrorEnvelope, ExtBody, Validators } from '../lib/protocol';
import { redactUrl } from '../lib/redact';
import type { ConsentGate } from './consent';
import type { StateStore } from './state';

export type SessionReply =
  | { type: 'session.response'; body: ExtSessionBody }
  | { type: 'error'; body: { error: ErrorEnvelope } };

type ExtSessionBody = ExtBody<'session.response'>;
type RefreshBody = ExtBody<'url.refresh.response'>;

export type RefreshReply = { type: 'url.refresh.response'; body: RefreshBody };

const REFETCH_ABORT_MS = 25_000;
const DOWNLOAD_API_POLL_MS = 150;

/** Compose an Accept-Language header the way browsers do: q-values step down by 0.1. */
export function formatAcceptLanguage(languages: readonly string[]): string {
  return languages
    .filter((l) => l !== '')
    .slice(0, 8)
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
    .join(',');
}

function headerValue(headers: Headers, name: string): string | null {
  const v = headers.get(name);
  return v === null || v === '' ? null : v;
}

const HTML_EXTENSION = /\.(html?|xhtml)$/i;

/** True when an HTML response is a login or interstitial wall rather than the expected file. */
export function looksLikeHtmlWall(
  contentType: string | null,
  expectedFilename: string | undefined,
): boolean {
  if (contentType === null) return false;
  if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim())) return false;
  return !(expectedFilename !== undefined && HTML_EXTENSION.test(expectedFilename));
}

/** Validators from response headers (spec 01 section 3.4). */
export function validatorsFrom(headers: Headers): Validators {
  const etag = headerValue(headers, 'etag');
  const lastModified = headerValue(headers, 'last-modified');
  const date = headerValue(headers, 'date');
  let strong: boolean | null = null;
  if (lastModified !== null && date !== null) {
    const lm = Date.parse(lastModified);
    const d = Date.parse(date);
    strong = Number.isNaN(lm) || Number.isNaN(d) ? null : d - lm >= 1000;
  }
  return {
    etag,
    last_modified: lastModified,
    last_modified_strong: lastModified === null ? null : strong,
    repr_digest: headerValue(headers, 'repr-digest'),
  };
}

/** Total size from a Content-Range `bytes a-b/N` or, for a 200, Content-Length. */
export function totalBytesFrom(status: number, headers: Headers): number | null {
  const range = headerValue(headers, 'content-range');
  const m = range === null ? null : /^bytes\s+\d+-\d+\/(\d+)$/i.exec(range.trim());
  if (m?.[1] !== undefined) return Number(m[1]);
  if (status === 200) {
    const len = headerValue(headers, 'content-length');
    if (len !== null && /^\d+$/.test(len)) return Number(len);
  }
  return null;
}

export class SessionService {
  constructor(
    private readonly env: Env,
    private readonly gate: ConsentGate,
    _store: StateStore,
    private readonly opts: { maxCookies: () => number; internalDownloadIds: Set<number> },
  ) {}

  // ---------- session.request ----------

  handleSessionRequest(_msg: DaemonMessageOf<'session.request'>): Promise<SessionReply> {
    return Promise.resolve({
      type: 'session.response',
      body: {
        status: 'denied',
        error: makeError(
          'session.consent_denied',
          'Cookie export is disabled. Use the browser fetch proxy.',
        ),
      },
    });
  }

  // ---------- url.refresh.request ----------

  async handleUrlRefresh(msg: DaemonMessageOf<'url.refresh.request'>): Promise<RefreshReply> {
    const b = msg.body;
    const cannot = (error: ErrorEnvelope): RefreshReply => ({
      type: 'url.refresh.response',
      body: { status: 'cannot_refresh', error },
    });
    const gate = await this.gate.evaluate({
      kind: 'url_refresh',
      origin: b.origin,
      url: b.origin_url,
      job_id: b.job_id,
    });
    if (!gate.ok) return cannot(gate.error);

    const deadline = Math.min(b.deadline_ms, REFETCH_ABORT_MS);
    const startedAt = this.env.clock.mono();
    let loginRequired: ErrorEnvelope | null = null;
    let lastError: ErrorEnvelope | null = null;
    for (const method of b.methods) {
      const remaining = deadline - (this.env.clock.mono() - startedAt);
      if (remaining <= 0) break;
      const outcome =
        method === 'refetch'
          ? await this.refetch(b, remaining)
          : await this.downloadApi(b, remaining);
      if (outcome.kind === 'refreshed' || outcome.kind === 'unchanged')
        return { type: 'url.refresh.response', body: outcome.body };
      if (outcome.error.code === 'url.login_required') loginRequired ??= outcome.error;
      else lastError = outcome.error;
      if (outcome.error.code === 'fetch.cross_origin_denied') return cannot(outcome.error);
    }
    return cannot(
      loginRequired ??
        lastError ??
        makeError('url.refresh_failed', 'No refresh method produced a URL in time.'),
    );
  }

  private async refetch(
    b: DaemonMessageOf<'url.refresh.request'>['body'],
    timeoutMs: number,
  ): Promise<RefreshOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const res = await this.env.fetch(b.origin_url, {
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      });
      const finalUrl = res.url === '' ? b.origin_url : res.url;
      try {
        if ((await this.gate.checkRedirectTarget(finalUrl, b.origin)) === 'denied') {
          return fail(
            makeError(
              'fetch.cross_origin_denied',
              'The redirect target has no consent for its cookies.',
            ),
          );
        }
        if (res.status === 401) {
          return fail(
            makeError('url.login_required', 'The browser has no valid session for this site.'),
          );
        }
        if (res.status >= 400) {
          return fail(
            makeError('url.refresh_failed', `The origin answered ${res.status}.`, {
              status: res.status,
            }),
          );
        }
        if (looksLikeHtmlWall(res.headers.get('content-type'), b.expected?.filename)) {
          return fail(
            makeError('url.login_required', 'The origin served an HTML page instead of the file.'),
          );
        }
        if (finalUrl === b.stale_url) return { kind: 'unchanged', body: { status: 'unchanged' } };
        return {
          kind: 'refreshed',
          body: {
            status: 'refreshed',
            url: b.origin_url,
            final_url: finalUrl,
            method: 'refetch',
            validators: validatorsFrom(res.headers),
            total_bytes: totalBytesFrom(res.status, res.headers),
          },
        };
      } finally {
        await res.body?.cancel().catch(() => undefined);
      }
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return fail(
        makeError(
          'url.refresh_failed',
          aborted ? 'The refetch timed out.' : 'The refetch failed.',
          {
            url: redactUrl(b.origin_url, 'log').url,
          },
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async downloadApi(
    b: DaemonMessageOf<'url.refresh.request'>['body'],
    timeoutMs: number,
  ): Promise<RefreshOutcome> {
    const dl = this.env.api.downloads;
    let id: number;
    try {
      id = await dl.download({ url: b.origin_url, saveAs: false });
    } catch {
      return fail(makeError('url.refresh_failed', 'The browser refused to start the download.'));
    }
    this.opts.internalDownloadIds.add(id); // the rescue watcher must never offer our own refresh download
    const began = this.env.clock.mono();
    try {
      for (;;) {
        const [item] = await dl.search({ id });
        if (
          item &&
          item.finalUrl !== '' &&
          (item.state !== 'in_progress' ||
            item.bytesReceived > 0 ||
            item.finalUrl !== item.url ||
            this.env.clock.mono() - began > 400)
        ) {
          if ((await this.gate.checkRedirectTarget(item.finalUrl, b.origin)) === 'denied') {
            return fail(
              makeError(
                'fetch.cross_origin_denied',
                'The redirect target has no consent for its cookies.',
              ),
            );
          }
          if (looksLikeHtmlWall(item.mime === '' ? null : item.mime, b.expected?.filename)) {
            return fail(
              makeError(
                'url.login_required',
                'The browser downloaded an HTML page instead of the file.',
              ),
            );
          }
          if (item.state === 'interrupted' && item.error === 'SERVER_UNAUTHORIZED') {
            return fail(
              makeError('url.login_required', 'The browser has no valid session for this site.'),
            );
          }
          if (item.finalUrl === b.stale_url)
            return { kind: 'unchanged', body: { status: 'unchanged' } };
          return {
            kind: 'refreshed',
            body: {
              status: 'refreshed',
              url: b.origin_url,
              final_url: item.finalUrl,
              method: 'download_api',
              total_bytes: item.totalBytes >= 0 ? item.totalBytes : null,
            },
          };
        }
        if (item?.state === 'interrupted') {
          const code =
            item.error === 'SERVER_UNAUTHORIZED' ? 'url.login_required' : 'url.refresh_failed';
          return fail(makeError(code, 'The browser could not start the download.'));
        }
        if (this.env.clock.mono() - began >= timeoutMs) {
          return fail(
            makeError('url.refresh_failed', 'The browser did not report a final URL in time.'),
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, DOWNLOAD_API_POLL_MS));
      }
    } finally {
      // Cleanup is best effort: cancel, forget and remove any partial file.
      await dl.cancel(id).catch(() => undefined);
      await dl.erase({ id }).catch(() => undefined);
      await dl.removeFile(id).catch(() => undefined);
    }
  }
}

type RefreshOutcome =
  | { kind: 'refreshed'; body: Extract<RefreshBody, { status: 'refreshed' }> }
  | { kind: 'unchanged'; body: Extract<RefreshBody, { status: 'unchanged' }> }
  | { kind: 'failed'; error: ErrorEnvelope };

function fail(error: ErrorEnvelope): RefreshOutcome {
  return { kind: 'failed', error };
}
