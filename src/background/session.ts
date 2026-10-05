// Session oracle (spec 02 section 8): answers session.request with scoped cookies and
// url.refresh.request with a freshly derived URL. Both run only after the consent gate. Cookie
// values exist in memory for the duration of one handler and are never logged or stored.
import type { Env } from '../lib/env';
import { makeError } from '../lib/errors';
import type { BrowserCookie } from '../lib/platform';
import type {
  Cookie,
  DaemonMessageOf,
  ErrorEnvelope,
  ExtBody,
  SessionMaterial,
  Validators,
} from '../lib/protocol';
import { redactUrl } from '../lib/redact';
import { utf8Length } from '../lib/sanitize';
import { toWireTimestamp } from '../lib/time';
import type { ConsentGate } from './consent';
import type { StateStore } from './state';

export type SessionReply =
  | { type: 'session.response'; body: ExtSessionBody }
  | { type: 'error'; body: { error: ErrorEnvelope } };

type ExtSessionBody = ExtBody<'session.response'>;
type RefreshBody = ExtBody<'url.refresh.response'>;

export type RefreshReply = { type: 'url.refresh.response'; body: RefreshBody };

const MAX_COOKIES_BYTES = 128 * 1024;
const MAX_CONCURRENT_RELEASES = 4;
const REFETCH_ABORT_MS = 25_000;
const DOWNLOAD_API_POLL_MS = 150;

const SESSION_HEADER_NAMES = [
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
] as const;

/** Compose an Accept-Language header the way browsers do: q-values step down by 0.1. */
export function formatAcceptLanguage(languages: readonly string[]): string {
  return languages
    .filter((l) => l !== '')
    .slice(0, 8)
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
    .join(',');
}

function toWireCookie(c: BrowserCookie): Cookie | null {
  if (c.name.length > 256 || c.domain.length > 255 || c.path.length > 1024) return null;
  if (c.value.length > 8192 || utf8Length(c.value) > 8192) return null;
  const expires =
    c.session || c.expirationDate === undefined
      ? null
      : toWireTimestamp(Math.round(c.expirationDate * 1000));
  const cookie: Cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    http_only: c.httpOnly,
    same_site: c.sameSite,
    host_only: c.hostOnly,
    expires_at: expires,
  };
  if (c.partitionKey?.topLevelSite !== undefined && c.partitionKey.topLevelSite.length <= 300) {
    cookie.partition_key = {
      top_level_site: c.partitionKey.topLevelSite,
      ...(c.partitionKey.hasCrossSiteAncestor === undefined
        ? {}
        : { has_cross_site_ancestor: c.partitionKey.hasCrossSiteAncestor }),
    };
  }
  return cookie;
}

/** Most specific cookies first (what browsers send first), then by name, so truncation is deterministic. */
function orderCookies(cookies: Cookie[]): Cookie[] {
  return [...cookies].sort((a, b) => b.path.length - a.path.length || a.name.localeCompare(b.name));
}

