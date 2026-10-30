// The background side of the popup and options page: authenticates the sender, runs the commands
// and assembles the snapshot the pages render. A command is the human's click carried from an
// extension page; it is never derived from anything a web page or an agent can produce.
import type { BrowserInfo } from '../lib/browser';
import type { Env } from '../lib/env';
import { ZeusError } from '../lib/errors';
import { hostPattern } from '../lib/origin';
import type { MessageSender } from '../lib/platform';
import type { Capability } from '../lib/protocol';
import type { ConsentView, LinkView, Snapshot, UiRequest, UiResponse } from '../lib/ui-protocol';
import type { ApprovalCenter } from './approvals';
import type { DownloadWatcher } from './downloads';
import type { JobBook } from './jobs';
import type { NativeLink } from './native';
import type { StateStore } from './state';

export interface UiHooks {
  /** Reconnect now, resetting the backoff and the flapping guard. */
  reconnect(): void;
  /** Settings changed (notifications, auto offer). */
  changed(): void;
}

export class UiService {
  constructor(
    private readonly env: Env,
    private readonly store: StateStore,
    private readonly link: NativeLink,
    private readonly approvals: ApprovalCenter,
    private readonly jobs: JobBook,
    private readonly downloads: DownloadWatcher,
    private readonly browser: BrowserInfo,
    private readonly hooks: UiHooks,
  ) {}

  /**
   * Only pages of this extension may send commands: same extension id, and a URL inside the
   * extension's own origin. A content script or a foreign extension fails both checks.
   */
  isTrustedSender(sender: MessageSender): boolean {
    return (
      sender.id === this.env.api.runtime.id &&
      typeof sender.url === 'string' &&
      sender.url.startsWith(this.env.api.runtime.getURL(''))
    );
  }

  async handle(request: UiRequest): Promise<UiResponse> {
    try {
      switch (request.cmd) {
        case 'snapshot':
          return ok(await this.snapshot());
        case 'approval.decide': {
          const result = await this.approvals.decide(request);
          if (!result.ok) return { ok: false, error: result.error };
          return ok({
            approval_id: result.approval.id,
            state: result.approval.state,
            granted: result.grant !== null,
          });
        }
        case 'kill_switch': {
          if (!request.user_gesture)
            return {
              ok: false,
              error: { code: 'nm.user_gesture_required', message: 'This action needs a click.' },
            };
          const answer = await this.link.request('kill_switch', {
            action: request.action,
            ui: { surface: 'extension_popup', user_gesture: true },
          });
          if (answer.type !== 'kill_switch.response')
            return {
              ok: false,
              error: { code: 'nm.internal', message: 'Unexpected stop response.' },
            };
          if (answer.body.engaged) {
            for (const record of await this.store.listConsent())
              await this.approvals.onGrantEnded(record.grant_id, record.origin);
            this.approvals.clear();
          }
          this.hooks.changed();
          return ok(answer.body);
        }
        case 'job.control': {
          const answer = await this.link.request('job.control', {
            job_id: request.job_id,
            action: request.action,
          });
          if (answer.type === 'job.control.response') this.jobs.upsert(answer.body.job);
          this.hooks.changed();
          return ok(null);
        }
        case 'handoff.cancel':
          return ok(await this.downloads.withdrawForJob(request.job_id));
        case 'grant.revoke': {
          const answer = await this.link.request('grant.revoke', { grant_id: request.grant_id });
          if (answer.type === 'grant.revoke.response') {
            await this.approvals.onGrantEnded(answer.body.grant.id, answer.body.grant.origin);
          }
          return ok(null);
        }
        case 'download.forward': {
          const result = await this.downloads.forward(request.download_id);
          return result.ok
            ? ok(null)
            : {
                ok: false,
                error: {
                  code: `handoff.${result.reason ?? 'refused'}`,
                  message: 'This download cannot be handed to Zeus.',
                },
              };
        }
        case 'reconnect':
          this.hooks.reconnect();
          return ok(null);
        case 'settings.set':
          await this.store.setSettings(request.patch);
          this.hooks.changed();
          return ok(await this.store.getSettings());
      }
    } catch (e) {
      if (e instanceof ZeusError)
        return { ok: false, error: { code: e.envelope.code, message: e.envelope.message } };
      this.env.log.warn('ui command failed', {
        cmd: request.cmd,
        error: e instanceof Error ? e.name : 'unknown',
      });
      return { ok: false, error: { code: 'nm.internal', message: 'The command failed.' } };
    }
  }

  linkView(): LinkView {
    const s = this.link.status();
    const caps: Capability[] = [];
    for (const c of s.info?.capabilities ?? []) caps.push(c as Capability);
    return {
      state: s.state,
      close_reason: s.closeReason,
      suspended_until_ms: s.suspendedUntilMs,
      connected: this.link.isReady(),
      daemon_version: s.info?.daemon.version ?? null,
      protocol_version: s.info?.protocol_version ?? null,
      connection_id: s.info?.connection_id ?? null,
      capabilities: caps,
      head_seq: s.info?.head_seq ?? null,
    };
  }

  async snapshot(): Promise<Snapshot> {
    const approvals = this.approvals.list();
    const consent = await this.store.listConsent();
    const never = await this.store.listNever();
    const origins = new Set<string>();
    for (const a of approvals) if (a.origin !== undefined) origins.add(a.origin);
    for (const c of consent) origins.add(c.origin);
    const permissions: Record<string, boolean> = {};
    for (const origin of [...origins].slice(0, 40)) {
      permissions[origin] = await this.env.api.permissions
        .contains({ origins: [hostPattern(origin)] })
        .catch(() => false);
    }
    const consentViews: ConsentView[] = consent.map((c) => ({
      ...c,
      has_browser_permission: permissions[c.origin] ?? false,
    }));
    return {
      now_ms: this.env.clock.now(),
      link: this.linkView(),
      extension: {
        id: this.env.api.runtime.id,
        version: this.env.api.runtime.version(),
        browser: this.browser,
        profile_id: await this.store.getProfileId(),
      },
      approvals,
      permissions,
      jobs: this.jobs.list(30),
      consent: consentViews,
      never,
      downloads: await this.downloads.candidates(8),
      settings: await this.store.getSettings(),
    };
  }
}

function ok<T>(data: T): UiResponse<T> {
  return { ok: true, data };
}
