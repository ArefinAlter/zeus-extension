// Browser identification for the hello message and offer keys (spec 02 section 5). Everything is
// derived from the user agent and the userAgentData brands; nothing identifies the user.
import type { ExtEnv } from './platform';
import type { BrowserName } from './protocol.generated';

export interface BrowserInfo {
  name: BrowserName;
  version: string;
  platform: string;
}

function platformOf(env: ExtEnv): string {
  const raw = env.userAgentData?.platform ?? env.userAgent;
  if (/windows|win32|win64/i.test(raw)) return 'win';
  if (/mac|darwin/i.test(raw)) return 'mac';
  if (/android/i.test(raw)) return 'android';
  if (/cros/i.test(raw)) return 'cros';
  if (/linux|x11/i.test(raw)) return 'linux';
  return 'other';
}

export function detectBrowser(env: ExtEnv): BrowserInfo {
  const ua = env.userAgent;
  const firefox = /\bFirefox\/(\d+(?:\.\d+)*)/.exec(ua);
  if (firefox?.[1] !== undefined)
    return { name: 'firefox', version: firefox[1], platform: platformOf(env) };
  const edge = /\bEdg(?:e|A|iOS)?\/(\d+(?:\.\d+)*)/.exec(ua);
  if (edge?.[1] !== undefined) return { name: 'edge', version: edge[1], platform: platformOf(env) };
  const brands = env.userAgentData?.brands.map((b) => b.brand.toLowerCase()) ?? [];
  const chrome = /\bChrome\/(\d+(?:\.\d+)*)/.exec(ua);
  const version = chrome?.[1] ?? '0';
  if (brands.some((b) => b.includes('brave')))
    return { name: 'brave', version, platform: platformOf(env) };
  if (chrome) {
    const chromium = brands.length > 0 && !brands.some((b) => b.includes('google chrome'));
    return { name: chromium ? 'chromium' : 'chrome', version, platform: platformOf(env) };
  }
  return { name: 'other', version: '0', platform: platformOf(env) };
}