function fitLimits(cookies: Cookie[], maxCount: number): Cookie[] {
  const out: Cookie[] = [];
  let bytes = 2;
  for (const c of orderCookies(cookies)) {
    const size = utf8Length(JSON.stringify(c)) + 1;
    if (out.length >= maxCount || bytes + size > MAX_COOKIES_BYTES) break;
    out.push(c);
    bytes += size;
  }
  return out;
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
  private inFlight = 0;

  constructor(
    private readonly env: Env,
    private readonly gate: ConsentGate,
    private readonly store: StateStore,
    private readonly opts: { maxCookies: () => number; internalDownloadIds: Set<number> },
  ) {}

  // ---------- session.request ----------

  async handleSessionRequest(msg: DaemonMessageOf<'session.request'>): Promise<SessionReply> {
    const b = msg.body;
    const gate = await this.gate.evaluate(
      { kind: 'session', origin: b.origin, url: b.url, job_id: b.job_id, grant_id: b.grant_id },
      b.ttl_ms,
    );
    if (!gate.ok) {
      if (gate.status === 'invalid') return { type: 'error', body: { error: gate.error } };
      return { type: 'session.response', body: { status: gate.status, error: gate.error } };
    }
    if (this.inFlight >= MAX_CONCURRENT_RELEASES) {
      return unavailable('session.extension_busy', 'Too many concurrent session releases.');
    }
    // Replay protection: one session_id releases material at most once.
    if (!(await this.store.claimSessionId(b.session_id))) {
      return {
        type: 'error',
        body: {
          error: makeError('nm.conflict', 'This session_id was already used for a release.'),
        },
      };
    }
    this.inFlight += 1;
    try {
      let storeId: string | undefined;
      if (b.incognito) {
        storeId = await this.incognitoStoreId();
        if (storeId === undefined) {
          await this.store.releaseSessionClaim(b.session_id);
          return unavailable(
            'session.store_unavailable',
            'The private cookie store could not be identified.',
          );
        }
      }
      const cookies = await this.collectCookies(b.url, b.origin, storeId);
      const session: SessionMaterial = {
        session_id: b.session_id,
        origin: b.origin,
        issued_at: toWireTimestamp(this.env.clock.now()) ?? '1970-01-01T00:00:00.000Z',
        ttl_ms: gate.ttl_ms,
        cookies: fitLimits(cookies, this.opts.maxCookies()),
        user_agent: this.env.api.env.userAgent.slice(0, 512),
        headers: await this.sessionHeaders(b.request_headers),
      };
      if (storeId !== undefined) session.cookie_store_id = storeId;
      // Only counts and handles are logged, never names or values (spec 00 section 8).
      this.env.log.info('session released', {
        session_id: b.session_id,
        origin: b.origin,
        cookie_count: session.cookies.length,
        ttl_ms: session.ttl_ms,
      });
      return { type: 'session.response', body: { status: 'granted', session } };
    } catch (e) {
      await this.store.releaseSessionClaim(b.session_id);
      this.env.log.warn('cookie read failed', { error: e instanceof Error ? e.name : 'unknown' });
      return unavailable('session.store_unavailable', 'The cookie store could not be read.');
    } finally {
      this.inFlight -= 1;
    }
  }

  /** The cookie store of private windows, or undefined when it cannot be identified (spec 02 10.1). */
  private async incognitoStoreId(): Promise<string | undefined> {
    if (!(await this.env.api.extension.isAllowedIncognitoAccess())) return undefined;
    const stores = await this.env.api.cookies.getAllCookieStores();
    if (this.env.api.env.isFirefox) return stores.find((s) => s.id === 'firefox-private')?.id;
    for (const store of stores) {
      for (const tabId of store.tabIds) {
        try {
          if ((await this.env.api.tabs.get(tabId)).incognito) return store.id;
        } catch {
          /* tab closed meanwhile */
        }
      }
    }
    return undefined;
  }

  private async collectCookies(
    url: string,
    origin: string,
    storeId: string | undefined,
  ): Promise<Cookie[]> {
    const q = storeId === undefined ? { url } : { url, storeId };
    const raw = await this.env.api.cookies.getAll(q);
    // Partitioned (CHIPS) cookies are returned only when asked for by partition. Best effort: a
    // browser that rejects the query simply contributes none.
    const partitioned: BrowserCookie[] = await this.env.api.cookies
      .getAll({ ...q, partitionKey: { topLevelSite: origin } })
      .catch(() => []);
    const seen = new Set<string>();
    const out: Cookie[] = [];
    for (const c of [...raw, ...partitioned]) {
      const key = JSON.stringify([c.name, c.domain, c.path, c.partitionKey?.topLevelSite ?? '']);
      if (seen.has(key)) continue;
      seen.add(key);
      const wire = toWireCookie(c);
      if (wire) out.push(wire);
    }
    return out;
  }

  private async sessionHeaders(requested: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const env = this.env.api.env;
    for (const name of SESSION_HEADER_NAMES) {
      if (!requested.includes(name)) continue;
      if (name === 'accept-language') {
        const langs = await this.env.api.i18n.getAcceptLanguages();
        const value = formatAcceptLanguage(langs);
        if (value !== '') out[name] = value;
      } else if (env.userAgentData) {
        if (name === 'sec-ch-ua') {
          out[name] = env.userAgentData.brands
            .map((b) => `"${b.brand}";v="${b.version}"`)
            .join(', ');
        } else if (name === 'sec-ch-ua-mobile') {
          out[name] = env.userAgentData.mobile ? '?1' : '?0';
        } else {
          out[name] = `"${env.userAgentData.platform}"`;
        }
      }
    }
    return out;
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

function unavailable(
  code: 'session.extension_busy' | 'session.store_unavailable',
  message: string,
): SessionReply {
  return {
    type: 'session.response',
    body: { status: 'unavailable', error: makeError(code, message) },
  };
}
