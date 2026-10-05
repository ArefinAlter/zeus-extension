// The trust surface: shows what Zeus needs the human to decide and carries the decision back.
// Every approve click first asks the browser for the optional host (and cookie) permission from
// inside the click handler, which is the only place a browser lets that prompt appear, and only
// then sends the decision, attested with the gesture that the browser's own user-activation flag
// confirmed. Text from remote servers is shown with textContent only.
import { needsBrowserAccess } from '../lib/approval';
import { t, errorText } from '../lib/messages';
import { hostPattern } from '../lib/origin';
import type { ExtApi } from '../lib/platform';
import type { Approval, JobSummary } from '../lib/protocol';
import { displayText } from '../lib/sanitize';
import {
  POPUP_PORT_NAME,
  type Snapshot,
  type UiRequest,
  type UiResponse,
} from '../lib/ui-protocol';
import { applyI18n, clear, h } from './dom';
import {
  JOB_ACTION_KEYS,
  approvalKindKey,
  candidateNote,
  decisionButtons,
  formatBytes,
  formatDuration,
  jobActions,
  jobStateKey,
  linkBanner,
  progressOf,
  reasonKey,
  sourceKey,
  type DecisionButton,
} from './viewmodel';

/** Wire the page to the background worker and render. Returns a handle for tests. */
export function mountPopup(api: ExtApi): { refresh(): Promise<void> } {
  const i18n = api.i18n;
  const tr = (key: string, subs?: string | string[]): string => t(i18n, key, subs);

  let snapshot: Snapshot | null = null;
  let notice: string | null = null;
  let busy = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async function send<T = unknown>(request: UiRequest): Promise<UiResponse<T>> {
    try {
      const answer = (await api.runtime.sendMessage(request)) as UiResponse<T> | undefined;
      return (
        answer ?? {
          ok: false,
          error: { code: 'nm.timeout', message: 'No answer from the background worker.' },
        }
      );
    } catch {
      return {
        ok: false,
        error: { code: 'nm.timeout', message: 'The background worker did not answer.' },
      };
    }
  }

  async function refresh(): Promise<void> {
    const answer = await send<Snapshot>({ cmd: 'snapshot' });
    if (answer.ok) snapshot = answer.data;
    render();
  }

  function scheduleRefresh(): void {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 80);
  }

  function showNotice(text: string | null): void {
    notice = text;
    render();
  }

  function failureText(error: { code: string }): string {
    return errorText(i18n, error.code);
  }

  // ---------- decisions ----------

  async function decide(
    approval: Approval,
    button: DecisionButton,
    event: MouseEvent,
  ): Promise<void> {
    // Captured before any await: the click is the gesture, and only the browser's own flag counts.
    const gesture = event.isTrusted ? api.env.isUserActive() : false;
    if (busy) return;
    busy = true;
    showNotice(null);
    try {
      if (
        button.decision === 'approve' &&
        needsBrowserAccess(approval) &&
        approval.origin !== undefined
      ) {
        // The first await of the click handler, so the browser still sees the user gesture.
        if (!(await requestAccess(approval.origin))) {
          showNotice(tr('errPermissionDenied'));
          return;
        }
      }
      const answer = await send({
        cmd: 'approval.decide',
        approval_id: approval.id,
        decision: button.decision,
        user_gesture: gesture,
        surface: 'extension_popup',
        ...(button.scope === null ? {} : { scope: button.scope }),
      });
      if (!answer.ok) showNotice(tr('errDecideFailed', failureText(answer.error)));
    } finally {
      busy = false;
      await refresh();
    }
  }

  /** Ask the browser for the optional host and cookie permissions. Must run inside a click handler. */
  function requestAccess(origin: string): Promise<boolean> {
    return api.permissions
      .request({ permissions: ['cookies'], origins: [hostPattern(origin)] })
      .catch(() => false);
  }

  async function grantAccess(origin: string): Promise<void> {
    if (!(await requestAccess(origin))) showNotice(tr('errPermissionDenied'));
    await refresh();
  }

  async function command(request: UiRequest): Promise<void> {
    const answer = await send(request);
    if (!answer.ok) showNotice(tr('errCommandFailed', failureText(answer.error)));
    await refresh();
  }

  // ---------- rendering ----------

  function fact(labelKey: string, value: string): HTMLElement {
    return h('div', { class: 'fact' }, h('dt', {}, tr(labelKey)), h('dd', {}, value));
  }

  function approvalCard(approval: Approval, snap: Snapshot): HTMLElement {
    const title = displayText(approval.summary.title, 100);
    const origin = approval.origin ?? '';
    const needsAccess = needsBrowserAccess(approval);
    const expiresMs = Date.parse(approval.expires_at) - snap.now_ms;
    const reasons = approval.reason_codes.map((code) => {
      const key = reasonKey(code);
      return h('li', {}, key === null ? displayText(code, 60) : tr(key));
    });
    const facts = h('dl', { class: 'facts' });
    facts.append(
      fact('labelFileName', title),
      ...(origin === '' ? [] : [fact('labelSite', origin)]),
      ...(approval.summary.total_bytes === undefined || approval.summary.total_bytes === null
        ? []
        : [fact('labelSize', formatBytes(approval.summary.total_bytes))]),
      ...(approval.summary.source_kind === undefined ||
      sourceKey(approval.summary.source_kind) === null
        ? []
        : [fact('labelFrom', tr(sourceKey(approval.summary.source_kind) ?? 'sourceAgent'))]),
      ...(approval.summary.requested_by === undefined
        ? []
        : [fact('labelRequestedBy', displayText(approval.summary.requested_by, 80))]),
    );
    return h(
      'article',
      { class: 'card approval', 'aria-label': tr(approvalKindKey(approval.kind)) },
      h('h3', {}, tr(approvalKindKey(approval.kind))),
      facts,
      reasons.length > 0 ? h('ul', { class: 'reasons' }, ...reasons) : null,
      needsAccess ? h('p', { class: 'notice' }, tr('cookieNotice')) : null,
      h('p', { class: 'muted' }, tr('labelExpires', formatDuration(Math.max(0, expiresMs)))),
      h(
        'div',
        { class: 'actions' },
        ...decisionButtons(approval).map((button) =>
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              'data-style': button.style,
              disabled: busy,
              onclick: (event) => {
                void decide(approval, button, event);
              },
            },
            tr(button.labelKey),
          ),
        ),
      ),
    );
  }

  function accessCard(origin: string): HTMLElement {
    return h(
      'article',
      { class: 'card' },
      h('p', {}, tr('accessNeededHint', origin)),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          'data-style': 'primary',
          onclick: () => {
            void grantAccess(origin);
          },
        },
        tr('btnAllowAccess', origin),
      ),
    );
  }

  function jobRow(job: JobSummary, snap: Snapshot): HTMLElement {
    const fraction = progressOf(job);
    const name = displayText(job.filename ?? job.url_redacted, 80);
    const canControl = snap.link.capabilities.includes('job_control');
    return h(
      'li',
      { class: 'job' },
      h(
        'div',
        { class: 'job-head' },
        h('span', { class: 'job-name', title: name }, name),
        h('span', { class: 'job-state' }, tr(jobStateKey(job.state))),
      ),
      job.state === 'downloading' || job.state === 'verifying' || job.state === 'paused'
        ? h('progress', {
            max: 1,
            ...(fraction === null ? {} : { value: fraction }),
            'aria-label': name,
          })
        : null,
      job.bytes_total === null
        ? null
        : h(
            'span',
            { class: 'muted' },
            `${formatBytes(job.bytes_done)} / ${formatBytes(job.bytes_total)}`,
          ),
      job.quarantined ? h('p', { class: 'notice' }, tr('jobQuarantined')) : null,
      canControl
        ? h(
            'div',
            { class: 'actions small' },
            ...jobActions(job.state).map((action) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn',
                  'data-style': 'secondary',
                  onclick: () => {
                    void command({ cmd: 'job.control', job_id: job.id, action });
                  },
                },
                tr(JOB_ACTION_KEYS[action]),
              ),
            ),
          )
        : null,
    );
  }

  function render(): void {
    const root = document.getElementById('app');
    if (!root || !snapshot) return;
    const snap = snapshot;
    clear(root);

    const banner = linkBanner(snap.link);
    const status = document.getElementById('status');
    if (status) {
      status.textContent = tr(banner.titleKey);
      status.dataset.tone = banner.tone;
    }
    if (banner.hintKey !== null || banner.canReconnect) {
      root.append(
        h(
          'section',
          { class: 'card banner', 'data-tone': banner.tone },
          banner.hintKey === null ? null : h('p', {}, tr(banner.hintKey)),
          banner.canReconnect
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn',
                  'data-style': 'secondary',
                  onclick: () => {
                    void command({ cmd: 'reconnect' });
                  },
                },
                tr('btnReconnect'),
              )
            : null,
        ),
      );
    }
    if (notice !== null) root.append(h('p', { class: 'notice', role: 'alert' }, notice));

    const needAccess = snap.consent.filter((c) => !c.has_browser_permission).map((c) => c.origin);
    const uniqueAccess = [...new Set(needAccess)];
    if (snap.approvals.length > 0) {
      root.append(
        h('h2', {}, tr('sectionApprovals')),
        ...snap.approvals.map((a) => approvalCard(a, snap)),
      );
    }
    if (uniqueAccess.length > 0) {
      root.append(h('h2', {}, tr('sectionAccess')), ...uniqueAccess.map(accessCard));
    }

    const jobs = snap.jobs.slice(0, 8);
    if (jobs.length > 0) {
      root.append(
        h('h2', {}, tr('sectionJobs')),
        h('ul', { class: 'jobs' }, ...jobs.map((j) => jobRow(j, snap))),
      );
    }

    const candidates = snap.downloads;
    if (candidates.length > 0) {
      root.append(
        h('h2', {}, tr('sectionDownloads')),
        h(
          'ul',
          { class: 'jobs' },
          ...candidates.map((c) => {
            const note = candidateNote(c);
            return h(
              'li',
              { class: 'job' },
              h(
                'div',
                { class: 'job-head' },
                h('span', { class: 'job-name', title: c.filename }, c.filename),
                h(
                  'span',
                  { class: 'job-state' },
                  c.offer_status === null ? tr(note.stateKey) : tr('dlSentToZeus'),
                ),
              ),
              c.origin === null ? null : h('span', { class: 'muted' }, c.origin),
              note.refusalKey === null ? null : h('p', { class: 'notice' }, tr(note.refusalKey)),
              note.canForward && snap.link.connected
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn',
                      'data-style': 'primary',
                      onclick: () => {
                        void command({ cmd: 'download.forward', download_id: c.id });
                      },
                    },
                    tr('btnFinishWithZeus'),
                  )
                : null,
            );
          }),
        ),
      );
    }

    if (
      snap.approvals.length === 0 &&
      uniqueAccess.length === 0 &&
      jobs.length === 0 &&
      candidates.length === 0
    ) {
      root.append(h('p', { class: 'empty' }, tr('emptyState')));
    }
  }

  // ---------- start ----------

  applyI18n(i18n);
  document.getElementById('open-options')?.addEventListener('click', (event) => {
    event.preventDefault();
    void api.runtime.openOptionsPage();
  });
  const port = api.runtime.connect(POPUP_PORT_NAME);
  port.onMessage.addListener((message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'changed'
    )
      scheduleRefresh();
  });
  void refresh();

  return { refresh };
}
