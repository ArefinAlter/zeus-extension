// The approval trust surface (spec 02 section 10, 01 section 5.3). The popup shows approvals the
// daemon computed facts for; only a click in an extension page can produce `approval.decide`, and
// an approval the human decides here (or that a human decides in the TUI or CLI while this
// extension displayed it) becomes a local consent record, the extension's own gate for releasing
// session material. Agents never reach this module: it has no inbound path from the web or from
// any other extension.
import type { Env } from '../lib/env';
import { ZeusError } from '../lib/errors';
import {
  approvalBinding,
  approvalRequiresTerminal,
  needsBrowserAccess,
  normalizeBindCode,
} from '../lib/approval';
import { hostPattern } from '../lib/origin';
import type { Approval, SessionGrant } from '../lib/protocol';
import type { UiError } from '../lib/ui-protocol';
import type { Notifier } from './notify';
import type { NativeLink } from './native';
import type { ConsentScope, StateStore } from './state';

type Surface = 'extension_popup' | 'extension_options';
type Scope = 'once' | 'site' | 'workflow' | 'never';

export interface DecideRequest {
  approval_id: string;
  request_hash: string;
  revision: number;
  confirmation: 'gesture' | 'typed_code';
  typed_code?: string;
  decision: 'approve' | 'deny';
  scope?: Scope;
  user_gesture: boolean;
  surface: Surface;
}

export type DecideResult =
  { ok: true; approval: Approval; grant: SessionGrant | null } | { ok: false; error: UiError };

export interface ApprovalHooks {
  /** The view changed (popup should refresh). */
  changed(): void;
  /** Consent for an origin was removed: streams for it must stop. */
  consentRemoved(origin: string): void;
}

const FALLBACK_CONSENT_MS = 24 * 3600 * 1000;

export class ApprovalCenter {
  private readonly pending = new Map<string, Approval>();

  constructor(
    private readonly env: Env,
    private readonly store: StateStore,
    private readonly link: Pick<NativeLink, 'request' | 'hasCapability'>,
    private readonly notifier: Notifier,
    private readonly hooks: ApprovalHooks,
  ) {}

  /** Pending approvals, oldest first. Expired ones are dropped (the daemon auto-denies them). */
  list(): Approval[] {
    const now = this.env.clock.now();
    for (const [id, a] of this.pending) {
      const expires = Date.parse(a.expires_at);
      if (!Number.isNaN(expires) && expires <= now) this.pending.delete(id);
    }
    return [...this.pending.values()].sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  }

  size(): number {
    return this.list().length;
  }

  get(id: string): Approval | undefined {
    return this.pending.get(id);
  }

  /** The connection closed; the daemon re-pushes everything still pending after the next hello.ack. */
  clear(): void {
    this.pending.clear();
    this.hooks.changed();
  }

  // ---------- from the daemon ----------

  async onPending(approval: Approval): Promise<void> {
    // Domain events intentionally omit facts. Retrieve the full request before displaying it.
    if (!('facts' in approval)) {
      const response = await this.link.request('approval.list', { limit: 100 });
      if (response.type === 'approval.list.response') {
        for (const full of response.body.approvals) await this.onPending(full);
      }
      return;
    }
    const previous = this.pending.get(approval.id);
    const incomingBinding = approvalBinding(approval);
    const previousBinding = previous ? approvalBinding(previous) : null;
    if (
      previousBinding &&
      incomingBinding &&
      (incomingBinding.revision < previousBinding.revision ||
        (incomingBinding.revision === previousBinding.revision &&
          incomingBinding.hash !== previousBinding.hash))
    )
      return;

    if (approval.state !== 'pending') {
      this.onDecided(approval.id);
      return;
    }
    const known = this.pending.has(approval.id);
    this.pending.set(approval.id, approval);
    const shownBefore = await this.store.wasApprovalDisplayed(approval.id);
    if (incomingBinding) await this.store.markApprovalDisplayed(approval.id);
    this.hooks.changed();
    if (!known && !shownBefore) await this.notifier.approvalPending(approval);
  }

  /** Decided or canceled elsewhere (TUI, CLI, expiry, the job was canceled). */
  onDecided(approvalId: string): void {
    if (this.pending.delete(approvalId)) this.hooks.changed();
  }

  /**
   * A grant was created. If a human decided an approval this extension displayed (in the TUI or
   * CLI), keep a local consent record so the release gate can work (spec 02 section 10.2 (b)).
   * Grants for approvals this extension never showed are ignored.
   */
  async onGrantCreated(grant: SessionGrant): Promise<void> {
    if (grant.decided_by.kind !== 'human') return;
    if (!(await this.store.wasApprovalDisplayed(grant.approval_id))) return;
    if (grant.state !== 'active') return;
    await this.recordGrant(grant, 'event');
    if (grant.scope !== 'never' && !(await this.hasBrowserAccess(grant.origin))) {
      await this.notifier.permissionNeeded(grant.origin);
    }
    this.hooks.changed();
  }

  /** `grant.revoked` or `grant.expired`: forget the local consent and stop streams that used it. */
  async onGrantEnded(grantId: string, origin: string): Promise<void> {
    const removed = await this.store.removeConsent((r) => r.grant_id === grantId);
    await this.store.removeNever((e) => e.grant_id === grantId);
    const remaining = (await this.store.listConsent()).some((r) => r.origin === origin);
    if (removed.length > 0 || !remaining) this.hooks.consentRemoved(origin);
    this.hooks.changed();
  }

