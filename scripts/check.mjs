// `npm run check`: the repository invariants that typecheck, lint and the tests do not cover.
//   1. Manifest invariants for every browser and mode (permission allow-list, no broad static host
//      permissions, CSP, key present in dev builds and absent from store builds, stable dev id).
//   2. Built output in dist/ (when present) matches the sources and is CSP-clean.
//   3. Localisation: en and bn have the same keys and placeholders, every message the code asks
//      for exists, the manifest's keys exist.
//   4. Contract copies: schema/ matches its lock file and, when the zeus checkout is available, the
//      checkout; the generated protocol types match the schema.
//   5. Supply chain: only the pinned hashing dependency; host manifest templates satisfy schema.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { verifyDist } from './lib/dist.mjs';
import {
  FIREFOX_ID,
  buildManifest,
  checkManifest,
  extensionIdFromKey,
  messageKeysUsed,
  recordedDevExtensionId,
  repoRoot,
} from './lib/manifest.mjs';
import {
  LOCK_FILE,
  buildSchemaFiles,
  findSpecDir,
  normalizeNewlines,
  sha256,
} from './lib/schema-sync.mjs';
import { GENERATED_FILE, generateTypes } from './lib/types-gen.mjs';

let failures = 0;
/** @param {string} msg */
const fail = (msg) => {
  failures++;
  console.error('FAIL ' + msg);
};
/** @param {string} msg */
const ok = (msg) => console.log('ok   ' + msg);

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));

// ---------- 1. manifests ----------
for (const target of /** @type {const} */ (['chrome', 'firefox'])) {
  for (const store of [false, true]) {
    const problems = checkManifest(buildManifest({ target, store }), { target, store });
    problems.forEach(fail);
    if (problems.length === 0) ok(`manifest ${target} ${store ? 'store' : 'dev'}`);
  }
}
{
  const dev = buildManifest({ target: 'chrome', store: false });
  const id = typeof dev.key === 'string' ? extensionIdFromKey(dev.key) : null;
  if (id !== null && id === recordedDevExtensionId())
    ok(`dev extension id ${id} matches docs/EXTENSION_ID.md`);
  else fail('dev extension id does not match docs/EXTENSION_ID.md');
}

// ---------- 2. built output ----------
for (const [dir, target, store] of /** @type {const} */ ([
  ['dist/chrome', 'chrome', false],
  ['dist/firefox', 'firefox', false],
  ['dist/store/chrome', 'chrome', true],
  ['dist/store/firefox', 'firefox', true],
])) {
  if (!existsSync(join(repoRoot, dir))) continue;
  const problems = verifyDist(join(repoRoot, dir), { target, store });
  problems.forEach(fail);
  if (problems.length === 0) ok(`built ${dir}`);
}

