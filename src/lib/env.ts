// Everything a background module needs from the outside world, injected so it can be tested.
import type { Logger } from './log';
import type { ExtApi } from './platform';
import type { Rng } from './ids';
import type { Clock } from './time';

export interface Env {
  api: ExtApi;
  clock: Clock;
  rng: Rng;
  /** The fetch used for in-browser requests (credentialed, extension origin). */
  fetch: typeof fetch;
  log: Logger;
}
