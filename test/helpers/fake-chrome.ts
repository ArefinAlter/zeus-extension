// A minimal fake of the `chrome` / `browser` namespace: just enough surface for the real adapter
// (src/lib/platform.ts) to be built on it, with spies so tests can see what was called.
import { vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

export class FakeEvent {
  readonly listeners: Listener[] = [];
  addListener(cb: Listener): void {
    this.listeners.push(cb);
  }
  emit(...args: unknown[]): unknown[] {
    return this.listeners.map((l) => l(...args));
  }
}

export function fakeNamespace(overrides: Record<string, unknown> = {}) {
  const port = {
    name: 'p',
    sender: {
      id: 'ext',
      url: 'chrome-extension://ext/popup/popup.html',
      tab: { id: 4 },
      frameId: 0,
    },
    onMessage: new FakeEvent(),
    onDisconnect: new FakeEvent(),
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  const runtime = {
    id: 'ext',
    lastError: undefined as { message: string } | undefined,
    getURL: (p: string) => `chrome-extension://ext/${p}`,
    getManifest: () => ({ version: '0.1.0' }),
    connectNative: vi.fn(() => port),
    connect: vi.fn(() => port),
    sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
    openOptionsPage: vi.fn(() => Promise.resolve()),
    onMessage: new FakeEvent(),
    onConnect: new FakeEvent(),
    onStartup: new FakeEvent(),
    onInstalled: new FakeEvent(),
  };
  const area = () => ({
    get: vi.fn((keys: unknown): Promise<Record<string, unknown>> =>
      Promise.resolve({ requested: keys }),
    ),
    set: vi.fn((_items: Record<string, unknown>) => Promise.resolve()),
    remove: vi.fn((_keys: unknown) => Promise.resolve()),
  });
  const ns = {
    runtime,
    storage: { local: area(), session: area() },
    alarms: {
      create: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve(true)),
      onAlarm: new FakeEvent(),
    },
    downloads: {
      search: vi.fn(() => Promise.resolve([])),
      download: vi.fn(() => Promise.resolve(1)),
      cancel: vi.fn(() => Promise.resolve()),
      erase: vi.fn(() => Promise.resolve([])),
      removeFile: vi.fn(() => Promise.resolve()),
      onChanged: new FakeEvent(),
      onErased: new FakeEvent(),
    },
    cookies: {
      getAll: vi.fn(() => Promise.resolve([])),
      getAllCookieStores: vi.fn(() => Promise.resolve([])),
    },
    permissions: {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve(true)),
      onRemoved: new FakeEvent(),
    },
    notifications: {
      create: vi.fn((id: string) => Promise.resolve(id)),
      clear: vi.fn(() => Promise.resolve(true)),
      onClicked: new FakeEvent(),
    },
    i18n: {
      getMessage: vi.fn(() => 'x'),
      getAcceptLanguages: vi.fn(() => Promise.resolve(['en'])),
      getUILanguage: vi.fn(() => 'en'),
    },
    tabs: { get: vi.fn(() => Promise.resolve({ incognito: false })) },
    action: {
      setBadgeText: vi.fn(() => Promise.resolve()),
      setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
      openPopup: vi.fn(() => Promise.resolve()),
    },
    extension: { isAllowedIncognitoAccess: vi.fn(() => Promise.resolve(true)) },
    ...overrides,
  };
  return { ns, port, runtime };
}
