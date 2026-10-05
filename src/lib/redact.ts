// redact_url (spec 00 section 8.2). Must reproduce schema/redaction-vectors.v1.json exactly:
// over-redaction is acceptable, under-redaction is a bug.

export type RedactMode = 'log' | 'record' | 'strict';

const DENY_NAME =
  /(^|[_.-])(token|key|secret|sig|signature|auth|authorization|password|passwd|pwd|credential|credentials|session|sessionid|sid|jwt|bearer|otp|code|state|nonce|policy|hmac|hdnts|sas)([_.-]|$)|^x-(amz|goog|ms)-|^(awsaccesskeyid|googleaccessid|access_token|id_token|refresh_token|api_key|apikey)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = Array.from(s).length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when a path segment or query value looks like a credential. */
export function looksSecret(value: string): boolean {
  let v: string;
  try {
    v = decodeURIComponent(value);
  } catch {
    v = value;
  }
  if (UUID.test(v)) return false;
  if (JWT.test(v)) return true;
  if (/^[0-9a-fA-F]{32,}$/.test(v)) return true;
  if (v.length < 24 || !/^[A-Za-z0-9_\-+/=~]+$/.test(v)) return false;
  // Human-readable slugs (three or more alphabetic words joined by - or _) are not credentials.
  if (v.split(/[-_]/).filter((p) => /^[A-Za-z]{3,}$/.test(p)).length >= 3) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length;
  return classes >= 3 && entropy(v) >= 4.0;
}

/** Returned for input that is not a parseable absolute URL; carries no part of the input. */
export const UNPARSEABLE_URL = 'invalid-url:';

export function redactUrl(input: string, mode: RedactMode): { url: string; redacted: boolean } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { url: UNPARSEABLE_URL, redacted: true };
  }
  let redacted = false;
  if (u.username !== '' || u.password !== '') redacted = true;
  if (u.hash !== '') redacted = true;
  const origin = `${u.protocol}//${u.host}`;

  let path = u.pathname;
  if (mode === 'log' || mode === 'strict') {
    path = path
      .split('/')
      .map((seg) => {
        if (seg !== '' && looksSecret(seg)) {
          redacted = true;
          return '…';
        }
        return seg;
      })
      .join('/');
  }

  let query = '';
  if (u.search !== '') {
    if (mode === 'record') {
      const kept: string[] = [];
      for (const pair of u.search.slice(1).split('&')) {
        if (pair === '') continue;
        const eq = pair.indexOf('=');
        const name = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? '' : pair.slice(eq + 1);
        let n = name;
        try {
          n = decodeURIComponent(name);
        } catch {
          /* keep raw */
        }
        if (DENY_NAME.test(n) || (value !== '' && looksSecret(value))) {
          redacted = true;
          continue;
        }
        kept.push(pair);
      }
      if (kept.length > 0) query = '?' + kept.join('&');
    } else {
      redacted = true;
      if (mode === 'log') query = '?…';
    }
  }
  return { url: origin + path + query, redacted };
}

/** Replace every http(s) URL inside free text by its `log` form. */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (m) => redactUrl(m, 'log').url);
}
