// A hand-written, dependency-free stand-in for the browser extension APIs the extension uses.
// It implements the narrow `ExtApi` interface (src/lib/platform.ts) and exposes control handles so
// tests can drive browser events (download interruptions, alarms, popup messages) and observe
// side effects (notifications, permission prompts, storage contents).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BrowserCookie,
  CookieStore,
  DownloadDelta,
  DownloadItem,
  Evt,
  ExtApi,
  MessageListener,
  MessageSender,
  NativePort,
  NotificationSpec,
  PagePort,
  Permissions,
  StorageArea,
  UserAgentData,
} from '../../src/lib/platform';

/** An event with a controllable `emit`. */
export class MockEvent<F extends (...args: never[]) => unknown> implements Evt<F> {
  readonly listeners: F[] = [];
  addListener(callback: F): void {
    this.listeners.push(callback);
  }
  emit(...args: Parameters<F>): void {
    for (const l of [...this.listeners]) l(...args);
  }
}

export class MockStorage implements StorageArea {
  readonly data = new Map<string, unknown>();
  writes = 0;
  failNext: Error | null = null;

  private takeFailure(): Error | null {
    const failure = this.failNext;
    this.failNext = null;
    return failure;
  }
  get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const failure = this.takeFailure();
    if (failure) return Promise.reject(failure);
    const names = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of names) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return Promise.resolve(out);
  }
  set(items: Record<string, unknown>): Promise<void> {
    const failure = this.takeFailure();
    if (failure) return Promise.reject(failure);
    this.writes += 1;
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
    return Promise.resolve();
  }
  remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
    return Promise.resolve();
  }
  /** Everything stored, as one string, for "no secret ever persisted" assertions. */
  dump(): string {
    return JSON.stringify([...this.data.entries()]);
  }
}

export class MockNativePort implements NativePort {
  readonly posted: unknown[] = [];
  readonly onMessage = new MockEvent<(message: unknown) => void>();
  readonly onDisconnect = new MockEvent<(reason: string | undefined) => void>();
  connected = true;
  disconnectedByExtension = false;

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(structuredClone(message));
    this.onPosted?.(message);
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.disconnectedByExtension = true;
  }
  /** Host side: deliver a frame to the extension. */
  deliver(message: unknown): void {
    if (this.connected) this.onMessage.emit(structuredClone(message));
  }
  /** Host side: the host process went away. */
  hostDisconnect(reason?: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.onDisconnect.emit(reason);
  }
  onPosted: ((message: unknown) => void) | null = null;
}

export class MockPagePort implements PagePort {
  readonly onMessage = new MockEvent<(message: unknown) => void>();
  readonly onDisconnect = new MockEvent<() => void>();
  readonly posted: unknown[] = [];
  connected = true;
  constructor(
    readonly name: string,
    readonly sender: MessageSender,
  ) {}
  postMessage(message: unknown): void {
    this.posted.push(structuredClone(message));
  }
  disconnect(): void {
    this.close();
  }
  /** Page side closing (popup closed). */
  close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.onDisconnect.emit();
  }
}

export interface MockOptions {
  id?: string;
  version?: string;
  userAgent?: string;
  userAgentData?: UserAgentData | null;
  isFirefox?: boolean;
  isIncognitoContext?: boolean;
  allowedIncognito?: boolean;
  acceptLanguages?: string[];
}

/** Does a granted match pattern cover a requested one? Exact match or `https://*` style wildcard. */
function patternCovers(granted: string, wanted: string): boolean {
  if (granted === wanted) return true;
  const m = /^(https|http|\*):\/\/\*\/\*$/.exec(granted);
  if (!m) return false;
  return m[1] === '*' || wanted.startsWith(`${m[1]}://`);
}

interface CatalogueEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

function loadEnglishMessages(): Record<string, CatalogueEntry> {
  const file = join(process.cwd(), '_locales', 'en', 'messages.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CatalogueEntry>;
  } catch {
    return {};
  }
}

