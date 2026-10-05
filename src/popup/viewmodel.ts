// Pure presentation logic for the popup and the options page: which message key, tone and actions
// to show for a piece of state. No DOM here, so it is unit-tested directly.
import type { Candidate } from '../background/downloads';
import type { Approval, JobSummary } from '../lib/protocol';
import type { GrantScope, LinkView } from '../lib/ui-protocol';

export type Tone = 'ok' | 'warn' | 'error' | 'idle';

export interface Banner {
  tone: Tone;
  titleKey: string;
  hintKey: string | null;
  /** Whether a "try again now" button helps. */
  canReconnect: boolean;
}

/** The connection status line and the help that goes with it. */
export function linkBanner(link: LinkView): Banner {
  if (link.connected)
    return { tone: 'ok', titleKey: 'statusConnected', hintKey: null, canReconnect: false };
  switch (link.state) {
    case 'connecting':
      return { tone: 'idle', titleKey: 'statusConnecting', hintKey: null, canReconnect: false };
    case 'suspended':
      return {
        tone: 'error',
        titleKey: 'statusSuspended',
        hintKey: 'hintSuspended',
        canReconnect: true,
      };
    case 'idle':
      return { tone: 'idle', titleKey: 'statusIdle', hintKey: null, canReconnect: false };
    default:
      break;
  }
  if (link.close_reason === 'host_not_found') {
    return {
      tone: 'error',
      titleKey: 'statusHostMissing',
      hintKey: 'hintHostMissing',
      canReconnect: true,
    };
  }
  if (link.close_reason === 'forbidden') {
    return {
      tone: 'error',
      titleKey: 'statusForbidden',
      hintKey: 'hintForbidden',
      canReconnect: true,
    };
  }
  return { tone: 'warn', titleKey: 'statusDisconnected', hintKey: null, canReconnect: true };
}

const KIND_KEYS: Record<string, string> = {
  handoff: 'approvalKindHandoff',
  session_grant: 'approvalKindSessionGrant',
  retry_escalation: 'approvalKindRetryEscalation',
  policy_exception: 'approvalKindPolicyException',
  workflow_plan: 'approvalKindWorkflowPlan',
  destructive_op: 'approvalKindDestructiveOp',
};
export const approvalKindKey = (kind: string): string => KIND_KEYS[kind] ?? 'approvalKindOther';

const REASON_KEYS: Record<string, string> = {
  'handoff.interrupted': 'reasonHandoffInterrupted',
  'session.first_use': 'reasonSessionFirstUse',
  'retry.exhausted': 'reasonRetryExhausted',
  'url.expired': 'reasonUrlExpired',
};
/** Message key for a reason code, or null when the code has no text (it is then shown as is). */
export const reasonKey = (code: string): string | null => REASON_KEYS[code] ?? null;

const SOURCE_KEYS: Record<string, string> = {
  browser_handoff: 'sourceBrowserHandoff',
  agent: 'sourceAgent',
  cli: 'sourceCli',
  workflow: 'sourceWorkflow',
};
export const sourceKey = (kind: string): string | null => SOURCE_KEYS[kind] ?? null;

export interface DecisionButton {
  id: string;
  labelKey: string;
  decision: 'approve' | 'deny';
  scope: GrantScope | null;
  style: 'primary' | 'secondary' | 'danger';
}

/**
 * The buttons for an approval, from what the daemon allows (`allowed_scopes`): one approve button
 * per allowed scope except never, then "never for this site" (a deny carrying that scope) and a
 * plain deny. An approval with no scopes is a plain yes or no.
 */
