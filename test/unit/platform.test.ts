// The real adapter (src/lib/platform.ts) is the only code that touches the browser globals. These
// tests run it against a minimal fake `chrome` / `browser` to pin the assumptions it makes about the
// WebExtension APIs: how disconnect reasons are read in each browser, how message senders are
// mapped, which namespace is preferred and that optional APIs may be absent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtApi } from '../../src/lib/platform';
import { fakeNamespace } from '../helpers/fake-chrome';

function install(
  globals: Record<string, unknown>,
  navigatorOverride?: Record<string, unknown>,
): void {
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36',
    ...navigatorOverride,
  });
  for (const [k, v] of Object.entries(globals)) vi.stubGlobal(k, v);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createExtApi', () => {
  it('fails clearly outside an extension context', () => {
    install({ chrome: undefined, browser: undefined });
    expect(() => createExtApi()).toThrow(/no extension API/);
  });

  it('prefers the promise-based browser namespace and falls back to chrome', () => {
    const a = fakeNamespace();
    const b = fakeNamespace();
    b.runtime.id = 'from-browser';
    install({ chrome: a.ns, browser: b.ns });
    expect(createExtApi().runtime.id).toBe('from-browser');
    install({ chrome: a.ns, browser: undefined });
    expect(createExtApi().runtime.id).toBe('ext');
  });

  it('reads the disconnect reason from runtime.lastError (Chrome) or port.error (Firefox)', () => {
    const { ns, port, runtime } = fakeNamespace();
    install({ chrome: ns });
    const api = createExtApi();
    const reasons: (string | undefined)[] = [];
    const native = api.runtime.connectNative('dev.zeus.native_host');
    native.onDisconnect.addListener((r) => reasons.push(r));
    runtime.lastError = { message: 'Specified native messaging host not found.' };
    port.onDisconnect.emit(port);
    runtime.lastError = undefined;
    port.onDisconnect.emit({
      ...port,
      error: { message: 'No such native application dev.zeus.native_host' },
    });
    port.onDisconnect.emit(port);
    expect(reasons).toEqual([
      'Specified native messaging host not found.',
      'No such native application dev.zeus.native_host',
      undefined,
    ]);
    expect(runtime.connectNative).toHaveBeenCalledWith('dev.zeus.native_host');
  });

  it('relays native frames and posts messages as given', () => {
    const { ns, port } = fakeNamespace();
    install({ chrome: ns });
    const native = createExtApi().runtime.connectNative('dev.zeus.native_host');
    const seen: unknown[] = [];
    native.onMessage.addListener((m) => seen.push(m));
    port.onMessage.emit({ v: 1, id: 'd1', type: 'ping', body: {} });
    native.postMessage({ v: 1, id: 'e1', type: 'pong', re: 'd1', body: {} });
    expect(seen).toEqual([{ v: 1, id: 'd1', type: 'ping', body: {} }]);
    expect(port.postMessage).toHaveBeenCalledWith({
      v: 1,
      id: 'e1',
      type: 'pong',
      re: 'd1',
      body: {},
    });
  });

  it('maps message senders and keeps the channel open only when the listener says so', () => {
    const { ns, runtime } = fakeNamespace();
    install({ chrome: ns });
    const api = createExtApi();
    const received: unknown[] = [];
    api.runtime.onMessage.addListener((message, sender) => {
      received.push([message, sender]);
      return message === 'async';
    });
    const sender = {
      id: 'ext',
      url: 'chrome-extension://ext/popup/popup.html',
      tab: { id: 4 },
      frameId: 2,
    };
    const results = runtime.onMessage.emit('async', sender, () => undefined);
    expect(results).toEqual([true]);
    expect(runtime.onMessage.emit('sync', sender, () => undefined)).toEqual([false]);
    expect(received[0]).toEqual([
      'async',
      { id: 'ext', url: 'chrome-extension://ext/popup/popup.html', tabId: 4, frameId: 2 },
    ]);
  });

  it('wraps page ports and refuses nothing it is not told to', () => {
    const { ns, port, runtime } = fakeNamespace();
    install({ chrome: ns });
    const api = createExtApi();
    const accepted: string[] = [];
    api.runtime.onConnect.addListener((p) =>
      accepted.push(`${p.name}:${p.sender.id}:${p.sender.tabId}`),
    );
    runtime.onConnect.emit(port);
    expect(accepted).toEqual(['p:ext:4']);
    const page = api.runtime.connect('zeus-popup');
    expect(runtime.connect).toHaveBeenCalledWith({ name: 'zeus-popup' });
    page.postMessage({ type: 'x' });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'x' });
  });

  it('passes storage, alarms and permissions straight through with the shapes the code relies on', async () => {
    const { ns } = fakeNamespace();
    install({ chrome: ns });
    const api = createExtApi();
    expect(await api.storage.local.get('k')).toEqual({ requested: 'k' });
    await api.storage.session.set({ a: 1 });
    expect(ns.storage.session.set).toHaveBeenCalledWith({ a: 1 });
    await api.alarms.create('zeus-reconnect', { periodInMinutes: 0.5 });
    expect(ns.alarms.create).toHaveBeenCalledWith('zeus-reconnect', { periodInMinutes: 0.5 });
    expect(
      await api.permissions.request({ permissions: ['cookies'], origins: ['https://a.example/*'] }),
    ).toBe(true);
    expect(ns.permissions.request).toHaveBeenCalledWith({
      permissions: ['cookies'],
      origins: ['https://a.example/*'],
    });
    expect(await api.extension.isAllowedIncognitoAccess()).toBe(true);
  });

  it('detects Firefox, the user gesture flag and the absence of userAgentData and openPopup', () => {
    const { ns } = fakeNamespace();
    const noPopup = {
      ...ns,
      action: {
        setBadgeText: ns.action.setBadgeText,
        setBadgeBackgroundColor: ns.action.setBadgeBackgroundColor,
      },
    };
    install(
      { browser: noPopup },
      {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
        userActivation: { isActive: true },
      },
    );
    const api = createExtApi();
    expect(api.env.isFirefox).toBe(true);
    expect(api.env.userAgentData).toBeNull();
    expect(api.env.isUserActive()).toBe(true);
    expect(api.action.openPopup).toBeUndefined();
    install(
      { chrome: ns, browser: undefined },
      {
        userActivation: { isActive: false },
        userAgentData: { brands: [], mobile: false, platform: 'Windows' },
      },
    );
    const chrome = createExtApi();
    expect(chrome.env.isFirefox).toBe(false);
    expect(chrome.env.isUserActive()).toBe(false);
    expect(chrome.action.openPopup).toBeTypeOf('function');
    install({ chrome: ns, browser: undefined }, {});
    expect(createExtApi().env.isUserActive()).toBe(false); // no userActivation at all: never claim a gesture
  });
});
