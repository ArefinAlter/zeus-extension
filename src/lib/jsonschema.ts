// A small JSON Schema (draft 2020-12 subset) interpreter. It exists so that the extension validates
// every inbound frame against the normative schema files in schema/ at runtime without eval:
// Ajv compiles validators with `new Function`, which a Manifest V3 extension page may not do.
//
// Supported keywords are exactly those the Zeus contracts use. A schema using anything else makes
// `SchemaSet` throw at construction, so contract drift cannot silently weaken validation. The test
// suite cross-checks this interpreter against Ajv on every spec example and on mutated variants.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SchemaObject = { readonly [key: string]: unknown };

export interface Issue {
  /** JSON pointer into the validated value, "" for the root. */
  path: string;
  message: string;
}

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$defs',
  'title',
  'description',
  'default',
  'x-zeus-secret',
]);
const SCHEMA_VALUED = new Set(['items', 'additionalProperties', 'propertyNames', 'not']);
const SCHEMA_MAP = new Set(['properties']);
const SCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf']);
const LEAF = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
  'required',
]);

const isObject = (v: unknown): v is { [key: string]: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON equality with sorted object keys (used by enum, const and uniqueItems). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function typeMatches(type: string, v: unknown): boolean {
  switch (type) {
    case 'object':
      return isObject(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return false;
  }
}

/** True when `value` nests deeper than `limit` levels (checked without recursion). */
export function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    const { v, depth } = top;
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v))
      stack.push({ v: child, depth: depth + 1 });
  }
  return false;
}

interface Resolved {
  schema: unknown;
  base: string;
}

export class SchemaSet {
  private readonly docs = new Map<string, SchemaObject>();
  private readonly patterns = new Map<string, RegExp>();

  constructor(documents: readonly SchemaObject[]) {
    for (const doc of documents) {
      const id = doc.$id;
      if (typeof id !== 'string') throw new Error('schema document without $id');
      this.docs.set(id, doc);
    }
    for (const [id, doc] of this.docs) this.assertSupported(doc, id);
  }

  /** Ids of the loaded documents. */
  ids(): string[] {
    return [...this.docs.keys()];
  }

