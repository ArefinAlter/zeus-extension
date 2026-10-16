// The trust surface: shows what Zeus needs the human to decide and carries the decision back.
// Every approve click first asks the browser for the optional host (and cookie) permission from
// inside the click handler, which is the only place a browser lets that prompt appear, and only
// then sends the decision, attested with the gesture that the browser's own user-activation flag
// confirmed. Text from remote servers is shown with textContent only.
import {
  approvalBinding,
  approvalRequiresTerminal,
  bindCode,
  needsBrowserAccess,
  normalizeBindCode,
} from '../lib/approval';
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
  const firstShown = new Map<string, number>();
  const typedCodes = new Map<string, string>();
  const approvalCards = new Map<string, { signature: string; element: HTMLElement }>();

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
    const binding = approvalBinding(approval);
    if (!binding) {
      showNotice(tr('errApprovalIntegrity'));
      return;
    }
    const required =
      button.decision === 'deny' ? 'gesture' : binding.confirmation[button.scope ?? 'approve'];
    if (
      button.decision === 'approve' &&
      Date.now() - (firstShown.get(binding.hash) ?? Date.now()) < 750
    )
      return;
    const typedCode = typedCodes.get(binding.hash) ?? '';
    if (
      required === 'typed_code' &&
      normalizeBindCode(typedCode) !== normalizeBindCode(binding.code)
    ) {
      showNotice(tr('errConfirmationCode'));
      return;
    }
    if (required !== 'gesture' && required !== 'typed_code') return;
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
        request_hash: binding.hash,
        revision: binding.revision,
        confirmation: required,
        ...(required === 'typed_code' ? { typed_code: typedCode } : {}),
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

  function boundFactRows(value: unknown, path: string[] = []): HTMLElement[] {
    const labels: Record<string, string> = {
      requester: 'Asked by',
      client_id: 'Client',
      label: 'Name',
      role: 'Channel',
      kind: 'Type',
      origin: 'Website',
      first_time_for_origin: 'First use of this website',
      transfer: 'Files',
      job_ids: 'Downloads',
      total_bytes: 'Total size',
      unknown_size_count: 'Files with unknown size',
      dest_dirs: 'Save to',
      dest_dirs_omitted: 'Other folders',
      items: 'Files to fetch',
      items_omitted: 'Other files',
      untrusted_name: 'Website supplied name',
      untrusted_url: 'Website supplied link',
      browser: 'Browser',
      name: 'Name',
      incognito: 'Private window',
      scope_hint: 'Requested duration',
      run_id: 'Plan run',
      job_id: 'Download',
      bytes_done: 'Already saved',
      bytes_total: 'Total size',
      error: 'Problem',
      code: 'Reason',
      class: 'Category',
      refreshes_used: 'Link refreshes used',
    };
    const hidden = new Set([
      't',
      'approval_id',
      'revision',
      'issued_at',
      'expires_at',
      'confirmation',
      'allowed_scopes',
      'reason_codes',
      'agent_says_blake3',
    ]);
    if (Array.isArray(value))
      return value.flatMap((child, i) => boundFactRows(child, [...path, String(i + 1)]));
    if (typeof value === 'object' && value !== null)
      return Object.entries(value).flatMap(([key, child]) =>
        path.length === 0 && hidden.has(key)
          ? []
          : boundFactRows(child, [...path, labels[key] ?? key.replaceAll('_', ' ')]),
      );
    const label = path.join(' · ');
    const text =
      value === null ? 'Not known' : typeof value === 'string' ? value : JSON.stringify(value);
    return [
      h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, displayText(text, 16_384))),
    ];
  }

  function approvalCard(approval: Approval, snap: Snapshot): HTMLElement {
    // Progress updates must not rebuild unchanged review facts or endlessly restart arming.
    // A changed request, busy state or expiry minute creates a genuinely new review rendering.
    const signature = JSON.stringify({ approval, busy, minute: Math.floor(snap.now_ms / 60_000) });
    const cached = approvalCards.get(approval.id);
    if (cached?.signature === signature) return cached.element;
    const binding = approvalBinding(approval);
    if (binding) firstShown.set(binding.hash, Date.now());
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
    const card = h(
      'article',
      { class: 'card approval', 'aria-label': tr(approvalKindKey(approval.kind)) },
      h('h3', {}, tr(approvalKindKey(approval.kind))),
      facts,
      binding
        ? h(
            'div',
            { class: 'binding-facts' },
            h(
              'p',
              {},
              `${tr('labelRequestCode')}: ${bindCode(binding.hash)} · ${binding.hash.slice(0, 16)}`,
            ),
            h('dl', { class: 'facts bound-facts' }, ...boundFactRows(binding.facts)),
            binding.agentSays
              ? h(
                  'blockquote',
                  { class: 'agent-says' },
                  h('strong', {}, tr('labelAgentText')),
                  h('p', {}, displayText(binding.agentSays, 280)),
                )
              : null,
            Object.values(binding.confirmation).includes('typed_code')
              ? h(
                  'label',
                  {},
                  tr('labelConfirmationCode'),
                  h('input', {
                    type: 'text',
                    autocomplete: 'off',
                    spellcheck: 'false',
                    'aria-label': tr('labelConfirmationCode'),
                    value: typedCodes.get(binding.hash) ?? '',
                    oninput: (event) =>
                      typedCodes.set(binding.hash, (event.target as HTMLInputElement).value),
                  }),
                )
              : null,
          )
        : h(
            'p',
            { class: 'notice' },
            tr(
              approvalRequiresTerminal(approval)
                ? 'hintCloudTerminalReview'
                : 'errApprovalIntegrity',
            ),
          ),
      reasons.length > 0 ? h('ul', { class: 'reasons' }, ...reasons) : null,
      needsAccess ? h('p', { class: 'notice' }, tr('cookieNotice')) : null,
      h('p', { class: 'muted' }, tr('labelExpires', formatDuration(Math.max(0, expiresMs)))),
      h(
        'div',
        { class: 'actions' },
        ...decisionButtons(approval)
          .filter(
            (button) =>
              binding !== null &&
              (button.decision === 'deny' ||
                ['gesture', 'typed_code'].includes(
                  String(binding.confirmation[button.scope ?? 'approve']),
                )),
          )
          .map((button) => {
            const control = h(
              'button',
              {
                type: 'button',
                class: 'btn',
                'data-style': button.style,
                disabled:
                  busy ||
                  (button.decision === 'approve' &&
                    binding !== null &&
                    Date.now() - (firstShown.get(binding.hash) ?? Date.now()) < 750),
                onclick: (event) => {
                  void decide(approval, button, event);
                },
              },
              tr(button.labelKey),
            );
            if (button.decision === 'approve' && !busy) {
              setTimeout(() => {
                if (control.isConnected && !busy) control.disabled = false;
              }, 760);
            }
            return control;
          }),
      ),
    );
    approvalCards.set(approval.id, { signature, element: card });
    return card;
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
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const currentApprovals = new Set(snap.approvals.map((approval) => approval.id));
    for (const id of approvalCards.keys()) if (!currentApprovals.has(id)) approvalCards.delete(id);
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
    if (snap.link.capabilities.includes('kill_switch'))
      root.append(
        h(
          'div',
          { class: 'actions' },
          ...(['engage', 'release'] as const).map((action) =>
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: (event) => {
                  void command({
                    cmd: 'kill_switch',
                    action,
                    user_gesture: event.isTrusted && api.env.isUserActive(),
                  });
                },
              },
              tr(action === 'engage' ? 'btnStopAll' : 'btnReleaseStop'),
            ),
          ),
        ),
      );
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
    if (focused instanceof HTMLInputElement && focused.isConnected)
      focused.focus({ preventScroll: true });
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
