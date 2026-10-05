// The extension validates inbound frames with its own CSP-safe schema interpreter. This suite
// proves that interpreter agrees with Ajv (the reference) on every spec example and on thousands
// of mutated variants of them, so the runtime guard and the normative schema cannot drift apart.
import { describe, expect, it } from 'vitest';
import { schemas } from '../../src/lib/protocol';
import { SchemaSet, exceedsDepth, type SchemaObject } from '../../src/lib/jsonschema';
import { ajvErrors, ajvValid } from '../helpers/ajv';
import { fullRef, specExamples } from '../helpers/examples';

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Path = (string | number)[];

function collectPaths(value: unknown, prefix: Path = [], out: Path[] = []): Path[] {
  out.push(prefix);
  if (Array.isArray(value)) value.forEach((v, i) => collectPaths(v, [...prefix, i], out));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) collectPaths(v, [...prefix, k], out);
  }
  return out;
}

function getAt(root: unknown, path: Path): unknown {
  let node = root;
  for (const key of path) node = (node as Record<string | number, unknown>)[key];
  return node;
}

function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const parent = getAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1] as string | number] = value;
  return root;
}

function mutate(example: unknown, rand: () => number): unknown {
  let doc = structuredClone(example);
  const ops = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < ops; i++) {
    const paths = collectPaths(doc);
    const path = paths[Math.floor(rand() * paths.length)] ?? [];
    const node = getAt(doc, path);
    const pick = rand();
    if (path.length > 0 && pick < 0.25) {
      const parent = getAt(doc, path.slice(0, -1));
      if (Array.isArray(parent)) parent.splice(path[path.length - 1] as number, 1);
      else Reflect.deleteProperty(parent as object, path[path.length - 1] as string);
    } else if (pick < 0.5) {
      const replacements: unknown[] = [
        null,
        0,
        -1,
        1.5,
        2 ** 53 + 1,
        'x',
        '',
        true,
        [],
        {},
        'bogus',
      ];
      doc = setAt(doc, path, replacements[Math.floor(rand() * replacements.length)]);
    } else if (typeof node === 'number') {
      const options = [node + 1, node - 1, 0, 2 ** 53, 1e15, -node];
      doc = setAt(doc, path, options[Math.floor(rand() * options.length)]);
    } else if (typeof node === 'string') {
      const options = [
        node.toUpperCase(),
        node + 'x',
        node.slice(1),
        'x'.repeat(9000),
        node + '\u{1F600}'.repeat(3),
      ];
      doc = setAt(doc, path, options[Math.floor(rand() * options.length)]);
    } else if (Array.isArray(node)) {
      doc = setAt(doc, path, [...node, ...node, ...node]);
    } else if (typeof node === 'object' && node !== null) {
      doc = setAt(doc, path, { ...node, extra_property: 1 });
    } else {
      doc = setAt(doc, path, node === null ? 'null' : !node);
    }
  }
  return doc;
}

describe('schema interpreter agrees with Ajv', () => {
  it('accepts every spec example exactly as Ajv does', () => {
    expect(specExamples.length).toBeGreaterThan(60);
    for (const ex of specExamples) {
      const ref = fullRef(ex.ref);
      expect(
        ajvValid(ref, ex.value),
        `Ajv rejects ${ex.source}:${ex.line} ${ajvErrors(ref, ex.value)}`,
      ).toBe(true);
      expect(schemas.validate(ref, ex.value), `${ex.source}:${ex.line}`).toEqual([]);
    }
  });

  it('agrees on thousands of mutated variants', () => {
    const rand = mulberry32(0x2e05);
    let accepted = 0;
    let rejected = 0;
    const disagreements: string[] = [];
    for (const ex of specExamples) {
      const ref = fullRef(ex.ref);
      for (let i = 0; i < 90; i++) {
        const variant = mutate(ex.value, rand);
        const reference = ajvValid(ref, variant);
        const ours = schemas.isValid(ref, variant);
        if (reference) accepted++;
        else rejected++;
        if (reference !== ours && disagreements.length < 5) {
          disagreements.push(
            `${ex.source}:${ex.line} ajv=${reference} ours=${ours} ${JSON.stringify(variant).slice(0, 300)}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
    // the mutation set must exercise both outcomes, otherwise the comparison proves little
    expect(accepted).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(2000);
  }, 120_000);
});

describe('interpreter hygiene', () => {
  it('refuses a schema that uses a keyword it does not implement', () => {
    const doc: SchemaObject = {
      $id: 'urn:t',
      $defs: { A: { type: 'object', dependentRequired: { a: ['b'] } } },
    };
    expect(() => new SchemaSet([doc])).toThrow(/unsupported schema keyword "dependentRequired"/);
  });

  it('rejects unresolvable references loudly', () => {
    const set = new SchemaSet([{ $id: 'urn:t', $defs: { A: { $ref: 'urn:other#/$defs/B' } } }]);
    expect(() => set.validate('urn:t#/$defs/A', 1)).toThrow(/unresolvable/);
  });

  it('counts string length in code points like Ajv', () => {
    const set = new SchemaSet([{ $id: 'urn:t', $defs: { S: { type: 'string', maxLength: 2 } } }]);
    expect(set.isValid('urn:t#/$defs/S', '\u{1F600}\u{1F600}')).toBe(true);
    expect(set.isValid('urn:t#/$defs/S', '\u{1F600}\u{1F600}x')).toBe(false);
  });

  it('measures nesting depth without recursion', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(exceedsDepth(deep, 32)).toBe(true);
    expect(exceedsDepth({ a: { b: { c: 1 } } }, 32)).toBe(false);
  });

  it('is not fooled by prototype keys', () => {
    const set = new SchemaSet([
      { $id: 'urn:t', $defs: { O: { type: 'object', required: ['constructor'] } } },
    ]);
    expect(set.isValid('urn:t#/$defs/O', {})).toBe(false);
    expect(set.isValid('urn:t#/$defs/O', JSON.parse('{"constructor":1}'))).toBe(true);
  });
});
