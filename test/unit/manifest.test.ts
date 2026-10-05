import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  checkManifest,
  extensionIdFromKey,
  recordedDevExtensionId,
  repoRoot,
} from '../../scripts/lib/manifest.mjs';
import { extractExamples } from '../../scripts/lib/schema-sync.mjs';
import { ajvValid } from '../helpers/ajv';
import { fullRef } from '../helpers/examples';
import { schemas, nmRef } from '../../src/lib/protocol';

type M = Record<string, unknown>;

const chromeDev = () => buildManifest({ target: 'chrome', store: false });
const chromeStore = () => buildManifest({ target: 'chrome', store: true });
const firefox = () => buildManifest({ target: 'firefox', store: false });

describe('shipped manifests', () => {
  it('satisfy every invariant in every browser and mode', () => {
    for (const target of ['chrome', 'firefox'] as const) {
      for (const store of [false, true]) {
        expect(
          checkManifest(buildManifest({ target, store }), { target, store }),
          `${target} store=${store}`,
        ).toEqual([]);
      }
    }
  });

  it('declare the minimal permission set and no static host access', () => {
    const m = chromeStore();
    expect(m.permissions).toEqual([
      'alarms',
      'downloads',
      'nativeMessaging',
      'notifications',
      'storage',
    ]);
    expect(m.optional_permissions).toEqual(['cookies']);
    expect(m.host_permissions).toBeUndefined();
    expect(m.content_scripts).toBeUndefined();
    expect(m.externally_connectable).toBeUndefined();
    expect(m.optional_host_permissions).toEqual([
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
  });

  it('pins a stable id in dev builds and carries no key in store builds', () => {
    const key = chromeDev().key as string;
    expect(extensionIdFromKey(key)).toBe(recordedDevExtensionId());
    expect(extensionIdFromKey(key)).toMatch(/^[a-p]{32}$/);
    expect('key' in chromeStore()).toBe(false);
    expect('key' in firefox()).toBe(false);
  });

  it('uses the event page form and a gecko id on Firefox, the service worker on Chrome', () => {
    const f = firefox();
    expect((f.background as M).scripts).toEqual(['background/index.js']);
    expect((f.background as M).service_worker).toBeUndefined();
    const gecko = (f.browser_specific_settings as M).gecko as M;
    expect(gecko.id).toBe('zeus@zeus.invalid');
    expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
    expect((chromeDev().background as M).service_worker).toBe('background/index.js');
  });

  it('sets a restrictive extension-page CSP', () => {
    const csp = (chromeDev().content_security_policy as M).extension_pages as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe|http|\*/);
  });
});

describe('the manifest check catches regressions', () => {
  const problems = (m: M, target: 'chrome' | 'firefox' = 'chrome', store = true) =>
    checkManifest(m, { target, store });
  const mutate = (base: M, patch: M): M => ({ ...structuredClone(base), ...patch });

  it('rejects a broad static host permission', () => {
    expect(
      problems(mutate(chromeStore(), { host_permissions: ['<all_urls>'] })).join('\n'),
    ).toMatch(/forbidden key host_permissions/);
  });
  it('rejects a permission that is not on the allow-list', () => {
    const m = mutate(chromeStore(), {
      permissions: ['alarms', 'downloads', 'nativeMessaging', 'notifications', 'storage', 'tabs'],
    });
    expect(problems(m).join('\n')).toMatch(/permission "tabs" is not on the allow-list/);
  });
  it('rejects static cookies and broad optional hosts', () => {
    const m = mutate(chromeStore(), {
      permissions: [
        'alarms',
        'downloads',
        'nativeMessaging',
        'notifications',
        'storage',
        'cookies',
      ],
      optional_host_permissions: ['<all_urls>'],
    });
    const text = problems(m).join('\n');
    expect(text).toMatch(/cookies must be an optional permission/);
    expect(text).toMatch(/optional host pattern "<all_urls>"/);
  });
  it('rejects a store build with a key, and a dev build without one or with a foreign one', () => {
    expect(problems(mutate(chromeStore(), { key: chromeDev().key })).join('\n')).toMatch(
      /store build must omit "key"/,
    );
    const noKey = { ...chromeDev() };
    delete noKey.key;
    expect(problems(noKey, 'chrome', false).join('\n')).toMatch(
      /dev build must carry the public "key"/,
    );
    const other = mutate(chromeDev(), { key: Buffer.from('some other key').toString('base64') });
    expect(problems(other, 'chrome', false).join('\n')).toMatch(/docs\/EXTENSION_ID.md/);
  });
  it('rejects a weak CSP and content scripts', () => {
    const weak = mutate(chromeStore(), {
      content_security_policy: {
        extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'none'",
      },
    });
    expect(problems(weak).join('\n')).toMatch(/CSP allows remote, inline or eval sources/);
    expect(
      problems(
        mutate(chromeStore(), { content_scripts: [{ matches: ['https://*/*'], js: ['x.js'] }] }),
      ).join('\n'),
    ).toMatch(/forbidden key content_scripts/);
    expect(
      problems(
        mutate(chromeStore(), { externally_connectable: { matches: ['https://*/*'] } }),
      ).join('\n'),
    ).toMatch(/externally_connectable/);
  });
  it('rejects a Firefox manifest without a gecko id or data-collection declaration', () => {
    const m = structuredClone(firefox());
    delete (m.browser_specific_settings as M).gecko;
    expect(problems(m, 'firefox', false).join('\n')).toMatch(/gecko is required/);
    const weak = structuredClone(firefox());
    ((weak.browser_specific_settings as M).gecko as M).strict_min_version = '115.0';
    expect(problems(weak, 'firefox', false).join('\n')).toMatch(/strict_min_version/);
  });
});

describe('native host manifest templates', () => {
  const read = (name: string) => readFileSync(join(repoRoot, 'native-host', name), 'utf8');

  it('validate against the HostManifest schemas once their placeholders are filled in', () => {
    const chrome = JSON.parse(
      read('dev.zeus.native_host.chrome.json.template')
        .replaceAll('__EXTENSION_ID__', recordedDevExtensionId() ?? '')
        .replaceAll('__HOST_PATH__', 'C:\\\\Program Files\\\\Zeus\\\\zeus-native-host.exe'),
    );
    const firefox = JSON.parse(
      read('dev.zeus.native_host.firefox.json.template')
        .replaceAll('__ADDON_ID__', 'zeus@zeus.invalid')
        .replaceAll('__HOST_PATH__', '/usr/local/bin/zeus-native-host'),
    );
    expect(ajvValid(fullRef('native-messaging.v1#/$defs/HostManifestChrome'), chrome)).toBe(true);
    expect(schemas.isValid(nmRef('HostManifestChrome'), chrome)).toBe(true);
    expect(ajvValid(fullRef('native-messaging.v1#/$defs/HostManifestFirefox'), firefox)).toBe(true);
    expect(schemas.isValid(nmRef('HostManifestFirefox'), firefox)).toBe(true);
  });
});

describe('spec example extraction', () => {
  it('reads json and jsonl fences with a validate target and skips the rest', () => {
    const md = [
      '```json validate=native-messaging.v1#/$defs/PingMessage',
      '{"v":1,"id":"e1","type":"ping","body":{}}',
      '```',
      '```jsonl validate=domain#/$defs/Event',
      '{"a":1}',
      '',
      '{"a":2}',
      '```',
      '```json fragment',
      '{"skip":true}',
      '```',
      '```json validate=audit-record.v1#/$defs/Record',
      '{"other":"schema"}',
      '```',
    ].join('\r\n');
    const out = extractExamples(md, 'x.md');
    expect(out.map((e: { ref: string; value: unknown }) => [e.ref, e.value])).toEqual([
      ['native-messaging.v1#/$defs/PingMessage', { v: 1, id: 'e1', type: 'ping', body: {} }],
      ['domain#/$defs/Event', { a: 1 }],
      ['domain#/$defs/Event', { a: 2 }],
    ]);
  });
});
