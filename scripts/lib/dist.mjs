// Verification of a built extension directory: the generated manifest must match what the source
// produces, everything it references must exist, pages must be CSP-clean and bundles must not
// contain dynamic code evaluation. Shared by build.mjs (fails the build) and check.mjs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildManifest, checkManifest, messageKeysUsed, repoRoot } from './manifest.mjs';

/** @param {string} dir @returns {string[]} files below dir, relative, with forward slashes */
export function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out;
}

/** @param {unknown} v @param {string[]} acc @returns {string[]} string leaves of an object of file paths */
function leaves(v, acc = []) {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, acc);
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) leaves(x, acc);
  return acc;
}

/**
 * @param {string} dir built extension directory
 * @param {{ target: import('./manifest.mjs').Target, store: boolean }} opts
 * @returns {string[]} problems
 */
export function verifyDist(dir, { target, store }) {
  /** @type {string[]} */
  const problems = [];
  const bad = (/** @type {string} */ msg) => problems.push(`${relative(repoRoot, dir)}: ${msg}`);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    bad('manifest.json is missing');
    return problems;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expected = buildManifest({ target, store });
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    bad('manifest.json differs from the source manifests; rebuild');
  problems.push(...checkManifest(manifest, { target, store }));

  const files = new Set(listFiles(dir));
  const need = (/** @type {string} */ f, /** @type {string} */ why) => {
    if (!files.has(f)) bad(`${why} references missing file ${f}`);
  };
  need('THIRD_PARTY_NOTICES.md', 'bundled hashing library');
  for (const f of leaves(manifest.icons)) need(f, 'manifest icons');
  for (const f of leaves(manifest.action?.default_icon)) need(f, 'action icon');
  if (manifest.action?.default_popup) need(manifest.action.default_popup, 'action');
  if (manifest.options_ui?.page) need(manifest.options_ui.page, 'options_ui');
  if (manifest.background?.service_worker) need(manifest.background.service_worker, 'background');
  for (const f of manifest.background?.scripts ?? []) need(f, 'background');

  // localisation: the default locale exists and has every key the manifest uses
  const defaultMessages = join(dir, '_locales', String(manifest.default_locale), 'messages.json');
  if (!existsSync(defaultMessages)) {
    bad(`default locale ${String(manifest.default_locale)} is missing`);
  } else {
    const catalogue = JSON.parse(readFileSync(defaultMessages, 'utf8'));
    for (const key of messageKeysUsed(manifest))
      if (!(key in catalogue)) bad(`manifest uses __MSG_${key}__ but the catalogue lacks it`);
  }

  // pages: only local scripts and styles, nothing inline
  for (const page of ['popup/popup.html', 'options/options.html']) {
    if (!files.has(page)) {
      bad(`${page} is missing`);
      continue;
    }
    const html = readFileSync(join(dir, page), 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /\bsrc="([^"]+)"/.exec(m[1] ?? '')?.[1];
      if (!src) bad(`${page} has an inline script`);
      else if (/^[a-z]+:|^\/\//i.test(src)) bad(`${page} loads a remote script ${src}`);
      else if (!files.has(join(page, '..', src).replaceAll('\\', '/')))
        bad(`${page} references missing script ${src}`);
    }
    for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)) {
      const href = m[1] ?? '';
      if (/^[a-z]+:|^\/\//i.test(href)) bad(`${page} loads a remote resource ${href}`);
      else if (!files.has(join(page, '..', href).replaceAll('\\', '/')))
        bad(`${page} references missing file ${href}`);
    }
    if (/\son[a-z]+\s*=/i.test(html) || /\sstyle\s*=/i.test(html))
      bad(`${page} has inline event handlers or styles`);
  }

  // bundles: no dynamic code evaluation (the extension CSP forbids it and a reviewer will look)
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const code = readFileSync(join(dir, f), 'utf8');
    if (/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/.test(code))
      bad(`${f} contains dynamic code evaluation`);
    if (/importScripts\s*\(\s*["'`]https?:/.test(code)) bad(`${f} imports a remote script`);
    if (store && /sourceMappingURL=/.test(code))
      bad(`${f} carries a source map reference in a store build`);
  }
  if (store) for (const f of files) if (f.endsWith('.map')) bad(`store build contains ${f}`);
  return problems;
}
