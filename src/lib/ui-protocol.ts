// Messages between the extension's own pages (popup, options) and the background worker. Only
// pages of this extension can send them: the worker checks `sender.id` and the sender URL before
// acting (spec 02 section 10.2), and the extension has no content script and no
// externally_connectable entry, so no web page can reach this channel.
import type { BrowserInfo } from './browser';
import type { CloseReason, LinkState } from '../background/native';
import type { Candidate } from '../background/downloads';
import type { ConsentRecord, NeverEntry, Settings } from '../background/state';
import type { Approval, JobSummary } from './protocol.generated';

export const POPUP_PORT_NAME = 'zeus-popup';

export type GrantScope = 'once' | 'site' | 'workflow' | 'never';

export type UiRequest =
  | { cmd: 'snapshot' }
  | {
      cmd: 'approval.decide';
      approval_id: string;
      request_hash: string;
      revision: number;
      confirmation: 'gesture' | 'typed_code';
      typed_code?: string;
      decision: 'approve' | 'deny';
      scope?: GrantScope;
      /** True only when the click handler observed a user activation (navigator.userActivation.isActive). */
      user_gesture: boolean;
      surface: 'extension_popup' | 'extension_options';
    }
  | { cmd: 'job.control'; job_id: string; action: 'pause' | 'resume' | 'cancel' | 'retry' }
  | { cmd: 'handoff.cancel'; job_id: string }
  | { cmd: 'grant.revoke'; grant_id: string }
  | { cmd: 'download.forward'; download_id: number }
  | { cmd: 'reconnect' }
  | { cmd: 'kill_switch'; action: 'engage' | 'release'; user_gesture: boolean }
  | { cmd: 'settings.set'; patch: Partial<Settings> };

export interface UiError {
  code: string;
  message: string;
}

export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: UiError };

export interface LinkView {
  state: LinkState;
  close_reason: CloseReason | null;
  suspended_until_ms: number | null;
  connected: boolean;
  daemon_version: string | null;
  protocol_version: number | null;
  connection_id: string | null;
  capabilities: string[];
  head_seq: number | null;
}

export interface ConsentView extends ConsentRecord {
  /** Whether the browser currently holds the optional host permission for this origin. */
  has_browser_permission: boolean;
}

export interface Snapshot {
  now_ms: number;
  link: LinkView;
  extension: { id: string; version: string; browser: BrowserInfo; profile_id: string };
  approvals: Approval[];
  /** origin to "browser permission present", for every origin an approval or consent record names. */
  permissions: Record<string, boolean>;
  jobs: JobSummary[];
  consent: ConsentView[];
  never: NeverEntry[];
  downloads: Candidate[];
  settings: Settings;
}

/** Background to page notification on a popup port. */
export interface UiPush {
  type: 'changed';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SCOPES: readonly string[] = ['once', 'site', 'workflow', 'never'];
const ACTIONS: readonly string[] = ['pause', 'resume', 'cancel', 'retry'];

/** Strict parse of a page message; anything else is rejected. */
export function parseUiRequest(raw: unknown): UiRequest | null {
  if (!isRecord(raw) || typeof raw.cmd !== 'string') return null;
  switch (raw.cmd) {
    case 'snapshot':
    case 'reconnect':
      return { cmd: raw.cmd };
    case 'approval.decide': {
      if (typeof raw.approval_id !== 'string' || typeof raw.user_gesture !== 'boolean') return null;
      if (
        typeof raw.request_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.request_hash) ||
        !Number.isSafeInteger(raw.revision)
      )
        return null;
      if (raw.confirmation !== 'gesture' && raw.confirmation !== 'typed_code') return null;
      if (raw.typed_code !== undefined && typeof raw.typed_code !== 'string') return null;
      if (raw.decision !== 'approve' && raw.decision !== 'deny') return null;
      if (raw.surface !== 'extension_popup' && raw.surface !== 'extension_options') return null;
      if (raw.scope !== undefined && (typeof raw.scope !== 'string' || !SCOPES.includes(raw.scope)))
        return null;
      return {
        cmd: 'approval.decide',
        approval_id: raw.approval_id,
        request_hash: raw.request_hash,
        revision: raw.revision as number,
        confirmation: raw.confirmation,
        ...(raw.typed_code === undefined ? {} : { typed_code: raw.typed_code }),
        decision: raw.decision,
        user_gesture: raw.user_gesture,
        surface: raw.surface,
        ...(raw.scope === undefined ? {} : { scope: raw.scope as GrantScope }),
      };
    }
    case 'kill_switch':
      return (raw.action === 'engage' || raw.action === 'release') &&
        typeof raw.user_gesture === 'boolean'
        ? { cmd: 'kill_switch', action: raw.action, user_gesture: raw.user_gesture }
        : null;
    case 'job.control':
      if (
        typeof raw.job_id !== 'string' ||
        typeof raw.action !== 'string' ||
        !ACTIONS.includes(raw.action)
      )
        return null;
      return {
        cmd: 'job.control',
        job_id: raw.job_id,
        action: raw.action as 'pause' | 'resume' | 'cancel' | 'retry',
      };
    case 'handoff.cancel':
      return typeof raw.job_id === 'string' ? { cmd: 'handoff.cancel', job_id: raw.job_id } : null;
    case 'grant.revoke':
      return typeof raw.grant_id === 'string'
        ? { cmd: 'grant.revoke', grant_id: raw.grant_id }
        : null;
    case 'download.forward':
      return typeof raw.download_id === 'number' && Number.isInteger(raw.download_id)
        ? { cmd: 'download.forward', download_id: raw.download_id }
        : null;
    case 'settings.set': {
      if (!isRecord(raw.patch)) return null;
      const patch: Partial<Settings> = {};
      if (typeof raw.patch.auto_offer === 'boolean') patch.auto_offer = raw.patch.auto_offer;
      if (typeof raw.patch.notifications === 'boolean')
        patch.notifications = raw.patch.notifications;
      return { cmd: 'settings.set', patch };
    }
    default:
      return null;
  }
}