  // ---------- the human's decision ----------

  async decide(req: DecideRequest): Promise<DecideResult> {
    const fail = (code: string, message: string): DecideResult => ({
      ok: false,
      error: { code, message },
    });
    if (!req.user_gesture) return fail('nm.user_gesture_required', 'A decision needs a click.');
    const approval = this.pending.get(req.approval_id);
    if (!approval || approval.state !== 'pending')
      return fail('nm.conflict', 'This approval is no longer pending.');
    if (Date.parse(approval.expires_at) <= this.env.clock.now())
      return fail('nm.conflict', 'This approval has expired.');
    if (!this.link.hasCapability('approvals'))
      return fail('nm.capability_missing', 'The daemon cannot take decisions from the browser.');

    if (approvalRequiresTerminal(approval))
      return fail(
        'policy.human_required',
        'Review cloud deliveries in an interactive Zeus terminal.',
      );

    const binding = approvalBinding(approval);
    if (!binding || req.request_hash !== binding.hash || req.revision !== binding.revision) {
      return fail(
        'policy.request_hash_mismatch',
        'This request changed or failed its integrity check. Review it again.',
      );
    }
    if (req.decision === 'approve') {
      if (req.scope === 'never')
        return fail('nm.schema_violation', 'Approve cannot carry the never scope.');
      if (
        approval.allowed_scopes.length > 0 &&
        (req.scope === undefined || !approval.allowed_scopes.includes(req.scope))
      ) {
        return fail('nm.schema_violation', 'That scope is not allowed for this approval.');
      }
      const required = binding.confirmation[req.scope ?? 'approve'];
      if (required === 'os_auth' || (required !== 'gesture' && required !== 'typed_code'))
        return fail('policy.human_required', 'This request needs a newer trust surface.');
      if (
        required === 'typed_code' &&
        (req.confirmation !== 'typed_code' ||
          normalizeBindCode(req.typed_code ?? '') !== normalizeBindCode(binding.code))
      )
        return fail('policy.human_required', 'Type the displayed confirmation code.');
      if (
        needsBrowserAccess(approval) &&
        approval.origin !== undefined &&
        !(await this.hasBrowserAccess(approval.origin))
      ) {
        return fail(
          'approval.browser_permission_required',
          'Allow browser access for this site first.',
        );
      }
    } else if (req.scope !== undefined && req.scope !== 'never') {
      return fail('nm.schema_violation', 'Deny can only carry the never scope.');
    }

    let response;
    try {
      response = await this.link.request('approval.decide', {
        approval_id: approval.id,
        request_hash: binding.hash,
        confirmation: req.confirmation,
        decision: req.decision,
        ...(req.scope === undefined ? {} : { scope: req.scope }),
        ui: { surface: req.surface, user_gesture: true },
      });
    } catch (e) {
      if (e instanceof ZeusError) {
        if (
          e.envelope.code === 'nm.conflict' ||
          e.envelope.code === 'nm.not_found' ||
          e.envelope.code === 'policy.request_hash_mismatch'
        )
          this.onDecided(approval.id);
        return fail(e.envelope.code, e.envelope.message);
      }
      return fail('nm.internal', 'The decision could not be sent.');
    }
    if (response.type !== 'approval.decide.response')
      return fail('nm.internal', 'Unexpected answer to the decision.');

    const decidedBinding = approvalBinding(response.body.approval);
    if (
      !decidedBinding ||
      decidedBinding.hash !== binding.hash ||
      decidedBinding.revision !== binding.revision
    )
      return fail(
        'policy.request_hash_mismatch',
        'The decision response does not match the request you reviewed.',
      );
    const grant = response.body.grant ?? null;
    if (
      grant &&
      (grant.approval_id !== approval.id ||
        grant.origin !== approval.origin ||
        grant.decided_by.kind !== 'human')
    )
      return fail('nm.conflict', 'The permission does not match this approval.');
    this.pending.delete(approval.id);
    if (grant) await this.recordGrant(grant, 'ui', approval);
    this.hooks.changed();
    return { ok: true, approval: response.body.approval, grant };
  }

  // ---------- consent bookkeeping ----------

  private async recordGrant(
    grant: SessionGrant,
    source: 'ui' | 'event',
    approval?: Approval,
  ): Promise<void> {
    if (grant.scope === 'never') {
      await this.store.putNever({
        origin: grant.origin,
        grant_id: grant.id,
        created_at_ms: this.env.clock.now(),
      });
      return;
    }
    if (grant.state !== 'active') return;
    const scope: ConsentScope = grant.scope;
    const expires = grant.expires_at === null ? NaN : Date.parse(grant.expires_at);
    const jobId = grant.job_id ?? (scope === 'once' ? approval?.job_id : undefined);
    const runId = grant.run_id ?? (scope === 'workflow' ? approval?.run_id : undefined);
    await this.store.putConsent({
      grant_id: grant.id,
      origin: grant.origin,
      scope,
      ...(jobId === undefined ? {} : { job_id: jobId }),
      ...(runId === undefined ? {} : { run_id: runId }),
      expires_at_ms: Number.isNaN(expires) ? this.env.clock.now() + FALLBACK_CONSENT_MS : expires,
      source,
    });
  }

  private hasBrowserAccess(origin: string): Promise<boolean> {
    return this.env.api.permissions.contains({
      origins: [hostPattern(origin)],
      permissions: ['cookies'],
    });
  }
}
