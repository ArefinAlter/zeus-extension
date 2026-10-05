// Manifest generation and invariant checking, shared by build.mjs, check.mjs and the unit tests.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @typedef {'chrome' | 'firefox'} Target */
/** @typedef {Record<string, unknown>} Manifest */

/** Permissions the extension may declare. Anything else fails `npm run check`. */
export const ALLOWED_PERMISSIONS = [
  'alarms',
  'downloads',
  'nativeMessaging',
  'notifications',
  'storage',
];
/** Permissions that may only be optional (requested from a user gesture at consent time). */
export const ALLOWED_OPTIONAL_PERMISSIONS = ['cookies'];
/** Host patterns that may be requested at runtime. Never the all-urls or any-scheme wildcard patterns. */
export const ALLOWED_OPTIONAL_HOSTS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];
/** Manifest keys that would widen the attack surface and are therefore forbidden outright. */
export const FORBIDDEN_KEYS = [
  'host_permissions',
  'content_scripts',
  'externally_connectable',
  'web_accessible_resources',
  'devtools_page',
  'omnibox',
  'chrome_url_overrides',
  'declarative_net_request',
  'sandbox',
];
export const FIREFOX_ID = 'zeus@zeus.invalid';
export const FIREFOX_MIN_VERSION = 140;

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Chrome extension id from the base64 DER SubjectPublicKeyInfo carried in the manifest `key`:
 * the first 16 bytes of its SHA-256, each nibble mapped to a letter a-p.
 * @param {string} keyBase64
 */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {unknown}
 */
function merge(a, b) {
  if (isPlainObject(a) && isPlainObject(b)) {
    /** @type {Record<string, unknown>} */
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
    return out;
  }
  return b; // arrays and scalars: the override replaces
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {{ target: Target, store: boolean, root?: string }} opts
 * @returns {Manifest}
 */
export function buildManifest({ target, store, root = repoRoot }) {
  const pkg = readJson(join(root, 'package.json'));
  const base = readJson(join(root, 'src', 'manifest.base.json'));
  const override = readJson(join(root, 'src', `manifest.${target}.json`));
  /** @type {Record<string, unknown>} */
  let manifest = /** @type {Record<string, unknown>} */ (merge(base, override));
  const [numeric = '0.0.0', ...pre] = String(pkg.version).split('-');
  manifest.version = numeric;
  if (target === 'chrome') {
    manifest.version_name = store
      ? String(pkg.version)
      : `${pkg.version}${pre.length ? '' : '-dev'}`;
    if (!store) {
      // Dev builds pin the extension id so the native-host manifest can name it.
      manifest = { ...manifest, ...readJson(join(root, 'src', 'manifest.dev.json')) };
    }
  }
  return sortKeys(manifest);
}

/** @param {Record<string, unknown>} m */
function sortKeys(m) {
  const order = [
    'manifest_version',
    'name',
    'short_name',
    'version',
    'version_name',
    'description',
    'default_locale',
  ];
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of order) if (k in m) out[k] = m[k];
  for (const k of Object.keys(m)) if (!(k in out)) out[k] = m[k];
  return out;
}

/** The id recorded in docs/EXTENSION_ID.md (first 32-letter a-p token after "Dev extension id"). */
export function recordedDevExtensionId(root = repoRoot) {
  const file = join(root, 'docs', 'EXTENSION_ID.md');
  if (!existsSync(file)) return null;
  const m = /Dev extension id[^\n]*?`([a-p]{32})`/.exec(readFileSync(file, 'utf8'));
  return m?.[1] ?? null;
}

/**
 * Verify the invariants of one generated manifest.
 * @param {Manifest} m
 * @param {{ target: Target, store: boolean, root?: string }} opts
 * @returns {string[]} violations (empty when the manifest is acceptable)
 */
