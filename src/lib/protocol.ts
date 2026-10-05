// Native messaging protocol v1 (spec 02): types, constants, frame construction and the runtime
// guard for inbound frames. The types come from schema/native-messaging.v1.schema.json through
// protocol.generated.ts; the guard interprets the very same schema files at runtime, so there is
// one source of truth and no hand-written validator to drift.
import commonSchema from '../../schema/common.schema.json';
import domainSchema from '../../schema/domain.schema.json';
import nmSchema from '../../schema/native-messaging.v1.schema.json';
import { exceedsDepth, SchemaSet, type Issue, type SchemaObject } from './jsonschema';
import type {
  Approval,
  DaemonToExtensionMessage,
  EventBase,
  ExtensionToDaemonMessage,
  JobEventBody,
  Limits,
} from './protocol.generated';

export * from './protocol.generated';

export const PROTOCOL_VERSION = 1;
/** Protocol versions this build speaks, highest first is irrelevant: the daemon picks the maximum. */
export const SUPPORTED_VERSIONS: readonly number[] = [1];
export const HOST_NAME = 'dev.zeus.native_host';
export const MAX_JSON_DEPTH = 32;

/** Defaults used until `hello.ack` supplies the negotiated limits (spec 02 section 5, 00 section 10). */
export const DEFAULT_LIMITS: Limits = {
  max_frame_to_extension_bytes: 1_000_000,
  max_frame_to_daemon_bytes: 4_194_304,
  default_chunk_bytes: 262_144,
  max_chunk_bytes: 2_097_152,
  default_credit_window: 8,
  max_credit_window: 32,
  max_concurrent_streams: 4,
  max_range_bytes: 16_777_216,
  ping_interval_ms: 20_000,
  pong_timeout_ms: 5_000,
  max_cookie_count: 150,
  max_session_ttl_ms: 900_000,
};

export const NM_SCHEMA_ID = 'https://zeus.invalid/schema/native-messaging.v1';
export const DOMAIN_SCHEMA_ID = 'https://zeus.invalid/schema/domain';
export const COMMON_SCHEMA_ID = 'https://zeus.invalid/schema/common';

export const schemas = new SchemaSet([commonSchema, domainSchema, nmSchema]);

export const nmRef = (def: string): string => `${NM_SCHEMA_ID}#/$defs/${def}`;
export const domainRef = (def: string): string => `${DOMAIN_SCHEMA_ID}#/$defs/${def}`;

// ---------- type vocabulary ----------

export type DaemonMessage = DaemonToExtensionMessage;
export type DaemonMessageType = DaemonMessage['type'];
export type DaemonMessageOf<T extends DaemonMessageType> = Extract<DaemonMessage, { type: T }>;

export type ExtMessage = ExtensionToDaemonMessage;
export type ExtMessageType = ExtMessage['type'];
export type ExtBody<T extends ExtMessageType> = Extract<ExtMessage, { type: T }>['body'];

export type DomainEvent = JobEventBody['event'];
export type DomainEventType = DomainEvent['type'];
export type DomainEventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

export type ApprovalState = Approval['state'];

// ---------- type tables derived from the schema ----------

type Defs = Record<
  string,
  { allOf?: { properties?: { type?: { const?: string } } }[]; oneOf?: { $ref: string }[] }
>;
const nmDefs = (nmSchema as unknown as { $defs: Defs }).$defs;
const domainDefs = (domainSchema as unknown as { $defs: Defs }).$defs;

function messageTypes(union: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const alt of nmDefs[union]?.oneOf ?? []) {
    const def = alt.$ref.replace('#/$defs/', '');
    const constant = nmDefs[def]?.allOf?.[1]?.properties?.type?.const;
    if (constant === undefined) throw new Error(`message definition ${def} has no type constant`);
    out.set(constant, def);
  }
  return out;
}

/** type string to schema definition, for frames the daemon may send. */
export const DAEMON_MESSAGE_DEFS: ReadonlyMap<string, string> = messageTypes(
  'DaemonToExtensionMessage',
);
/** type string to schema definition, for frames the extension may send. */
export const EXT_MESSAGE_DEFS: ReadonlyMap<string, string> = messageTypes(
  'ExtensionToDaemonMessage',
);

/** event type to the domain definition that validates it. */
export const EVENT_DEFS: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const alt of domainDefs.Event?.oneOf ?? []) {
    const def = alt.$ref.replace('#/$defs/', '');
    const constant = domainDefs[def]?.allOf?.[1]?.properties?.type?.const;
    if (constant !== undefined) out.set(constant, def);
  }
  return out;
})();

// ---------- request catalogue (spec 02 section 6.2) ----------

export type Capability =
  | 'handoff'
  | 'session'
  | 'url_refresh.refetch'
  | 'url_refresh.download_api'
  | 'fetch_proxy'
  | 'incognito'
  | 'approvals'
  | 'events'
  | 'job_control'
  | 'grants';

export interface RequestSpec {
  /** Response types that answer this request (an `error` frame always may). */
  responses: readonly DaemonMessageType[];
  /** How long the requester waits (spec 02 section 6.2). */
  timeoutMs: number;
  /** Capability the daemon must have negotiated. */
  capability: Capability | null;
}

