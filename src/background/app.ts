// Composition root of the background worker: builds every module, wires the native link to the
// handlers, registers the browser listeners (synchronously, as Manifest V3 requires, so a worker
// woken by an event never misses it) and keeps the "connection desired" state in step with what
// Zeus has to do.
import { detectBrowser } from '../lib/browser';
import type { Env } from '../lib/env';
import { makeError } from '../lib/errors';
import { newInstanceId } from '../lib/ids';
import type { MessageSender, PagePort } from '../lib/platform';
import {
  PROTOCOL_VERSION,
  type Capability,
  type DaemonMessage,
  type DaemonMessageOf,
  type ExtBody,
} from '../lib/protocol';
import { POPUP_PORT_NAME, parseUiRequest } from '../lib/ui-protocol';
import { ApprovalCenter } from './approvals';
import { ConsentGate } from './consent';
import { DownloadWatcher } from './downloads';
import { EventProcessor } from './events';
import { FetchProxy } from './fetchProxy';
import { JobBook } from './jobs';
import { NativeLink, type LinkStatus, type LinkTiming } from './native';
import { Notifier } from './notify';
import { SessionService } from './session';
import { PageService } from './pages';
import { StateStore } from './state';
import { UiService } from './ui';

export const RECONNECT_ALARM = 'zeus-reconnect';
const RECONNECT_PERIOD_MIN = 0.5; // 30 s, the minimum Chrome allows

export interface Background {
  readonly link: NativeLink;
  readonly store: StateStore;
  readonly gate: ConsentGate;
  readonly approvals: ApprovalCenter;
  readonly jobs: JobBook;
  readonly downloads: DownloadWatcher;
  readonly fetchProxy: FetchProxy;
  readonly sessions: SessionService;
  readonly pages: PageService;
  readonly events: EventProcessor;
  readonly ui: UiService;
  /** Register listeners and open the native port. Call once, synchronously at worker start. */
  start(): void;
  /** Resolves when start-up work (cursor, cleanup) has finished; for tests. */
  ready(): Promise<void>;
}