export function checkManifest(m, { target, store, root = repoRoot }) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} msg */
  const bad = (msg) => problems.push(`${target}${store ? ' (store)' : ' (dev)'}: ${msg}`);
  /** @param {unknown} v */
  const strs = (v) => (Array.isArray(v) ? v.map(String) : []);

  if (m.manifest_version !== 3) bad('manifest_version must be 3');
  for (const k of FORBIDDEN_KEYS) if (k in m) bad(`forbidden key ${k}`);

  const permissions = strs(m.permissions);
  for (const p of permissions)
    if (!ALLOWED_PERMISSIONS.includes(p)) bad(`permission "${p}" is not on the allow-list`);
  for (const p of ALLOWED_PERMISSIONS)
    if (!permissions.includes(p)) bad(`required permission "${p}" is missing`);
  for (const p of strs(m.optional_permissions)) {
    if (!ALLOWED_OPTIONAL_PERMISSIONS.includes(p))
      bad(`optional permission "${p}" is not on the allow-list`);
  }
  if (permissions.includes('cookies')) bad('cookies must be an optional permission, never static');
  const hosts = strs(m.optional_host_permissions);
  for (const h of hosts)
    if (!ALLOWED_OPTIONAL_HOSTS.includes(h))
      bad(`optional host pattern "${h}" is not on the allow-list`);
  for (const p of [...permissions, ...hosts]) {
    if (/<all_urls>|\*:\/\/\*\/\*/.test(p)) bad(`broad pattern ${p}`);
  }

  const csp = isPlainObject(m.content_security_policy)
    ? m.content_security_policy.extension_pages
    : undefined;
  if (typeof csp !== 'string') {
    bad('content_security_policy.extension_pages is missing');
  } else {
    if (!/script-src 'self'(;|$)/.test(csp)) bad("CSP must restrict script-src to 'self'");
    if (!/object-src 'none'/.test(csp)) bad("CSP must set object-src 'none'");
    if (/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:|data:|blob:|\*/.test(csp))
      bad('CSP allows remote, inline or eval sources');
  }

  const background = isPlainObject(m.background) ? m.background : {};
  if (target === 'chrome') {
    if (typeof background.service_worker !== 'string') bad('background.service_worker is required');
    if ('scripts' in background) bad('Chrome build must not use background.scripts');
    if ('browser_specific_settings' in m)
      bad('browser_specific_settings belongs to the Firefox build');
    if (store && 'key' in m) bad('the store build must omit "key"');
    if (!store) {
      if (typeof m.key !== 'string') {
        bad('dev build must carry the public "key" so the extension id is stable');
      } else {
        const id = extensionIdFromKey(m.key);
        const recorded = recordedDevExtensionId(root);
        if (recorded !== id)
          bad(`dev key yields id ${id} but docs/EXTENSION_ID.md records ${recorded ?? 'nothing'}`);
      }
    }
  } else {
    if (!Array.isArray(background.scripts) || background.scripts.length === 0)
      bad('background.scripts is required');
    if ('service_worker' in background) bad('Firefox build must not use background.service_worker');
    if ('key' in m) bad('Firefox manifests must not carry "key"');
    if ('minimum_chrome_version' in m) bad('minimum_chrome_version belongs to the Chrome build');
    const gecko =
      isPlainObject(m.browser_specific_settings) && isPlainObject(m.browser_specific_settings.gecko)
        ? m.browser_specific_settings.gecko
        : null;
    if (!gecko) {
      bad('browser_specific_settings.gecko is required');
    } else {
      if (gecko.id !== FIREFOX_ID) bad(`gecko.id must be ${FIREFOX_ID}`);
      if (Number.parseInt(String(gecko.strict_min_version), 10) < FIREFOX_MIN_VERSION) {
        bad(
          `gecko.strict_min_version must be at least ${FIREFOX_MIN_VERSION} (data_collection_permissions)`,
        );
      }
      const dcp = isPlainObject(gecko.data_collection_permissions)
        ? gecko.data_collection_permissions
        : null;
      if (!dcp || JSON.stringify(dcp.required) !== '["none"]')
        bad('gecko.data_collection_permissions.required must be ["none"]');
    }
  }

  const pkg = readJson(join(root, 'package.json'));
  if (m.version !== String(pkg.version).split('-')[0])
    bad('manifest version differs from package.json');
  if (m.default_locale !== 'en') bad('default_locale must be en');
  return problems;
}

/**
 * Names referenced as __MSG_<name>__ anywhere in the manifest.
 * @param {Manifest} m
 */
export function messageKeysUsed(m) {
  return [...JSON.stringify(m).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((x) => x[1] ?? '');
}