export class MockExt {
  readonly id: string;
  readonly local = new MockStorage();
  readonly session = new MockStorage();
  readonly nativePorts: MockNativePort[] = [];
  readonly pagePorts: MockPagePort[] = [];
  readonly notificationsShown: { id: string; spec: NotificationSpec }[] = [];
  readonly permissionRequests: Permissions[] = [];
  readonly cookieQueries: { url: string; storeId?: string | undefined }[] = [];
  readonly alarms = new Map<string, { periodInMinutes: number }>();
  readonly missingMessageKeys = new Set<string>();
  readonly downloadsList = new Map<number, DownloadItem>();
  readonly downloadCalls: { url: string; saveAs?: boolean | undefined }[] = [];
  readonly canceled: number[] = [];
  readonly erased: number[] = [];
  readonly removedFiles: number[] = [];

  /** Cookie jar served by cookies.getAll (domain, path and secure matching are simplified). */
  jar: BrowserCookie[] = [];
  cookieStores: CookieStore[] = [{ id: '0', tabIds: [1] }];
  tabIncognito = new Map<number, boolean>([[1, false]]);
  grantedPermissions = new Set<string>();
  grantedOrigins = new Set<string>();
  /** Decides the outcome of permissions.request (the user clicking Allow or Deny). */
  grantOnRequest: (request: Permissions) => boolean = () => true;
  /** Called for each connectNative(); tests attach a fake daemon here. */
  onConnectNative: ((port: MockNativePort) => void) | null = null;
  /** When set, connectNative returns a port that is already disconnected with this error. */
  connectNativeFailure: string | null = null;
  popupOpensPermissionDialog = true;
  messages = loadEnglishMessages();
  nextDownloadId = 500;

  readonly onMessage = new MockEvent<MessageListener>();
  readonly onConnect = new MockEvent<(port: PagePort) => void>();
  readonly onStartup = new MockEvent<() => void>();
  readonly onInstalled = new MockEvent<() => void>();
  readonly onAlarm = new MockEvent<(alarm: { name: string }) => void>();
  readonly onDownloadChanged = new MockEvent<(delta: DownloadDelta) => void>();
  readonly onDownloadErased = new MockEvent<(id: number) => void>();
  readonly onPermissionsRemoved = new MockEvent<(removed: Permissions) => void>();
  readonly onNotificationClicked = new MockEvent<(id: string) => void>();

  userActive = true;
  readonly api: ExtApi;

