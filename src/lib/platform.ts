// The only module that touches the `chrome` / `browser` globals. Everything else receives an
// `ExtApi` by injection, which keeps the narrow set of browser features the extension uses visible
// in one place and lets the tests substitute the hand-written mock in test/harness.

/** A browser event with the subset of the WebExtension event interface used here. */
export interface Evt<F extends (...args: never[]) => unknown> {
  addListener(callback: F): void;
}

export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface DownloadItem {
  id: number;
  url: string;
  finalUrl: string;
  referrer: string;
  filename: string;
  incognito: boolean;
  danger: string;
  mime: string;
  startTime: string;
  state: 'in_progress' | 'interrupted' | 'complete';
  paused: boolean;
  canResume: boolean;
  error?: string;
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
  exists: boolean;
  byExtensionId?: string;
}

export interface DownloadDelta {
  id: number;
  state?: { previous?: string; current?: string };
  error?: { previous?: string; current?: string };
  finalUrl?: { previous?: string; current?: string };
  paused?: { previous?: boolean; current?: boolean };
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  hostOnly: boolean;
  session: boolean;
  /** Seconds since the epoch; absent for session cookies. */
  expirationDate?: number;
  storeId: string;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor?: boolean };
}

export interface CookieStore {
  id: string;
  tabIds: number[];
}

export interface Permissions {
  /** Only `cookies` is ever requested at runtime; everything else is static. */
  permissions?: 'cookies'[];
  origins?: string[];
}

export interface NotificationSpec {
  type: 'basic';
  iconUrl: string;
  title: string;
  message: string;
  priority?: number;
  requireInteraction?: boolean;
}

export interface MessageSender {
  id?: string | undefined;
  url?: string | undefined;
  tabId?: number | undefined;
  frameId?: number | undefined;
}

/** A native-messaging port. `reason` carries the browser's last error text on disconnect. */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Evt<(message: unknown) => void>;
  onDisconnect: Evt<(reason: string | undefined) => void>;
}

/** A port between the background and one of the extension's own pages (the popup). */
export interface PagePort {
  readonly name: string;
  readonly sender: MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Evt<(message: unknown) => void>;
  onDisconnect: Evt<() => void>;
}

export type MessageListener = (
  message: unknown,
  sender: MessageSender,
  respond: (response?: unknown) => void,
) => boolean | undefined;

export interface UserAgentData {
  brands: readonly { brand: string; version: string }[];
  mobile: boolean;
  platform: string;
}

export interface ExtEnv {
  userAgent: string;
  userAgentData: UserAgentData | null;
  /** True inside a handler running on a user gesture (button click in an extension page). */
  isUserActive(): boolean;
  /** True when the host is Firefox (decides the private cookie store and API quirks). */
  isFirefox: boolean;
  /** The current extension context is private; ordinary page fetches must never choose another jar. */
  isIncognitoContext: boolean;
}

