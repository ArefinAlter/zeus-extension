// Smoke test of the real entry point as it ships: bundle src/background/index.ts exactly like the
// build does (IIFE, define constants), run it in an isolated VM context that has only a fake
// `chrome` global, and check that it registers every listener synchronously, opens the native port
// and sends a schema-valid hello. This catches bundling and global-scope mistakes that module-level
// tests cannot (a missing global, a top-level throw, a listener registered too late).
import { build } from 'esbuild';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { fakeNamespace } from '../helpers/fake-chrome';
import { ajvValid } from '../helpers/ajv';
import { fullRef } from '../helpers/examples';

async function bundleBackground(): Promise<string> {
  const result = await build({
    entryPoints: [join(process.cwd(), 'src/background/index.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'silent',
    define: { __ZEUS_DEV__: 'true', __ZEUS_TARGET__: '"chrome"' },
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('esbuild produced no output');
  return file.text;
}

function sandbox(chromeNs: unknown): vm.Context {
  const context: Record<string, unknown> = {
    chrome: chromeNs,
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      userAgentData: {
        brands: [{ brand: 'Google Chrome', version: '141' }],
        mobile: false,
        platform: 'Windows',
      },
    },
    crypto: globalThis.crypto,
    fetch: () => Promise.reject(new TypeError('no network in the smoke test')),
    performance: globalThis.performance,
    console: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    Headers,
    Response,
    ReadableStream,
    structuredClone,
  };
  context.globalThis = context;
  return vm.createContext(context);
}

describe('the shipped background bundle', () => {
  it('starts in a bare context, registers its listeners and says hello over the native port', async () => {
    const code = await bundleBackground();
    const { ns, port, runtime } = fakeNamespace();
    // storage that behaves like storage (the stub returns what it was asked for)
    const stores = { local: new Map<string, unknown>(), session: new Map<string, unknown>() };
    for (const kind of ['local', 'session'] as const) {
      const area = ns.storage[kind];
      area.get.mockImplementation((keys: unknown) => {
        const names = Array.isArray(keys) ? keys : [keys];
        return Promise.resolve(
          Object.fromEntries(
            (names as string[])
              .filter((k) => stores[kind].has(k))
              .map((k) => [k, stores[kind].get(k)]),
          ),
        );
      });
      area.set.mockImplementation((items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) stores[kind].set(k, v);
        return Promise.resolve();
      });
    }

    vm.runInContext(code, sandbox(ns), { filename: 'background/index.js' });

    // everything is registered during the first turn (Manifest V3 requires it)
    expect(runtime.onMessage.listeners).toHaveLength(1);
    expect(runtime.onConnect.listeners).toHaveLength(1);
    expect(runtime.onStartup.listeners).toHaveLength(1);
    expect(runtime.onInstalled.listeners).toHaveLength(1);
    expect(ns.alarms.onAlarm.listeners).toHaveLength(1);
    expect(ns.downloads.onChanged.listeners).toHaveLength(1);
    expect(ns.downloads.onErased.listeners).toHaveLength(1);
    expect(ns.notifications.onClicked.listeners).toHaveLength(1);
    expect(ns.permissions.onRemoved.listeners).toHaveLength(1);
    expect(runtime.connectNative).toHaveBeenCalledWith('dev.zeus.native_host');

    // the handshake frame is produced asynchronously (it reads storage); let it run
    for (let i = 0; i < 20 && port.postMessage.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const hello = port.postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(hello).toBeDefined();
    expect(hello.type).toBe('hello');
    expect(ajvValid(fullRef('native-messaging.v1#/$defs/ExtensionToDaemonMessage'), hello)).toBe(
      true,
    );
    expect((hello.body as { browser: { name: string } }).browser.name).toBe('chrome');
  });

  it('contains no dynamic code evaluation and no remote resource references', async () => {
    const code = await bundleBackground();
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(code).not.toMatch(/importScripts/);
  });
});