export function createBackground(
  env: Env,
  opts: { timing?: Partial<LinkTiming> } = {},
): Background {
  const { api, log } = env;
  const swInstanceId = newInstanceId(env.rng);
  const browser = detectBrowser(api.env);
  const store = new StateStore(env);
  const gate = new ConsentGate(env, store);
  const jobs = new JobBook();
  const popupPorts = new Set<PagePort>();
  const internalDownloadIds = new Set<number>();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let hostMissingShown = false;
  let eventChain: Promise<void> = Promise.resolve();

  // The link's handlers refer to components declared further down. That is safe because they run
  // only after this function has finished constructing everything.

  const notifier = new Notifier(env, store);

  const changed = (): void => {
    if (pushTimer !== null) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      for (const port of popupPorts) port.postMessage({ type: 'changed' });
      void updateBadge();
      void reevaluateDesired();
    }, 50);
  };

  const link: NativeLink = new NativeLink(env, {
    ...(opts.timing === undefined ? {} : { timing: opts.timing }),
    isBusy: () => popupPorts.size > 0 || fetchProxy.openCount() > 0 || pages.openCount() > 0,
    buildHello: async () => {
      const capabilities: Capability[] = [
        'handoff',
        'session',
        'url_refresh.refetch',
        'url_refresh.download_api',
        'fetch_proxy',
        'kill_switch',
      ];
      if (!api.env.isIncognitoContext) capabilities.push('session.page');
      if (await api.extension.isAllowedIncognitoAccess().catch(() => false))
        capabilities.push('incognito');
      const cursor = await store.getLastEventSeq();
      const hello: ExtBody<'hello'> = {
        client: 'zeus-extension',
        extension_id: api.runtime.id,
        extension_version: api.runtime.version(),
        browser: {
          name: browser.name,
          version: browser.version.slice(0, 64),
          platform: browser.platform,
        },
        profile_id: await store.getProfileId(),
        protocol_versions: [PROTOCOL_VERSION],
        capabilities,
        sw_instance_id: swInstanceId,
      };
      if (cursor !== null) hello.resume = { last_event_seq: cursor };
      return hello;
    },
    handlers: {
      onReady: () => {
        void onReady();
      },
      onFrame: (message) => {
        onFrame(message);
      },
      onClosed: (reason) => {
        fetchProxy.abortAll();
        pages.abortAll();
        approvals.clear();
        if ((reason === 'host_not_found' || reason === 'forbidden') && !hostMissingShown) {
          hostMissingShown = true;
          void downloads
            .pendingOfferCount()
            .then((n) => (n > 0 ? notifier.hostMissing() : undefined));
        }
        changed();
      },
      onStatus: () => {
        changed();
      },
    },
  });

  const sessions = new SessionService(env, gate, store, {
    maxCookies: () => link.limits().max_cookie_count,
    internalDownloadIds,
  });
  const fetchProxy = new FetchProxy({
    env,
    gate,
    limits: () => link.limits(),
    send: (type, body, sendOpts) => link.send(type, body, sendOpts),
  });
  const pages = new PageService(env, gate, () => link.hasCapability('session.page'));
  const approvals = new ApprovalCenter(env, store, link, notifier, {
    changed,
    consentRemoved: (origin) => {
      fetchProxy.abortForOrigin(origin);
      pages.abortAll();
    },
  });
  const downloads = new DownloadWatcher(env, store, link, { changed, internalDownloadIds });
  const events = new EventProcessor(env, store, approvals, jobs, notifier, { changed });
  events.setOwnJobPredicate((jobId) => downloads.ownsJob(jobId));
  const ui = new UiService(env, store, link, approvals, jobs, downloads, browser, {
    reconnect: () => {
      link.reconnectNow();
    },
    changed,
  });

  // ---------- link events ----------

  async function onReady(): Promise<void> {
    await readyPromise; // the persisted event cursor must be loaded before subscribing from it
    try {
      const since = events.cursor;
      const answer = await link.request('events.subscribe', {
        ...(since > 0 ? { since_seq: since } : {}),
        include_progress: popupPorts.size > 0,
        progress_interval_ms: 1000,
        scope: 'all',
      });
      if (answer.type === 'events.subscribe.response' && answer.body.replay_truncated)
        log.info('event replay truncated');
    } catch (e) {
      log.warn('events.subscribe failed', { error: e instanceof Error ? e.message : 'unknown' });
    }
    await refreshJobs();
    await downloads.flush();
    await reevaluateDesired();
    changed();
  }

  async function refreshJobs(): Promise<void> {
    try {
      const answer = await link.request('job.list', { limit: 50 });
      if (answer.type === 'job.list.response') jobs.replace(answer.body.jobs);
    } catch {
      /* job_control may be missing; the event stream still fills the mirror */
    }
  }

  function onFrame(message: DaemonMessage): void {
    switch (message.type) {
      case 'session.request':
        void answer(message, () => sessions.handleSessionRequest(message));
        return;
      case 'session.page.request':
        void answer(message, async () => ({
          type: 'session.page.response',
          body: await pages.read(message.body, message.id),
        }));
        return;
      case 'session.page.cancel':
        pages.cancel(message.body.request_id);
        return;
      case 'url.refresh.request':
        void answer(message, () => sessions.handleUrlRefresh(message));
        return;
      case 'fetch.range':
        fetchProxy.handleRange(message);
        changed();
        return;
      case 'fetch.credit':
        fetchProxy.handleCredit(message);
        return;
      case 'fetch.cancel':
        fetchProxy.handleCancel(message);
        return;
      case 'approval.pending':
        void approvals.onPending(message.body.approval);
        return;
      case 'job.event':
        eventChain = eventChain
          .then(() => events.handle(message))
          .catch((e: unknown) => {
            log.warn('event handling failed', { error: e instanceof Error ? e.name : 'unknown' });
          });
        return;
      default:
        log.debug('unhandled frame', { type: message.type });
    }
  }

  /** Run a request handler and post its reply with `re`; any failure becomes an error frame. */
  async function answer(
    request:
      | DaemonMessageOf<'session.request'>
      | DaemonMessageOf<'url.refresh.request'>
      | DaemonMessageOf<'session.page.request'>,
    run: () => Promise<{
      type: 'session.response' | 'url.refresh.response' | 'session.page.response' | 'error';
      body: unknown;
    }>,
  ): Promise<void> {
    try {
      const reply = await run();
      link.send(reply.type, reply.body as never, { re: request.id });
    } catch (e) {
      log.error('request handler failed', {
        type: request.type,
        error: e instanceof Error ? e.name : 'unknown',
      });
      link.send(
        'error',
        { error: makeError('nm.internal', 'The request could not be handled.') },
        { re: request.id },
      );
    }
  }

  // ---------- derived state ----------

  /**
   * Zeus needs the connection while something depends on the browser: an offer not yet answered, an
   * approval waiting for a click, a job started from this browser that is still running, a job
   * waiting for the extension, or an open fetch stream (spec 02 section 4 rule 5). Agent downloads
   * that need nothing from the browser do not keep it connected.
   */
  async function reevaluateDesired(): Promise<void> {
    const ownJobIds = new Set(
      (await store.listOffers()).map((o) => o.job_id).filter((id): id is string => id !== null),
    );
    const wanted =
      (await downloads.pendingOfferCount()) > 0 ||
      approvals.size() > 0 ||
      fetchProxy.openCount() > 0 ||
      jobs.hasActive((job) => ownJobIds.has(job.id) || job.state === 'awaiting_session');
    if (wanted === (await store.getDesired())) {
      link.setDesired(wanted);
      return;
    }
    await store.setDesired(wanted);
    if (wanted) await api.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_PERIOD_MIN });
    else await api.alarms.clear(RECONNECT_ALARM);
    link.setDesired(wanted);
  }

  async function updateBadge(): Promise<void> {
    const status: LinkStatus = link.status();
    const broken =
      status.state === 'suspended' ||
      (status.state !== 'ready' &&
        (status.closeReason === 'host_not_found' || status.closeReason === 'forbidden'));
    const pending = approvals.size();
    try {
      if (broken) {
        await api.action.setBadgeText('!');
        await api.action.setBadgeBackgroundColor('#b3261e');
      } else if (pending > 0) {
        await api.action.setBadgeText(String(pending));
        await api.action.setBadgeBackgroundColor('#1a73e8');
      } else {
        await api.action.setBadgeText('');
      }
    } catch {
      /* the action API may be unavailable while the browser shuts down */
    }
  }

  /** Re-subscribe so progress events flow only while the popup is open. */
  async function resubscribe(): Promise<void> {
    if (!link.isReady()) return;
    try {
      await link.request('events.subscribe', {
        include_progress: popupPorts.size > 0,
        progress_interval_ms: 1000,
        scope: 'all',
      });
    } catch {
      /* best effort */
    }
  }

  async function pruneConsent(): Promise<void> {
    for (const record of await store.pruneConsent()) fetchProxy.abortForOrigin(record.origin);
  }

  // ---------- registration ----------

  function start(): void {
    api.runtime.onMessage.addListener((message: unknown, sender: MessageSender, respond) => {
      if (!ui.isTrustedSender(sender)) return undefined; // not our page: no answer, no action
      const request = parseUiRequest(message);
      if (request === null) {
        respond({ ok: false, error: { code: 'nm.schema_violation', message: 'Unknown command.' } });
        return undefined;
      }
      void ui.handle(request).then(respond);
      return true;
    });

    api.runtime.onConnect.addListener((port) => {
      if (port.name !== POPUP_PORT_NAME || !ui.isTrustedSender(port.sender)) {
        port.disconnect();
        return;
      }
      popupPorts.add(port);
      link.ensureConnected();
      link.touch();
      void resubscribe();
      port.onDisconnect.addListener(() => {
        popupPorts.delete(port);
        if (popupPorts.size === 0) void resubscribe();
        link.touch();
      });
    });

    api.runtime.onStartup.addListener(() => {
      link.ensureConnected();
    });
    api.runtime.onInstalled.addListener(() => {
      link.ensureConnected();
    });
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== RECONNECT_ALARM) return;
      void (async () => {
        await pruneConsent();
        if (await store.getDesired()) link.ensureConnected();
        else await api.alarms.clear(RECONNECT_ALARM);
      })();
    });
    api.notifications.onClicked.addListener(() => {
      void notifier.openPopup();
    });
    api.permissions.onRemoved.addListener((removed) => {
      pages.abortAll();
      for (const pattern of removed.origins ?? [])
        fetchProxy.abortForOrigin(pattern.replace(/\/\*$/, ''));
    });
    downloads.register();

    // Spec 02 section 4 rule 1: open the port at worker start; the idle policy closes it again.
    link.ensureConnected();
    void ready();
  }

  let readyPromise: Promise<void> = Promise.resolve();
  function ready(): Promise<void> {
    readyPromise = (async () => {
      await events.init();
      await pruneConsent();
      if (await store.getDesired())
        await api.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_PERIOD_MIN });
      await updateBadge();
    })();
    return readyPromise;
  }

  return {
    link,
    store,
    gate,
    approvals,
    jobs,
    downloads,
    fetchProxy,
    sessions,
    pages,
    events,
    ui,
    start,
    ready: () => readyPromise,
  };
}