  /** Look up `<doc id>#<json pointer>`, e.g. `https://zeus.invalid/schema/domain#/$defs/Approval`. */
  resolve(ref: string, base: string): Resolved {
    const hash = ref.indexOf('#');
    const docId = hash === 0 ? base : ref.slice(0, hash < 0 ? undefined : hash);
    const pointer = hash < 0 ? '' : ref.slice(hash + 1);
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`unresolvable schema reference ${ref}`);
    let node: unknown = doc;
    for (const raw of pointer.split('/').slice(1)) {
      const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
      if (!isObject(node) && !Array.isArray(node))
        throw new Error(`unresolvable schema reference ${ref}`);
      node = (node as Record<string, unknown>)[key];
    }
    if (node === undefined) throw new Error(`unresolvable schema reference ${ref}`);
    return { schema: node, base: docId };
  }

  /** Validate `value` against a definition, returning at most `limit` issues (empty means valid). */
  validate(ref: string, value: unknown, limit = 8): Issue[] {
    const { schema, base } = this.resolve(ref, [...this.docs.keys()][0] ?? '');
    const issues: Issue[] = [];
    this.check(schema, base, value, '', issues, limit);
    return issues;
  }

  isValid(ref: string, value: unknown): boolean {
    return this.validate(ref, value, 1).length === 0;
  }

  /** Approval facts are closed: reject unrecognized members, including nested objects. */
  isValidClosed(ref: string, value: unknown): boolean {
    if (!this.isValid(ref, value)) return false;
    const resolved = this.resolve(ref, '');
    const inspect = (nodes: Resolved[], current: unknown): boolean => {
      const expanded: Resolved[] = [];
      const expand = (node: Resolved): void => {
        if (!isObject(node.schema)) return;
        const schema = node.schema;
        expanded.push(node);
        if (typeof schema.$ref === 'string') expand(this.resolve(schema.$ref, node.base));
        if (Array.isArray(schema.allOf))
          for (const sub of schema.allOf) expand({ schema: sub, base: node.base });
        for (const key of ['oneOf', 'anyOf']) {
          const alternatives = schema[key];
          if (Array.isArray(alternatives))
            for (const sub of alternatives) {
              if (this.subValid(sub, node.base, current)) expand({ schema: sub, base: node.base });
            }
        }
      };
      nodes.forEach(expand);
      if (Array.isArray(current)) {
        const items = expanded.flatMap((n) =>
          isObject(n.schema) && n.schema.items !== undefined
            ? [{ schema: n.schema.items, base: n.base }]
            : [],
        );
        return current.every((item) => inspect(items, item));
      }
      if (!isObject(current)) return true;
      const properties = new Map<string, Resolved[]>();
      for (const node of expanded) {
        if (!isObject(node.schema) || !isObject(node.schema.properties)) continue;
        for (const [key, sub] of Object.entries(node.schema.properties)) {
          properties.set(key, [...(properties.get(key) ?? []), { schema: sub, base: node.base }]);
        }
      }
      return Object.entries(current).every(
        ([key, child]) => properties.has(key) && inspect(properties.get(key) ?? [], child),
      );
    };
    return inspect([resolved], value);
  }

  private assertSupported(schema: unknown, where: string): void {
    if (typeof schema === 'boolean') return;
    if (!isObject(schema)) throw new Error(`${where}: schema must be an object or boolean`);
    for (const [key, v] of Object.entries(schema)) {
      if (ANNOTATIONS.has(key)) {
        if (key === '$defs' && isObject(v)) {
          for (const [name, def] of Object.entries(v))
            this.assertSupported(def, `${where}/$defs/${name}`);
        }
      } else if (LEAF.has(key)) {
        continue;
      } else if (SCHEMA_VALUED.has(key)) {
        this.assertSupported(v, `${where}/${key}`);
      } else if (SCHEMA_MAP.has(key) && isObject(v)) {
        for (const [name, sub] of Object.entries(v))
          this.assertSupported(sub, `${where}/${key}/${name}`);
      } else if (SCHEMA_LIST.has(key) && Array.isArray(v)) {
        v.forEach((sub, i) => {
          this.assertSupported(sub, `${where}/${key}/${i}`);
        });
      } else {
        throw new Error(`${where}: unsupported schema keyword "${key}"`);
      }
    }
  }

  private regex(source: string): RegExp {
    let re = this.patterns.get(source);
    if (!re) {
      re = new RegExp(source, 'u');
      this.patterns.set(source, re);
    }
    return re;
  }

  private check(
    schema: unknown,
    base: string,
    value: unknown,
    path: string,
    issues: Issue[],
    limit: number,
  ): void {
    if (issues.length >= limit) return;
    if (schema === true) return;
    if (schema === false) {
      issues.push({ path, message: 'no value is allowed here' });
      return;
    }
    if (!isObject(schema)) return;
    const add = (message: string): void => {
      if (issues.length < limit) issues.push({ path, message });
    };

    const ref = schema.$ref;
    if (typeof ref === 'string') {
      const target = this.resolve(ref, base);
      this.check(target.schema, target.base, value, path, issues, limit);
    }

    const type = schema.type;
    if (type !== undefined) {
      const types = Array.isArray(type) ? (type as string[]) : [type as string];
      if (!types.some((t) => typeMatches(t, value))) {
        add(`must be ${types.join(' or ')}`);
        return;
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => canonical(e) === canonical(value))) {
      add(`must be one of ${(schema.enum as unknown[]).map((e) => JSON.stringify(e)).join(', ')}`);
    }
    if ('const' in schema && canonical(schema.const) !== canonical(value)) {
      add(`must equal ${JSON.stringify(schema.const)}`);
    }

    if (typeof value === 'string') {
      if (typeof schema.maxLength === 'number' && codePoints(value) > schema.maxLength) {
        add(`must be at most ${schema.maxLength} characters`);
      }
      if (typeof schema.minLength === 'number' && codePoints(value) < schema.minLength) {
        add(`must be at least ${schema.minLength} characters`);
      }
      if (typeof schema.pattern === 'string' && !this.regex(schema.pattern).test(value)) {
        add(`must match ${schema.pattern}`);
      }
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum)
        add(`must be >= ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum)
        add(`must be <= ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
        add(`must have at most ${schema.maxItems} items`);
      }
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        add(`must have at least ${schema.minItems} items`);
      }
      if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) {
        add('items must be unique');
      }
      if (schema.items !== undefined) {
        for (let i = 0; i < value.length && issues.length < limit; i++) {
          this.check(schema.items, base, value[i], `${path}/${i}`, issues, limit);
        }
      }
    }
    if (isObject(value)) this.checkObject(schema, base, value, path, issues, limit, add);

    for (const key of ['allOf'] as const) {
      const list = schema[key];
      if (Array.isArray(list))
        for (const sub of list) this.check(sub, base, value, path, issues, limit);
    }
    if (schema.not !== undefined && this.subValid(schema.not, base, value))
      add('matches a forbidden shape');
    if (Array.isArray(schema.anyOf)) {
      const alternatives = schema.anyOf as unknown[];
      if (!alternatives.some((alt) => this.subValid(alt, base, value)))
        add('matches none of the allowed shapes');
    }
    if (Array.isArray(schema.oneOf)) {
      const alternatives = schema.oneOf as unknown[];
      const matching = alternatives.filter((alt) => this.subValid(alt, base, value)).length;
      if (matching === 0) {
        // Surface the problems of the alternative the value is closest to (fewest issues).
        let best: Issue[] | null = null;
        for (const alt of alternatives) {
          const sub: Issue[] = [];
          this.check(alt, base, value, path, sub, limit);
          if (best === null || sub.length < best.length) best = sub;
        }
        for (const issue of best ?? []) if (issues.length < limit) issues.push(issue);
        if (best === null || best.length === 0) add('matches none of the allowed shapes');
      } else if (matching > 1) {
        add('matches more than one of the allowed shapes');
      }
    }
  }

  private subValid(schema: unknown, base: string, value: unknown): boolean {
    const probe: Issue[] = [];
    this.check(schema, base, value, '', probe, 1);
    return probe.length === 0;
  }

  private checkObject(
    schema: { readonly [key: string]: unknown },
    base: string,
    value: { [key: string]: unknown },
    path: string,
    issues: Issue[],
    limit: number,
    add: (message: string) => void,
  ): void {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      add(`must have at least ${schema.minProperties} properties`);
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      add(`must have at most ${schema.maxProperties} properties`);
    }
    if (Array.isArray(schema.required)) {
      for (const name of schema.required as string[]) {
        if (!Object.hasOwn(value, name)) add(`is missing required property "${name}"`);
      }
    }
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const [name, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, name) && issues.length < limit) {
        this.check(sub, base, value[name], `${path}/${escapePointer(name)}`, issues, limit);
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        const sub: Issue[] = [];
        this.check(schema.propertyNames, base, key, path, sub, 1);
        if (sub.length > 0) add(`property name "${key.slice(0, 40)}" is not allowed`);
      }
    }
    const extra = schema.additionalProperties;
    if (extra !== undefined && extra !== true) {
      for (const key of keys) {
        if (Object.hasOwn(props, key)) continue;
        if (extra === false) add(`unexpected property "${key.slice(0, 40)}"`);
        else this.check(extra, base, value[key], `${path}/${escapePointer(key)}`, issues, limit);
      }
    }
  }
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