// ---------- 3. localisation ----------
{
  const en = readJson('_locales/en/messages.json');
  const bn = readJson('_locales/bn/messages.json');
  const placeholders = (/** @type {Record<string, any>} */ c, /** @type {string} */ k) =>
    Object.keys(c[k]?.placeholders ?? {})
      .sort()
      .join(',');
  let local = 0;
  for (const k of Object.keys(en)) {
    if (!(k in bn)) {
      fail(`_locales/bn lacks "${k}"`);
      local++;
    } else if (placeholders(en, k) !== placeholders(bn, k)) {
      fail(`placeholders of "${k}" differ between en and bn`);
      local++;
    }
    for (const name of Object.keys(en[k].placeholders ?? {})) {
      if (!en[k].message.toUpperCase().includes(`$${name.toUpperCase()}$`)) {
        fail(`en "${k}" defines placeholder ${name} but does not use it`);
        local++;
      }
    }
  }
  for (const k of Object.keys(bn)) {
    if (!(k in en)) {
      fail(`_locales/en lacks "${k}" (present in bn)`);
      local++;
    }
  }
  for (const [name, catalogue] of [
    ['en', en],
    ['bn', bn],
  ]) {
    for (const [k, v] of Object.entries(catalogue)) {
      if (typeof v.message !== 'string' || v.message.trim() === '') {
        fail(`${name} "${k}" is empty`);
        local++;
      }
    }
  }
  for (const key of messageKeysUsed(buildManifest({ target: 'chrome', store: true }))) {
    if (!(key in en)) {
      fail(`manifest uses __MSG_${key}__ missing from en`);
      local++;
    }
  }
  // every message key referenced from the sources
  const prefixes =
    'btn|status|hint|section|empty|approvalKind|label|source|cookie|reason|access|jobState|job|dl|err|errClass|notif|opt|scope|ext|action|popup|open';
  const keyShape = new RegExp(`^(${prefixes})([A-Z_][A-Za-z0-9_]*)?$`);
  /** @param {string} dir @returns {string[]} */
  const sources = (dir) =>
    readdirSync(join(repoRoot, dir)).flatMap((f) => {
      const p = join(dir, f);
      return statSync(join(repoRoot, p)).isDirectory() ? sources(p) : [p];
    });
  const seen = new Set();
  for (const file of sources('src')) {
    if (file.endsWith('protocol.generated.ts')) continue;
    const text = readFileSync(join(repoRoot, file), 'utf8');
    const literals = [
      ...[...text.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map((m) => m[1] ?? ''),
      ...[...text.matchAll(/data-i18n(?:-title|-label)?="([A-Za-z0-9_]+)"/g)].map(
        (m) => m[1] ?? '',
      ),
    ];
    for (const lit of literals) {
      if (lit.endsWith('_') || !keyShape.test(lit) || !/[A-Z_]/.test(lit.slice(1))) continue; // keys are camelCase or err_*; a trailing _ is a prefix
      if (lit in en || seen.has(`${file}:${lit}`)) continue;
      // a literal can legitimately look like a key (a CSS class, an object property); only report known shapes
      if (
        /^(btn|status|hint|section|approvalKind|reason|jobState|dl|notif|opt|scope|source|label)[A-Z]/.test(
          lit,
        ) ||
        /^err(Class)?_/.test(lit)
      ) {
        seen.add(`${file}:${lit}`);
        fail(`${file} uses message key "${lit}" which en lacks`);
        local++;
      }
    }
  }
  if (local === 0) ok(`localisation: ${Object.keys(en).length} messages in en and bn`);
}

// ---------- 4. contracts ----------
{
  const schemaDir = join(repoRoot, 'schema');
  const lockPath = join(schemaDir, LOCK_FILE);
  let local = 0;
  if (!existsSync(lockPath)) {
    fail(`schema/${LOCK_FILE} is missing`);
    local++;
  } else {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const [name, digest] of Object.entries(lock.files)) {
      const p = join(schemaDir, name);
      if (!existsSync(p) || sha256(normalizeNewlines(readFileSync(p, 'utf8'))) !== digest) {
        fail(`schema/${name} differs from ${LOCK_FILE}`);
        local++;
      }
    }
  }
  const specDir = findSpecDir(repoRoot, process.env.ZEUS_REPO);
  if (specDir) {
    for (const [name, content] of buildSchemaFiles(specDir)) {
      const p = join(schemaDir, name);
      if (!existsSync(p) || normalizeNewlines(readFileSync(p, 'utf8')) !== content) {
        fail(
          `schema/${name.replaceAll('\\', '/')} has drifted from ${specDir}: run npm run sync:schema`,
        );
        local++;
      }
    }
    if (local === 0) ok(`schema copies match ${relative(process.cwd(), specDir) || specDir}`);
  } else {
    console.warn(
      'note: no zeus checkout found (set ZEUS_REPO); only schema/' + LOCK_FILE + ' was verified',
    );
    if (local === 0) ok('schema copies match their lock file');
  }
  const generated = await generateTypes();
  if (!existsSync(GENERATED_FILE) || readFileSync(GENERATED_FILE, 'utf8') !== generated) {
    fail('src/lib/protocol.generated.ts is stale: run npm run gen:types');
  } else {
    ok('generated protocol types are up to date');
  }
}

// ---------- 5. supply chain and host manifests ----------
{
  const pkg = readJson('package.json');
  const runtime = Object.keys(pkg.dependencies ?? {});
  if (runtime.length !== 1 || pkg.dependencies['@noble/hashes'] !== '2.4.0')
    fail('runtime dependencies must contain only the pinned @noble/hashes 2.4.0');
  else ok('only pinned @noble/hashes is bundled; no remote runtime code');
  if (!existsSync(join(repoRoot, 'package-lock.json'))) fail('package-lock.json is missing');

  const devId = recordedDevExtensionId() ?? '';
  const chrome = readFileSync(
    join(repoRoot, 'native-host', 'dev.zeus.native_host.chrome.json.template'),
    'utf8',
  )
    .replaceAll('__EXTENSION_ID__', devId)
    .replaceAll('__HOST_PATH__', 'C:\\\\Program Files\\\\Zeus\\\\zeus-native-host.exe');
  const firefox = readFileSync(
    join(repoRoot, 'native-host', 'dev.zeus.native_host.firefox.json.template'),
    'utf8',
  )
    .replaceAll('__ADDON_ID__', FIREFOX_ID)
    .replaceAll('__HOST_PATH__', '/usr/local/bin/zeus-native-host');
  // validated structurally here; the full schema validation runs in the test suite
  const c = JSON.parse(chrome);
  const f = JSON.parse(firefox);
  if (c.name !== 'dev.zeus.native_host' || f.name !== 'dev.zeus.native_host')
    fail('host manifest templates must name dev.zeus.native_host');
  else if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(c.allowed_origins?.[0] ?? ''))
    fail('chrome host template must pin one exact extension origin');
  else if (
    c.allowed_origins.length !== 1 ||
    JSON.stringify(f.allowed_extensions) !== JSON.stringify([FIREFOX_ID])
  )
    fail('host templates must pin exactly the extension ids');
  else ok('native host manifest templates');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
