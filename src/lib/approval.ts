// Facts about approvals shared by the background and the popup.
import type { Approval } from './protocol.generated';

/** Approval kinds whose approval lets the extension release session material for `origin`. */
const SESSION_KINDS: ReadonlySet<string> = new Set(['handoff', 'session_grant', 'workflow_plan']);

/**
 * True when approving this approval will lead to a release of cookies for its origin, so the
 * browser's optional host and cookie permissions must be granted first.
 */
export function needsBrowserAccess(approval: Approval): boolean {
  return approval.origin !== undefined && SESSION_KINDS.has(approval.kind);
}