  constructor(opts: MockOptions = {}) {
    this.id = opts.id ?? 'nfiaihlklfadnbcfadmhbmddabmafilo';
    const userAgent =
      opts.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    this.api = {
      runtime: {
        id: this.id,
        getURL: (path) => `chrome-extension://${this.id}/${path}`,
        version: () => opts.version ?? '0.1.0',
        connectNative: (host) => {
          if (host !== 'dev.zeus.native_host') throw new Error(`unexpected host ${host}`);
          const port = new MockNativePort();
          this.nativePorts.push(port);
          if (this.connectNativeFailure !== null) {
            const reason = this.connectNativeFailure;
            queueMicrotask(() => {
              port.hostDisconnect(reason);
            });
          } else {
            this.onConnectNative?.(port);
          }
          return port;
        },
        connect: (name) => {
          const port = new MockPagePort(name, {
            id: this.id,
            url: this.api.runtime.getURL('popup/popup.html'),
          });
          this.pagePorts.push(port);
          return port;
        },
        sendMessage: (message) => this.sendFromPage(message),
        openOptionsPage: () => Promise.resolve(),
        onMessage: this.onMessage,
        onConnect: this.onConnect,
        onStartup: this.onStartup,
        onInstalled: this.onInstalled,
      },
      storage: { local: this.local, session: this.session },
      alarms: {
        create: (name, info) => {
          this.alarms.set(name, info);
          return Promise.resolve();
        },
        clear: (name) => Promise.resolve(this.alarms.delete(name)),
        onAlarm: this.onAlarm,
      },
      downloads: {
        search: (query) => {
          let items = [...this.downloadsList.values()];
          if (query.id !== undefined) items = items.filter((i) => i.id === query.id);
          if (query.state !== undefined) items = items.filter((i) => i.state === query.state);
          if (query.orderBy?.[0] === '-startTime')
            items.sort((a, b) => b.startTime.localeCompare(a.startTime));
          return Promise.resolve(
            items.slice(0, query.limit ?? items.length).map((i) => ({ ...i })),
          );
        },
        download: (options) => {
          this.downloadCalls.push(options);
          const id = this.nextDownloadId++;
          this.addDownload({
            id,
            url: options.url,
            finalUrl: options.url,
            state: 'in_progress',
            byExtensionId: this.id,
          });
          this.onDownloadCreatedHook?.(id);
          return Promise.resolve(id);
        },
        cancel: (id) => {
          this.canceled.push(id);
          const item = this.downloadsList.get(id);
          if (item) {
            item.state = 'interrupted';
            item.error = 'USER_CANCELED';
          }
          return Promise.resolve();
        },
        erase: (query) => {
          this.erased.push(query.id);
          this.downloadsList.delete(query.id);
          return Promise.resolve([query.id]);
        },
        removeFile: (id) => {
          this.removedFiles.push(id);
          return Promise.resolve();
        },
        onChanged: this.onDownloadChanged,
        onErased: this.onDownloadErased,
      },
      cookies: {
        getAll: (details) => {
          this.cookieQueries.push({ url: details.url, storeId: details.storeId });
          if (
            !this.hasHostPermission(new URL(details.url).origin) ||
            !this.grantedPermissions.has('cookies')
          ) {
            return Promise.reject(
              new Error(`No host permission for cookies at url: "${details.url}".`),
            );
          }
          const u = new URL(details.url);
          const out = this.jar.filter((c) => {
            if (details.storeId !== undefined && c.storeId !== details.storeId) return false;
            if ((details.partitionKey !== undefined) !== (c.partitionKey !== undefined))
              return false;
            const domain = c.domain.replace(/^\./, '');
            const hostOk = c.hostOnly
              ? u.hostname === domain
              : u.hostname === domain || u.hostname.endsWith(`.${domain}`);
            return (
              hostOk && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === 'https:')
            );
          });
          return Promise.resolve(out.map((c) => ({ ...c })));
        },
        getAllCookieStores: () => Promise.resolve(this.cookieStores.map((s) => ({ ...s }))),
      },
      permissions: {
        contains: (request) => Promise.resolve(this.containsPermissions(request)),
        request: (request) => {
          this.permissionRequests.push(structuredClone(request));
          if (!this.api.env.isUserActive()) {
            return Promise.reject(new Error('This function must be called during a user gesture'));
          }
          const granted = this.grantOnRequest(request);
          if (granted) {
            for (const p of request.permissions ?? []) this.grantedPermissions.add(p);
            for (const o of request.origins ?? []) this.grantedOrigins.add(o);
          }
          return Promise.resolve(granted);
        },
        remove: (request) => {
          for (const p of request.permissions ?? []) this.grantedPermissions.delete(p);
          for (const o of request.origins ?? []) this.grantedOrigins.delete(o);
          this.onPermissionsRemoved.emit(request);
          return Promise.resolve(true);
        },
        onRemoved: this.onPermissionsRemoved,
      },
      notifications: {
        create: (id, spec) => {
          this.notificationsShown.push({ id, spec });
          return Promise.resolve(id);
        },
        clear: () => Promise.resolve(true),
        onClicked: this.onNotificationClicked,
      },
      i18n: {
        getMessage: (key, subs) => {
          const entry = this.messages[key];
          if (!entry) {
            this.missingMessageKeys.add(key);
            return '';
          }
          const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
          // Chrome resolves $NAME$ through the entry's placeholders, whose content is $1..$9
          return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (_m, name: string) => {
            const content = entry.placeholders?.[name.toLowerCase()]?.content ?? '';
            return content.replace(/\$(\d)/g, (_c, n: string) => list[Number(n) - 1] ?? '');
          });
        },
        getAcceptLanguages: () => Promise.resolve(opts.acceptLanguages ?? ['en-US', 'en']),
        getUILanguage: () => 'en-US',
      },
      tabs: {
        get: (tabId) => {
          const incognito = this.tabIncognito.get(tabId);
          return incognito === undefined
            ? Promise.reject(new Error('No tab'))
            : Promise.resolve({ incognito });
        },
      },
      action: {
        setBadgeText: () => Promise.resolve(),
        setBadgeBackgroundColor: () => Promise.resolve(),
        openPopup: () => {
          this.popupOpened += 1;
          return Promise.resolve();
        },
      },
      extension: {
        isAllowedIncognitoAccess: () => Promise.resolve(opts.allowedIncognito ?? false),
      },
      env: {
        userAgent,
        userAgentData:
          opts.userAgentData === undefined
            ? {
                brands: [
                  { brand: 'Chromium', version: '141' },
                  { brand: 'Google Chrome', version: '141' },
                  { brand: 'Not?A_Brand', version: '8' },
                ],
                mobile: false,
                platform: 'Windows',
              }
            : opts.userAgentData,
        isUserActive: () => this.userActive,
        isFirefox: opts.isFirefox ?? false,
        isIncognitoContext: opts.isIncognitoContext ?? false,
      },
    };
  }

  popupOpened = 0;
  onDownloadCreatedHook: ((id: number) => void) | null = null;

  hasHostPermission(origin: string): boolean {
    return [...this.grantedOrigins].some((g) => patternCovers(g, `${origin}/*`));
  }

  private containsPermissions(request: Permissions): boolean {
    for (const p of request.permissions ?? []) if (!this.grantedPermissions.has(p)) return false;
    for (const o of request.origins ?? []) {
      if (![...this.grantedOrigins].some((g) => patternCovers(g, o))) return false;
    }
    return true;
  }

  /** Simulate the user granting the optional permissions for an origin. */
  grant(origin: string, withCookies = true): void {
    this.grantedOrigins.add(`${origin}/*`);
    if (withCookies) this.grantedPermissions.add('cookies');
  }

  /** Add a browser download item with sensible defaults and return it. */
  addDownload(partial: Partial<DownloadItem> & { id: number }): DownloadItem {
    const item: DownloadItem = {
      url: 'https://portal.example.org/download/8841',
      finalUrl:
        'https://cdn.example.org/blobs/dataset-v3.tar.zst?X-Amz-Expires=300&X-Amz-Signature=EXAMPLE',
      referrer: 'https://portal.example.org/datasets/v3',
      filename: 'C:\\Users\\ada\\Downloads\\dataset-v3.tar.zst',
      incognito: false,
      danger: 'safe',
      mime: 'application/zstd',
      startTime: '2026-10-05T09:15:12.004Z',
      state: 'in_progress',
      paused: false,
      canResume: false,
      bytesReceived: 402_653_184,
      totalBytes: 1_288_490_188,
      fileSize: 0,
      exists: false,
      ...partial,
    };
    this.downloadsList.set(item.id, item);
    return item;
  }

  /** Interrupt a download the way Chrome reports it: one onChanged with state and error. */
  interrupt(id: number, error: string): void {
    const item = this.downloadsList.get(id);
    if (!item) throw new Error(`no download ${id}`);
    const previous = item.state;
    item.state = 'interrupted';
    item.error = error;
    this.onDownloadChanged.emit({
      id,
      state: { previous, current: 'interrupted' },
      error: { current: error },
    });
  }

  /** Send a message as if from one of the extension's own pages (or a foreign sender). */
  sendFromPage(message: unknown, sender?: MessageSender): Promise<unknown> {
    const from: MessageSender = sender ?? {
      id: this.id,
      url: this.api.runtime.getURL('popup/popup.html'),
    };
    return new Promise((resolve) => {
      const state = { answered: false };
      const respond = (response?: unknown): void => {
        state.answered = true;
        resolve(response);
      };
      let async = false;
      for (const l of this.onMessage.listeners) {
        if (l(structuredClone(message), from, respond) === true) async = true;
      }
      if (!async && !state.answered) resolve(undefined);
    });
  }

  lastNativePort(): MockNativePort {
    const port = this.nativePorts.at(-1);
    if (!port) throw new Error('extension never called connectNative');
    return port;
  }

  /** Frames the extension posted on the latest native port, filtered by type. */
  postedFrames(
    type?: string,
    port: MockNativePort = this.lastNativePort(),
  ): Record<string, unknown>[] {
    const all = port.posted as Record<string, unknown>[];
    return type === undefined ? all : all.filter((f) => f.type === type);
  }
}