export function decisionButtons(approval: Approval): DecisionButton[] {
  const scopes = approval.allowed_scopes;
  const out: DecisionButton[] = [];
  if (scopes.length === 0) {
    out.push({
      id: 'approve',
      labelKey: 'btnApprove',
      decision: 'approve',
      scope: null,
      style: 'primary',
    });
    out.push({
      id: 'deny',
      labelKey: 'btnDeny',
      decision: 'deny',
      scope: null,
      style: 'secondary',
    });
    return out;
  }
  if (scopes.includes('once'))
    out.push({
      id: 'once',
      labelKey: 'btnAllowOnce',
      decision: 'approve',
      scope: 'once',
      style: 'primary',
    });
  if (scopes.includes('site'))
    out.push({
      id: 'site',
      labelKey: 'btnAllowSite',
      decision: 'approve',
      scope: 'site',
      style: 'secondary',
    });
  if (scopes.includes('workflow'))
    out.push({
      id: 'workflow',
      labelKey: 'btnAllowWorkflow',
      decision: 'approve',
      scope: 'workflow',
      style: 'secondary',
    });
  out.push({ id: 'deny', labelKey: 'btnDeny', decision: 'deny', scope: null, style: 'secondary' });
  if (scopes.includes('never'))
    out.push({
      id: 'never',
      labelKey: 'btnNeverSite',
      decision: 'deny',
      scope: 'never',
      style: 'danger',
    });
  return out;
}

const STATE_KEYS: Record<string, string> = {
  queued: 'jobStateQueued',
  probing: 'jobStateProbing',
  awaiting_approval: 'jobStateAwaitingApproval',
  awaiting_session: 'jobStateAwaitingSession',
  downloading: 'jobStateDownloading',
  paused: 'jobStatePaused',
  retry_scheduled: 'jobStateRetryScheduled',
  verifying: 'jobStateVerifying',
  finalizing: 'jobStateFinalizing',
  completed: 'jobStateCompleted',
  failed: 'jobStateFailed',
  canceled: 'jobStateCanceled',
};
export const jobStateKey = (state: string): string => STATE_KEYS[state] ?? 'jobStateQueued';

export type JobAction = 'pause' | 'resume' | 'cancel' | 'retry';

/** Controls the transition table (spec 01 section 7) allows a client to apply in a state. */
export function jobActions(state: JobSummary['state']): JobAction[] {
  switch (state) {
    case 'queued':
    case 'probing':
    case 'downloading':
    case 'retry_scheduled':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'awaiting_approval':
    case 'awaiting_session':
    case 'verifying':
      return ['cancel'];
    case 'failed':
      return ['retry'];
    default:
      return [];
  }
}

export const JOB_ACTION_KEYS: Record<JobAction, string> = {
  pause: 'btnPause',
  resume: 'btnResume',
  cancel: 'btnCancel',
  retry: 'btnRetry',
};

/** Fraction done, or null while the total is unknown. */
export function progressOf(job: Pick<JobSummary, 'bytes_done' | 'bytes_total'>): number | null {
  if (job.bytes_total === null || job.bytes_total <= 0) return null;
  return Math.min(1, Math.max(0, job.bytes_done / job.bytes_total));
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Binary units only (spec 00 section 6.3). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

/** Compact duration such as "23 h", "5 min" or "< 1 min". Units are symbols, not words, so they need no translation. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return '< 1 min';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export interface CandidateNote {
  /** Message key explaining why the download cannot be handed over, or null. */
  refusalKey: string | null;
  stateKey: string;
  canForward: boolean;
}

export function candidateNote(c: Candidate): CandidateNote {
  let refusalKey: string | null = null;
  if (!c.eligible) {
    refusalKey =
      c.refusal === 'security_decision'
        ? 'dlRefusedSecurity'
        : c.refusal === 'dangerous'
          ? 'dlRefusedDangerous'
          : 'dlRefusedOther';
  }
  return {
    refusalKey,
    stateKey: c.state === 'interrupted' ? 'dlInterrupted' : 'dlInProgress',
    canForward: c.eligible && c.offer_status === null,
  };
}

/** Scope label key for the options page. */
export function scopeKey(scope: string): string {
  switch (scope) {
    case 'once':
      return 'scopeOnce';
    case 'site':
      return 'scopeSite';
    case 'workflow':
      return 'scopeWorkflow';
    default:
      return 'scopeNever';
  }
}
