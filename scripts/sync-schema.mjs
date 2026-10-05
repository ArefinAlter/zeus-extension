// Copies the normative contracts from the sibling zeus checkout into schema/ and extracts the spec
// examples as test fixtures. With --check it only reports drift (used by CI and npm run check).
//
//   node scripts/sync-schema.mjs [--from <zeus repo or docs/spec dir>] [--check] [--require-source]
//
// The source is --from, else $ZEUS_REPO, else ../zeus relative to this repository.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCK_FILE,
  buildSchemaFiles,
  findSpecDir,
  normalizeNewlines,
  sha256,
} from './lib/schema-sync.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(repoRoot, 'schema');
const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => args.includes(name);
const fromIdx = args.indexOf('--from');
const from = (fromIdx >= 0 ? args[fromIdx + 1] : undefined) ?? process.env.ZEUS_REPO;

const specDir = findSpecDir(repoRoot, from);

if (flag('--check')) {
  let failures = 0;
  /** @param {string} msg */
  const fail = (msg) => {
    failures++;
    console.error('FAIL ' + msg);
  };
  const lockPath = join(schemaDir, LOCK_FILE);
  if (!existsSync(lockPath)) {
    fail(`schema/${LOCK_FILE} is missing: run npm run sync:schema`);
  } else {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const [name, digest] of Object.entries(lock.files)) {
      const p = join(schemaDir, name);
      if (!existsSync(p)) {
        fail(`schema/${name} is missing`);
      } else if (sha256(normalizeNewlines(readFileSync(p, 'utf8'))) !== digest) {
        fail(`schema/${name} differs from ${LOCK_FILE}: local edit? run npm run sync:schema`);
      }
    }
  }
  if (specDir) {
    for (const [name, content] of buildSchemaFiles(specDir)) {
      const p = join(schemaDir, name);
      if (!existsSync(p) || normalizeNewlines(readFileSync(p, 'utf8')) !== content) {
        fail(
          `schema/${name.replaceAll('\\', '/')} has drifted from ${specDir}: run npm run sync:schema`,
        );
      }
    }
    console.log(`schema drift check against ${specDir}: ${failures === 0 ? 'ok' : 'FAILED'}`);
  } else if (flag('--require-source')) {
    fail('no zeus checkout found (set ZEUS_REPO or --from) and --require-source was given');
  } else {
    console.warn(
      'note: no zeus checkout found; only the lock file was verified (set ZEUS_REPO to check drift)',
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

if (!specDir) {
  console.error('cannot find the zeus checkout; pass --from <path> or set ZEUS_REPO');
  process.exit(2);
}
for (const [name, content] of buildSchemaFiles(specDir)) {
  const p = join(schemaDir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  console.log('wrote schema/' + name.replaceAll('\\', '/'));
}
console.log(`synced from ${specDir}`);
