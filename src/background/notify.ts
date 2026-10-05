// OS notifications. They are a convenience only: they never decide anything (a notification can be
// spoofed or dismissed), they carry no URLs with secrets, and text that comes from remote servers
// (file names) is sanitised first. Clicking one opens the popup, where the human decides.
import type { Env } from '../lib/env';
import { errorText, t } from '../lib/messages';
import { displayText } from '../lib/sanitize';
import type { Approval, ErrorEnvelope } from '../lib/protocol';
import type { StateStore } from './state';

export class Notifier {
  constructor(
    private readonly env: Env,
    private readonly store: StateStore,
  ) {}

  private t(key: string, subs?: string[]): string {
    return t(this.env.api.i18n, key, subs);
  }

  private async show(
    id: string,
    title: string,
    message: string,
    requireInteraction = false,
  ): Promise<void> {
    if (!(await this.store.getSettings()).notifications) return;
    try {
      await this.env.api.notifications.create(id, {
        type: 'basic',
        iconUrl: this.env.api.runtime.getURL('icons/icon-128.png'),
        title,
        message,
        // Firefox rejects notification options it does not implement, requireInteraction among them.
        ...(requireInteraction && !this.env.api.env.isFirefox ? { requireInteraction: true } : {}),
      });
    } catch (e) {
      this.env.log.debug('notification failed', { error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  approvalPending(approval: Approval): Promise<void> {
    const name = displayText(approval.summary.title, 80);
    const origin = approval.origin ?? '';
    return this.show(
      `zeus-ap-${approval.id}`,
      this.t('notifApprovalTitle'),
      this.t('notifApprovalBody', [name, origin]),
      true,
    );
  }

  permissionNeeded(origin: string): Promise<void> {
    return this.show(
      `zeus-perm-${origin}`,
      this.t('notifPermissionTitle'),
      this.t('notifPermissionBody', [origin]),
      true,
    );
  }

  jobCompleted(jobId: string, filename: string | null, sha256: string): Promise<void> {
    return this.show(
      `zeus-job-${jobId}`,
      this.t('notifCompletedTitle'),
      this.t('notifCompletedBody', [displayText(filename ?? '', 80), sha256.slice(0, 12)]),
    );
  }

  jobFailed(jobId: string, filename: string | null, error: ErrorEnvelope): Promise<void> {
    const reason = errorText(this.env.api.i18n, error.code, error.class);
    return this.show(
      `zeus-job-${jobId}`,
      this.t('notifFailedTitle'),
      this.t('notifFailedBody', [displayText(filename ?? '', 80), reason]),
    );
  }

  hostMissing(): Promise<void> {
    return this.show(
      'zeus-host-missing',
      this.t('notifHostMissingTitle'),
      this.t('notifHostMissingBody'),
    );
  }

  /** Open the popup if the browser lets us; otherwise the notification itself is the cue. */
  async openPopup(): Promise<void> {
    try {
      await this.env.api.action.openPopup?.();
    } catch {
      /* openPopup needs a user gesture on some browsers */
    }
  }
}
