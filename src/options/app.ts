// Options page: connection status, the sites Zeus may use the session for (with revoke), settings
// and the facts a person needs to register the native host. It reads the same snapshot as the
// popup and runs the same commands; it cannot approve anything.
import { t, errorText } from '../lib/messages';
import type { ExtApi } from '../lib/platform';
import { displayText } from '../lib/sanitize';
import type { Snapshot, UiRequest, UiResponse } from '../lib/ui-protocol';
import { applyI18n, clear, h } from '../popup/dom';
import { formatDuration, linkBanner, scopeKey } from '../popup/viewmodel';

/** Wire the page to the background worker and render. Returns a handle for tests. */
export function mountOptions(api: ExtApi): { refresh(): Promise<void> } {
  const i18n = api.i18n;
  const tr = (key: string, subs?: string | string[]): string => t(i18n, key, subs);

  let snapshot: Snapshot | null = null;
  let notice: string | null = null;

  async function send<T = unknown>(request: UiRequest): Promise<UiResponse<T>> {
    try {
      const answer = (await api.runtime.sendMessage(request)) as UiResponse<T> | undefined;
      return answer ?? { ok: false, error: { code: 'nm.timeout', message: 'No answer.' } };
    } catch {
      return { ok: false, error: { code: 'nm.timeout', message: 'No answer.' } };
    }
  }

  async function refresh(): Promise<void> {
    const answer = await send<Snapshot>({ cmd: 'snapshot' });
    if (answer.ok) snapshot = answer.data;
    render();
  }

  async function command(request: UiRequest): Promise<void> {
    const answer = await send(request);
    notice = answer.ok ? null : tr('errCommandFailed', errorText(i18n, answer.error.code));
    await refresh();
  }

  function row(labelKey: string, value: string): HTMLElement {
    return h('tr', {}, h('th', {}, tr(labelKey)), h('td', {}, value));
  }

  function checkbox(
    labelKey: string,
    helpKey: string | null,
    checked: boolean,
    onChange: (value: boolean) => void,
  ): HTMLElement {
    const input = h('input', {
      type: 'checkbox',
      checked,
      onchange: (event) => {
        onChange((event.target as HTMLInputElement).checked);
      },
    });
    return h(
      'label',
      { class: 'row' },
      input,
      h(
        'span',
        {},
        tr(labelKey),
        helpKey === null ? null : h('div', { class: 'muted' }, tr(helpKey)),
      ),
    );
  }

  function render(): void {
    const root = document.getElementById('app');
    if (!root || !snapshot) return;
    const snap = snapshot;
    clear(root);
    if (notice !== null) root.append(h('p', { class: 'notice', role: 'alert' }, notice));

    // status
    const banner = linkBanner(snap.link);
    const status = h(
      'table',
      {},
      row('optExtensionId', snap.extension.id),
      row('optVersion', snap.extension.version),
    );
    status.append(
      row(
        'optBrowser',
        `${snap.extension.browser.name} ${snap.extension.browser.version} (${snap.extension.browser.platform})`,
      ),
      row('optProfile', snap.extension.profile_id.slice(0, 8)),
      row('optDaemon', snap.link.daemon_version ?? '–'),
      row(
        'optProtocol',
        snap.link.protocol_version === null ? '–' : String(snap.link.protocol_version),
      ),
      row('optCapabilities', snap.link.capabilities.join(', ') || '–'),
    );
    root.append(
      h(
        'section',
        {},
        h('h2', {}, tr('optSectionStatus')),
        h('p', { class: 'status', 'data-tone': banner.tone }, tr(banner.titleKey)),
        banner.hintKey === null ? null : h('p', {}, tr(banner.hintKey)),
        banner.canReconnect
          ? h(
              'button',
              { type: 'button', class: 'btn', onclick: () => void command({ cmd: 'reconnect' }) },
              tr('btnReconnect'),
            )
          : null,
        status,
        h('p', { class: 'muted' }, tr('optHostHelp')),
      ),
    );

    // sites
    const access = h('table', {});
    for (const c of snap.consent) {
      access.append(
        h(
          'tr',
          {},
          h('td', {}, c.origin),
          h('td', {}, tr(scopeKey(c.scope))),
          h(
            'td',
            {},
            tr('labelExpires', formatDuration(Math.max(0, c.expires_at_ms - snap.now_ms))),
          ),
          h(
            'td',
            {},
            c.has_browser_permission ? tr('optBrowserPermissionYes') : tr('optBrowserPermissionNo'),
          ),
          h(
            'td',
            {},
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                'data-style': 'danger',
                disabled: !snap.link.capabilities.includes('grants'),
                onclick: () => void command({ cmd: 'grant.revoke', grant_id: c.grant_id }),
              },
              tr('btnRevoke'),
            ),
          ),
        ),
      );
    }
    root.append(
      h(
        'section',
        {},
        h('h2', {}, tr('optSectionAccess')),
        snap.consent.length === 0 ? h('p', { class: 'muted' }, tr('optNoAccess')) : access,
      ),
    );

    const blocked = h('table', {});
    for (const n of snap.never) {
      blocked.append(
        h(
          'tr',
          {},
          h('td', {}, displayText(n.origin, 80)),
          h(
            'td',
            {},
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                disabled: !snap.link.capabilities.includes('grants'),
                onclick: () => void command({ cmd: 'grant.revoke', grant_id: n.grant_id }),
              },
              tr('btnRevoke'),
            ),
          ),
        ),
      );
    }
    root.append(
      h(
        'section',
        {},
        h('h2', {}, tr('optBlocked')),
        snap.never.length === 0 ? h('p', { class: 'muted' }, tr('optNoBlocked')) : blocked,
      ),
    );

    // settings
    root.append(
      h(
        'section',
        {},
        h('h2', {}, tr('optSectionSettings')),
        checkbox(
          'optAutoOffer',
          'optAutoOfferHelp',
          snap.settings.auto_offer,
          (value) => void command({ cmd: 'settings.set', patch: { auto_offer: value } }),
        ),
        checkbox(
          'optNotifications',
          null,
          snap.settings.notifications,
          (value) => void command({ cmd: 'settings.set', patch: { notifications: value } }),
        ),
      ),
    );

    root.append(
      h(
        'section',
        {},
        h('h2', {}, tr('optSectionAbout')),
        h('p', { class: 'muted' }, tr('optNoTelemetry')),
      ),
    );
  }

  applyI18n(i18n);
  void refresh();
  setInterval(() => void refresh(), 4000);

  return { refresh };
}
