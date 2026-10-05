// Identifiers that the extension itself creates (spec 00 section 5): message ids, the per-profile
// id and the per-worker-instance id. Entity ids (job_, gr_, ...) are minted only by the daemon.

/** Source of random bytes; injected so tests are deterministic. */
export type Rng = (length: number) => Uint8Array;

export const cryptoRng: Rng = (length) => crypto.getRandomValues(new Uint8Array(length));

export function randomHex(rng: Rng, bytes: number): string {
  return Array.from(rng(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `profile_id`: 32 lowercase hex characters, created once per browser profile. */
export const newProfileId = (rng: Rng): string => randomHex(rng, 16);

/** `sw_instance_id`: 16 hex characters, new for every worker start. */
export const newInstanceId = (rng: Rng): string => randomHex(rng, 8);

/** Message ids `e1`, `e2`, ... unique per connection (spec 00 section 5.3). */
export class MessageIds {
  private n = 0;
  next(): string {
    this.n += 1;
    return `e${this.n}`;
  }
}

/** Short random id for streams-of-our-own, notifications and the like. */
export function shortId(rng: Rng): string {
  return randomHex(rng, 6);
}