export interface ExtApi {
  runtime: {
    readonly id: string;
    getURL(path: string): string;
    version(): string;
    connectNative(host: string): NativePort;
    connect(name: string): PagePort;
    sendMessage(message: unknown): Promise<unknown>;
    openOptionsPage(): Promise<void>;
    onMessage: Evt<MessageListener>;
    onConnect: Evt<(port: PagePort) => void>;
    onStartup: Evt<() => void>;
    onInstalled: Evt<() => void>;
  };
  storage: { local: StorageArea; session: StorageArea };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): Promise<void>;
    clear(name: string): Promise<boolean>;
    onAlarm: Evt<(alarm: { name: string }) => void>;
  };
  downloads: {
    search(query: {
      id?: number;
      state?: 'in_progress' | 'interrupted' | 'complete';
      orderBy?: ('startTime' | '-startTime')[];
      limit?: number;
    }): Promise<DownloadItem[]>;
    download(options: { url: string; saveAs?: boolean }): Promise<number>;
    cancel(id: number): Promise<void>;
    erase(query: { id: number }): Promise<number[]>;
    removeFile(id: number): Promise<void>;
    onCreated?: Evt<(item: DownloadItem) => void>;
    onChanged: Evt<(delta: DownloadDelta) => void>;
    onErased: Evt<(id: number) => void>;
  };
  cookies: {
    getAll(details: {
      url: string;
      storeId?: string;
      partitionKey?: { topLevelSite: string };
    }): Promise<BrowserCookie[]>;
    getAllCookieStores(): Promise<CookieStore[]>;
  };
  permissions: {
    contains(request: Permissions): Promise<boolean>;
    request(request: Permissions): Promise<boolean>;
    remove(request: Permissions): Promise<boolean>;
    onRemoved: Evt<(removed: Permissions) => void>;
  };
  notifications: {
    create(id: string, spec: NotificationSpec): Promise<string>;
    clear(id: string): Promise<boolean>;
    onClicked: Evt<(id: string) => void>;
  };
  i18n: {
    getMessage(key: string, substitutions?: string | string[]): string;
    getAcceptLanguages(): Promise<string[]>;
    getUILanguage(): string;
  };
  tabs: { get(tabId: number): Promise<{ incognito: boolean }> };
  action: {
    setBadgeText(text: string): Promise<void>;
    setBadgeBackgroundColor(color: string): Promise<void>;
    /** Absent on browsers that cannot open the popup programmatically. */
    openPopup?: () => Promise<void>;
  };
  extension: { isAllowedIncognitoAccess(): Promise<boolean> };
  env: ExtEnv;
}

type ChromeNs = typeof chrome;

/** The parts of `navigator` that are not available everywhere (Firefox has no userAgentData). */
interface NavigatorLike {
  userAgent: string;
  userActivation?: { isActive: boolean };
  userAgentData?: UserAgentData;
}

function wrapEvent<F extends (...args: never[]) => unknown>(event: {
  addListener(cb: F): void;
}): Evt<F> {
  return {
    addListener: (cb) => {
      event.addListener(cb);
    },
  };
}

function toSender(s: chrome.runtime.MessageSender): MessageSender {
  return { id: s.id, url: s.url, tabId: s.tab?.id, frameId: s.frameId };
}

/** Wraps a native port; Chrome reports the failure text in runtime.lastError, Firefox in port.error. */
function wrapNativePort(ns: ChromeNs, port: chrome.runtime.Port): NativePort {
  return {
    postMessage: (message) => {
      port.postMessage(message);
    },
    disconnect: () => {
      port.disconnect();
    },
    onMessage: {
      addListener: (cb) => {
        port.onMessage.addListener((m: unknown) => {
          cb(m);
        });
      },
    },
    onDisconnect: {
      addListener: (cb) => {
        port.onDisconnect.addListener((p) => {
          const withError = p as chrome.runtime.Port & { error?: { message?: string } };
          cb(ns.runtime.lastError?.message ?? withError.error?.message);
        });
      },
    },
  };
}

function wrapPagePort(port: chrome.runtime.Port): PagePort {
  return {
    name: port.name,
    sender: port.sender ? toSender(port.sender) : {},
    postMessage: (message) => {
      port.postMessage(message);
    },
    disconnect: () => {
      port.disconnect();
    },
    onMessage: {
      addListener: (cb) => {
        port.onMessage.addListener((m: unknown) => {
          cb(m);
        });
      },
    },
    onDisconnect: {
      addListener: (cb) => {
        port.onDisconnect.addListener(() => {
          cb();
        });
      },
    },
  };
}

