// Well-formed prefixed ULIDs for tests (Crockford base32, first character 0-7).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(n: number): string {
  const a = ALPHABET[Math.floor(n / 32) % 32] ?? '0';
  const b = ALPHABET[n % 32] ?? '0';
  return `01M45NHJ2AHWMXT8JVJ7BEEJ${a}${b}`;
}

export const jobId = (n = 1): string => `job_${ulid(n)}`;
export const runId = (n = 1): string => `run_${ulid(n)}`;
export const grantId = (n = 1): string => `gr_${ulid(n)}`;
export const approvalId = (n = 1): string => `ap_${ulid(n)}`;
export const sessionId = (n = 1): string => `sess_${ulid(n)}`;
export const connectionId = (n = 1): string => `conn_${ulid(n)}`;
