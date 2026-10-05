// A complete simulated world for integration tests: the mock browser, a fake daemon behind the
// native port, a scripted fetch and the real background wired together on a controllable clock.
import { vi } from 'vitest';
import { createBackground, type Background } from '../../src/background/app';
import type { LinkTiming } from '../../src/background/native';
import type { Env } from '../../src/lib/env';
import { createLogger, type LogLevel } from '../../src/lib/log';
import type { Clock } from '../../src/lib/time';
import { FakeDaemon, type DaemonOptions } from './fake-daemon';
import { FakeFetch } from './fake-fetch';
import { MockExt, type MockOptions } from './mock-ext';

export interface WorldOptions {
  ext?: MockOptions;
  daemon?: DaemonOptions;
  timing?: Partial<LinkTiming>;
  /** Do not attach a fake daemon (connectNative will get a port nobody answers). */
  noDaemon?: boolean;
  /** Seed of the deterministic random source; use different seeds for "another worker start". */
  seed?: number;
}

/** Wall and monotonic time that move only when the test advances them, together with fake timers. */
export class TestClock implements Clock {
  private wall = Date.parse('2026-10-05T09:15:00.000Z');
  private monotonic = 1_000;
  now(): number {
    return this.wall;
  }
  mono(): number {
    return this.monotonic;
  }
  tick(ms: number): void {
    this.wall += ms;
    this.monotonic += ms;
  }
}

export class World {
  readonly ext: MockExt;
  readonly fetcher = new FakeFetch();
  readonly clock = new TestClock();
  readonly daemons: FakeDaemon[] = [];
  readonly logLines: string[] = [];
  readonly env: Env;
  readonly bg: Background;
  private seed: number;

  constructor(readonly opts: WorldOptions = {}) {
    this.seed = opts.seed ?? 1;
    this.ext = new MockExt(opts.ext);
    if (!opts.noDaemon) {
      this.ext.onConnectNative = (port) => {
        this.daemons.push(new FakeDaemon(port, opts.daemon));
      };
    }
    this.env = {
      api: this.ext.api,
      clock: this.clock,
      rng: (n) =>
        Uint8Array.from({ length: n }, () => (this.seed = (this.seed * 48271) % 2147483647) & 255),
      fetch: this.fetcher.fetch,
      log: createLogger((_level: LogLevel, line: string) => this.logLines.push(line), 'debug'),
    };
    this.bg = createBackground(this.env, opts.timing ? { timing: opts.timing } : {});
  }

  /** Start the background and let the handshake and start-up work finish. */
  async boot(): Promise<this> {
    this.bg.start();
    await this.settle();
    return this;
  }

  get daemon(): FakeDaemon {
    const d = this.daemons.at(-1);
    if (!d) throw new Error('no daemon attached yet');
    return d;
  }

  /** Advance the clock and all timers, flushing promise queues on the way. */
  async advance(ms: number): Promise<void> {
    // In small steps, so code that polls the wall or monotonic clock between timers sees time pass.
    const step = ms <= 5_000 ? 50 : 250;
    for (let left = ms; left > 0; left -= step) {
      const slice = Math.min(step, left);
      this.clock.tick(slice);
      await vi.advanceTimersByTimeAsync(slice);
    }
  }

  /** Let pending promise chains finish without moving time much. */
  async settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(60);
    this.clock.tick(60 * rounds);
  }

  /** i18n keys the code asked for that no catalogue entry exists for. */
  missingKeys(): string[] {
    return [...this.ext.missingMessageKeys];
  }

  /** Everything that was logged, joined: for "no secret in logs" assertions. */
  logs(): string {
    return this.logLines.join('\n');
  }
}
