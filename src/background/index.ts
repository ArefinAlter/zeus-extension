// Background entry point (Chrome service worker, Firefox event page). Listeners must be registered
// synchronously at the top level, so everything happens in `start()` during the first turn.
import { cryptoRng } from '../lib/ids';
import { consoleSink, createLogger } from '../lib/log';
import { createExtApi } from '../lib/platform';
import { systemClock } from '../lib/time';
import { createBackground } from './app';

const api = createExtApi();
createBackground({
  api,
  clock: systemClock,
  rng: cryptoRng,
  // Bound: calling fetch as a method of another object throws "Illegal invocation".
  fetch: globalThis.fetch.bind(globalThis),
  log: createLogger(consoleSink, __ZEUS_DEV__ ? 'debug' : 'info'),
}).start();