/** Requests the extension sends, keyed by type. */
export const REQUESTS = {
  hello: { responses: ['hello.ack'], timeoutMs: 10_000, capability: null },
  ping: { responses: ['pong'], timeoutMs: 5_000, capability: null },
  'handoff.offer': {
    responses: ['handoff.accept', 'handoff.reject'],
    timeoutMs: 10_000,
    capability: 'handoff',
  },
  'approval.list': {
    responses: ['approval.list.response'],
    timeoutMs: 10_000,
    capability: 'approvals',
  },
  'approval.decide': {
    responses: ['approval.decide.response'],
    timeoutMs: 10_000,
    capability: 'approvals',
  },
  'events.subscribe': {
    responses: ['events.subscribe.response'],
    timeoutMs: 10_000,
    capability: 'events',
  },
  'job.list': { responses: ['job.list.response'], timeoutMs: 10_000, capability: 'job_control' },
  'job.control': {
    responses: ['job.control.response'],
    timeoutMs: 10_000,
    capability: 'job_control',
  },
  'grant.list': { responses: ['grant.list.response'], timeoutMs: 10_000, capability: 'grants' },
  'grant.revoke': { responses: ['grant.revoke.response'], timeoutMs: 10_000, capability: 'grants' },
} as const satisfies Record<string, RequestSpec>;

export type RequestType = keyof typeof REQUESTS;

/** Notifications the extension sends (no reply expected). */
export const NOTIFICATIONS = ['bye', 'handoff.withdraw', 'events.unsubscribe'] as const;

/** Capability a notification needs, null when none. */
export const NOTIFICATION_CAPABILITY: Record<(typeof NOTIFICATIONS)[number], Capability | null> = {
  bye: null,
  'handoff.withdraw': 'handoff',
  'events.unsubscribe': 'events',
};

// ---------- frames ----------

/** Build an outbound frame. The caller supplies a well-typed body; tests validate it with Ajv. */
export function makeFrame<T extends ExtMessageType>(
  id: string,
  type: T,
  body: ExtBody<T>,
  re?: string,
): ExtMessage {
  const frame: { v: 1; id: string; type: T; re?: string; body: ExtBody<T> } = {
    v: 1,
    id,
    type,
    body,
  };
  if (re !== undefined) frame.re = re;
  return frame as unknown as ExtMessage;
}

const encoder = new TextEncoder();

/** UTF-8 size of the frame's JSON, i.e. the value of the native-messaging length prefix. */
export function frameBytes(frame: unknown): number {
  return encoder.encode(JSON.stringify(frame)).length;
}

// ---------- inbound parsing ----------

export type ParseFailure = {
  ok: false;
  kind: 'not_object' | 'too_deep' | 'unknown_type' | 'schema_violation';
  /** The frame's `id` when readable, so the caller can answer with `re`. */
  id: string | undefined;
  type: string | undefined;
  /** True when the frame carried `re`, i.e. it claims to be a response. */
  isResponse: boolean;
  issues: Issue[];
};

export type ParseResult = { ok: true; message: DaemonMessage } | ParseFailure;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `job.event` is validated leniently: an event type this build does not know, or a malformed event,
 * must not tear down the connection (spec 00 section 4 rule 7, 01 section 9.2 rule 7). The
 * envelope and the subscription are strict; the event itself is classified later by `classifyEvent`.
 */
const JOB_EVENT_BODY: SchemaObject = {
  $id: 'urn:zeus-extension:job-event-body',
  type: 'object',
  required: ['subscription_id', 'event'],
  properties: {
    subscription_id: { $ref: `${NM_SCHEMA_ID}#/$defs/JobEventBody/properties/subscription_id` },
    event: { $ref: `${DOMAIN_SCHEMA_ID}#/$defs/EventBase` },
  },
};
const looseSchemas = new SchemaSet([commonSchema, domainSchema, nmSchema, JOB_EVENT_BODY]);

export function parseDaemonFrame(raw: unknown): ParseResult {
  if (!isObject(raw)) {
    return {
      ok: false,
      kind: 'not_object',
      id: undefined,
      type: undefined,
      isResponse: false,
      issues: [],
    };
  }
  const id = typeof raw.id === 'string' && MESSAGE_ID.test(raw.id) ? raw.id : undefined;
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  const isResponse = typeof raw.re === 'string';
  const fail = (kind: ParseFailure['kind'], issues: Issue[] = []): ParseFailure => ({
    ok: false,
    kind,
    id,
    type,
    isResponse,
    issues: issues.slice(0, 5),
  });
  if (exceedsDepth(raw, MAX_JSON_DEPTH)) return fail('too_deep');
  if (type === undefined) {
    return fail('schema_violation', [{ path: '/type', message: 'is missing or not a string' }]);
  }
  const def = DAEMON_MESSAGE_DEFS.get(type);
  if (def === undefined) return fail('unknown_type');

  let issues: Issue[];
  if (type === 'job.event') {
    issues = schemas.validate(nmRef('Envelope'), raw, 5);
    if (issues.length === 0) {
      const body = looseSchemas.validate(JOB_EVENT_BODY.$id as string, raw.body, 5);
      issues = body.map((i) => ({ path: `/body${i.path}`, message: i.message }));
    }
  } else {
    issues = schemas.validate(nmRef(def), raw, 5);
  }
  if (issues.length > 0) return fail('schema_violation', issues);
  return { ok: true, message: raw as unknown as DaemonMessage };
}

export type ClassifiedEvent =
  | { known: true; event: DomainEvent }
  | { known: false; type: string; reason: 'unknown_type' | 'invalid' };

/** Validate an event carried by `job.event` against its specific definition. */
export function classifyEvent(event: EventBase): ClassifiedEvent {
  const def = EVENT_DEFS.get(event.type);
  if (def === undefined) return { known: false, type: event.type, reason: 'unknown_type' };
  if (!schemas.isValid(domainRef(def), event))
    return { known: false, type: event.type, reason: 'invalid' };
  return { known: true, event: event as unknown as DomainEvent };
}
