// Builds the extension into dist/<target> (development: carries the dev key on Chrome, source maps)
// or dist/store/<target> (--store: no key, no source maps), one directory per browser, then
// verifies the output.
//
//   node scripts/build.mjs [--target chrome|firefox|all] [--store]
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyDist } from './lib/dist.mjs';
import { buildManifest, repoRoot } from './lib/manifest.mjs';

const args = process.argv.slice(2);
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'all';
const store = args.includes('--store');
if (!['chrome', 'firefox', 'all'].includes(targetArg ?? '')) {
  console.error(`unknown target ${String(targetArg)}; use chrome, firefox or all`);
  process.exit(2);
}
/** @type {import('./lib/manifest.mjs').Target[]} */
const targets =
  targetArg === 'all' ? ['chrome', 'firefox'] : [/** @type {'chrome' | 'firefox'} */ (targetArg)];

const ESBUILD_TARGET = { chrome: 'chrome120', firefox: 'firefox140' };

/** @param {import('./lib/manifest.mjs').Target} target */
async function buildTarget(target) {
  const out = join(repoRoot, 'dist', ...(store ? ['store'] : []), target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const bundled = await build({
    entryPoints: {
      'background/index': join(repoRoot, 'src/background/index.ts'),
      'popup/popup': join(repoRoot, 'src/popup/popup.ts'),
      'options/options': join(repoRoot, 'src/options/options.ts'),
    },
    outdir: out,
    bundle: true,
    metafile: true,
    format: 'iife', // no module loader, no dynamic import: one self-contained file per entry
    platform: 'browser',
    target: ESBUILD_TARGET[target],
    sourcemap: store ? false : 'linked',
    minify: false, // readable output: reviewers and the store are meant to be able to audit it
    legalComments: 'none',
    logLevel: 'warning',
    define: {
      __ZEUS_DEV__: JSON.stringify(!store),
      __ZEUS_TARGET__: JSON.stringify(target),
    },
  });
  for (const file of Object.keys(bundled.metafile.inputs)) {
    const normalized = file.replaceAll('\\', '/');
    if (normalized.includes('node_modules/') && !normalized.includes('node_modules/@noble/hashes/'))
      throw new Error(`Unapproved third-party code in browser bundle: ${file}`);
  }

  /** @type {[string, string][]} */
  const staticFiles = [
    ['src/popup/popup.html', 'popup/popup.html'],
    ['src/popup/popup.css', 'popup/popup.css'],
    ['src/options/options.html', 'options/options.html'],
    ['src/options/options.css', 'options/options.css'],
    ['src/shared/ui.css', 'shared/ui.css'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ];
  for (const [from, to] of staticFiles) {
    mkdirSync(join(out, to, '..'), { recursive: true });
    cpSync(join(repoRoot, from), join(out, to));
  }
  cpSync(join(repoRoot, '_locales'), join(out, '_locales'), { recursive: true });
  mkdirSync(join(out, 'icons'), { recursive: true });
  for (const f of readdirSync(join(repoRoot, 'icons'))) {
    if (f.endsWith('.png')) cpSync(join(repoRoot, 'icons', f), join(out, 'icons', f));
  }
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify(buildManifest({ target, store }), null, 2) + '\n',
  );

  const problems = verifyDist(out, { target, store });
  if (problems.length > 0) {
    for (const p of problems) console.error('FAIL ' + p);
    throw new Error(`${target} build failed verification`);
  }
  console.log(`built ${store ? 'store ' : ''}${target} -> ${out}`);
}

for (const target of targets) await buildTarget(target);