function wrapStorage(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => area.get<Record<string, unknown>>(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

/**
 * Build the real `ExtApi` from the extension global. Prefers `browser` (promise-based everywhere,
 * present in Firefox and in Chrome 148 and later) and falls back to `chrome`. Must only run inside
 * an extension context.
 */
export function createExtApi(): ExtApi {
  const g = globalThis as unknown as { browser?: ChromeNs; chrome?: ChromeNs };
  const ns = g.browser ?? g.chrome;
  if (!ns) throw new Error('no extension API available in this context');
  const nav = (globalThis as unknown as { navigator: NavigatorLike }).navigator;
  const ua = nav.userAgent;
  return {
    runtime: {
      id: ns.runtime.id,
      getURL: (path) => ns.runtime.getURL(path),
      version: () => ns.runtime.getManifest().version,
      connectNative: (host) => wrapNativePort(ns, ns.runtime.connectNative(host)),
      connect: (name) => wrapPagePort(ns.runtime.connect({ name })),
      sendMessage: (message) => ns.runtime.sendMessage<unknown, unknown>(message),
      openOptionsPage: () => ns.runtime.openOptionsPage(),
      onMessage: {
        addListener: (cb) => {
          ns.runtime.onMessage.addListener(
            (message: unknown, sender, sendResponse) =>
              cb(message, toSender(sender), sendResponse) === true,
          );
        },
      },
      onConnect: {
        addListener: (cb) => {
          ns.runtime.onConnect.addListener((p) => {
            cb(wrapPagePort(p));
          });
        },
      },
      onStartup: wrapEvent(ns.runtime.onStartup),
      onInstalled: wrapEvent(ns.runtime.onInstalled),
    },
    storage: { local: wrapStorage(ns.storage.local), session: wrapStorage(ns.storage.session) },
    alarms: {
      create: (name, info) => Promise.resolve(ns.alarms.create(name, info)),
      clear: (name) => ns.alarms.clear(name),
      onAlarm: wrapEvent(ns.alarms.onAlarm),
    },
    downloads: {
      search: (query) => ns.downloads.search(query) as Promise<DownloadItem[]>,
      download: (options) => ns.downloads.download(options),
      cancel: (id) => ns.downloads.cancel(id),
      erase: (query) => ns.downloads.erase(query),
      removeFile: (id) => ns.downloads.removeFile(id),
      onCreated: ns.downloads.onCreated
        ? wrapEvent(ns.downloads.onCreated as unknown as Evt<(item: DownloadItem) => void>)
        : undefined,
      onChanged: wrapEvent(ns.downloads.onChanged as unknown as Evt<(d: DownloadDelta) => void>),
      onErased: wrapEvent(ns.downloads.onErased),
    },
    cookies: {
      getAll: (details) => ns.cookies.getAll(details) as Promise<BrowserCookie[]>,
      getAllCookieStores: () => ns.cookies.getAllCookieStores(),
    },
    permissions: {
      contains: (request) => ns.permissions.contains(request),
      request: (request) => ns.permissions.request(request),
      remove: (request) => ns.permissions.remove(request),
      onRemoved: wrapEvent(ns.permissions.onRemoved),
    },
    notifications: {
      create: (id, spec) => ns.notifications.create(id, spec),
      clear: (id) => ns.notifications.clear(id),
      onClicked: wrapEvent(ns.notifications.onClicked),
    },
    i18n: {
      getMessage: (key, substitutions) => ns.i18n.getMessage(key, substitutions),
      getAcceptLanguages: () => ns.i18n.getAcceptLanguages(),
      getUILanguage: () => ns.i18n.getUILanguage(),
    },
    tabs: { get: (tabId) => ns.tabs.get(tabId) },
    action: {
      setBadgeText: (text) => ns.action.setBadgeText({ text }),
      setBadgeBackgroundColor: (color) => ns.action.setBadgeBackgroundColor({ color }),
      ...(typeof ns.action.openPopup === 'function'
        ? { openPopup: () => Promise.resolve(ns.action.openPopup()) }
        : {}),
    },
    extension: { isAllowedIncognitoAccess: () => ns.extension.isAllowedIncognitoAccess() },
    env: {
      userAgent: ua,
      userAgentData: nav.userAgentData ?? null,
      isUserActive: () => nav.userActivation?.isActive === true,
      isFirefox: /\bFirefox\//.test(ua),
      isIncognitoContext: ns.extension.inIncognitoContext,
    },
  };
}
