// Origins as defined by spec 01 section 4: scheme://host[:port] from the WHATWG URL parser,
// default port omitted, only http(s). Session material is released only for https origins and
// for http on loopback names.

const ORIGIN_SHAPE = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:[0-9]{1,5})?$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Origin of an absolute http(s) URL, or null when it is not one (or not representable). */
export function originOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const origin = `${u.protocol}//${u.host}`;
  return origin.length <= 300 && ORIGIN_SHAPE.test(origin) ? origin : null;
}

/** True for an absolute http(s) URL no longer than the 8192-byte protocol limit. */
export function isEligibleUrl(url: string): boolean {
  return url.length <= 8192 && originOf(url) !== null;
}

/** Spec 01 section 4 rule 3: https anywhere, http only for loopback hosts. */
export function isReleasableOrigin(origin: string): boolean {
  if (origin.startsWith('https://')) return true;
  if (!origin.startsWith('http://')) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(host);
}

/** Match pattern for the optional host permission that covers an origin. */
export function hostPattern(origin: string): string {
  return `${origin}/*`;
}
