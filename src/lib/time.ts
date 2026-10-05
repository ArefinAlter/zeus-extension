// Time helpers (spec 00 section 6): wire instants are RFC 3339 UTC with exactly three fractional
// digits; durations are integer milliseconds; elapsed time uses the monotonic clock.

export interface Clock {
  /** Wall clock, milliseconds since the Unix epoch. For display and stored deadlines only. */
  now(): number;
  /** Monotonic milliseconds for measuring elapsed time. */
  mono(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
};

/** Normalise a date-like value to the wire form, or null when it is not a valid year 0000-9999 date. */
export function toWireTimestamp(value: number | string | Date): string | null {
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (Number.isNaN(ms) || ms < 0 || ms > 253402300799999) return null;
  return d.toISOString();
}

/** Epoch milliseconds of a wire timestamp, or null when it does not parse. */
export function parseWireTimestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
