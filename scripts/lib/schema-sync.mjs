// Shared logic for copying the normative contracts from the sibling `zeus` checkout and for
// checking that the local copies have not drifted. Used by sync-schema.mjs and check.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Schema files copied verbatim from docs/spec/schema. */
export const SCHEMA_FILES = [
  'native-messaging.v1.schema.json',
  'common.schema.json',
  'approvals.v1.schema.json',
  'cloud.v1.schema.json',
  'domain.schema.json',
  'redaction-vectors.v1.json',
];

/** Spec documents whose validated JSON fences become test fixtures. */
export const EXAMPLE_SOURCES = [
  '02-native-messaging-v1.md',
  '01-domain-model.md',
  '07-approvals-trust-surface-and-consent.md',
];
export const EXAMPLES_FILE = 'spec-examples.json';
export const LOCK_FILE = 'SCHEMA-LOCK.json';

/** Schemas the extension carries; examples against any other schema are not extracted. */
const KNOWN_SCHEMAS = ['native-messaging.v1', 'domain', 'common', 'approvals.v1'];

/** @param {string} text */
export const normalizeNewlines = (text) => text.replace(/\r\n/g, '\n');

/** @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Locate docs/spec of the sibling checkout.
 * @param {string} repoRoot extension repository root
 * @param {string | undefined} override --from value or ZEUS_REPO
 * @returns {string | null}
 */
export function findSpecDir(repoRoot, override) {
  const candidates = [];
  if (override) candidates.push(resolve(override));
  candidates.push(resolve(repoRoot, '..', 'zeus'));
  for (const base of candidates) {
    for (const dir of [join(base, 'docs', 'spec'), base]) {
      if (existsSync(join(dir, 'schema', 'native-messaging.v1.schema.json'))) return dir;
    }
  }
  return null;
}

/**
 * Extract the validated JSON examples of one spec document.
 * `json` fences hold one document, `jsonl` fences one per line.
 * @param {string} markdown
 * @param {string} source file name, recorded with each example
 * @returns {{ source: string, ref: string, line: number, value: unknown }[]}
 */
export function extractExamples(markdown, source) {
  const text = normalizeNewlines(markdown);
  /** @type {{ source: string, ref: string, line: number, value: unknown }[]} */
  const out = [];
  const fence = /^```(jsonl|json) ([^\n]*)\n([\s\S]*?)^```$/gm;
  let m;
  while ((m = fence.exec(text))) {
    const info = m[2] ?? '';
    const ref = /validate=([\w.-]+#\/\$defs\/\w+)/.exec(info)?.[1];
    if (!ref || !KNOWN_SCHEMAS.includes(ref.split('#')[0] ?? '')) continue;
    const line = text.slice(0, m.index).split('\n').length;
    const body = m[3] ?? '';
    if (m[1] === 'json') {
      out.push({ source, ref, line, value: JSON.parse(body) });
    } else {
      body.split('\n').forEach((l, i) => {
        if (l.trim() !== '') out.push({ source, ref, line: line + 1 + i, value: JSON.parse(l) });
      });
    }
  }
  return out;
}

/**
 * Compute everything a sync would write, from a spec directory.
 * @param {string} specDir
 * @returns {Map<string, string>} file name (relative to schema/) to content
 */
export function buildSchemaFiles(specDir) {
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const name of SCHEMA_FILES) {
    files.set(name, normalizeNewlines(readFileSync(join(specDir, 'schema', name), 'utf8')));
  }
  /** @type {Record<string, string>} */
  const sourceHashes = {};
  const examples = [];
  for (const source of EXAMPLE_SOURCES) {
    const markdown = readFileSync(join(specDir, source), 'utf8');
    sourceHashes[source] = sha256(normalizeNewlines(markdown));
    examples.push(...extractExamples(markdown, source));
  }
  files.set(
    join('examples', EXAMPLES_FILE),
    JSON.stringify({ sources: EXAMPLE_SOURCES, examples }, null, 2) + '\n',
  );
  const lock = {
    note: 'sha256 of the normalised (LF) content of each copied contract. Do not edit by hand: run npm run sync:schema.',
    source_markdown_sha256: sourceHashes,
    files: Object.fromEntries(
      [...files].map(([name, content]) => [name.replaceAll('\\', '/'), sha256(content)]),
    ),
  };
  files.set(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
  return files;
}
