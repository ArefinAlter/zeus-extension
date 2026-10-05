// A memory-only mirror of the daemon's jobs, built from `job.list` and events, for the popup
// (spec 02 section 12: the daemon is authoritative; the extension mirrors for display).
import type { DomainEvent, JobSummary } from '../lib/protocol';

const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'queued',
  'probing',
  'awaiting_approval',
  'awaiting_session',
  'downloading',
  'paused',
  'retry_scheduled',
  'verifying',
  'finalizing',
]);

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'canceled', 'failed']);

const MAX_JOBS = 100;

export class JobBook {
  private readonly jobs = new Map<string, JobSummary>();

  replace(list: readonly JobSummary[]): void {
    this.jobs.clear();
    for (const j of list) this.jobs.set(j.id, j);
    this.trim();
  }

  upsert(job: JobSummary): void {
    this.jobs.set(job.id, job);
    this.trim();
  }

  get(id: string): JobSummary | undefined {
    return this.jobs.get(id);
  }

  /** Newest first. */
  list(limit = 30): JobSummary[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  /** True when some job is still running; `filter` narrows which jobs count. */
  hasActive(filter: (job: JobSummary) => boolean = () => true): boolean {
    return [...this.jobs.values()].some((j) => ACTIVE_STATES.has(j.state) && filter(j));
  }

  /** Apply one durable or ephemeral event. Unknown jobs are created only by job.created. */
  apply(event: DomainEvent): void {
    const id = event.job_id;
    if (id === undefined) return;
    const existing = this.jobs.get(id);
    switch (event.type) {
      case 'job.created': {
        if (existing) return;
        const d = event.data;
        this.jobs.set(id, {
          id,
          state: d.state,
          quarantined: false,
          source_kind: d.source.kind,
          filename: d.filename_hint ?? null,
          url_redacted: d.url_redacted,
          origin: d.origin ?? null,
          bytes_done: 0,
          bytes_total: null,
          last_error: null,
          created_at: event.ts,
          updated_at: event.ts,
        });
        this.trim();
        return;
      }
      case 'job.state_changed':
        if (existing)
          this.jobs.set(id, { ...existing, state: event.data.to, updated_at: event.ts });
        return;
      case 'job.progress':
        if (existing) {
          const p = event.data.progress;
          this.jobs.set(id, {
            ...existing,
            bytes_done: p.bytes_done,
            bytes_total: p.bytes_total,
            updated_at: event.ts,
          });
        }
        return;
      case 'job.completed':
        if (existing) {
          this.jobs.set(id, {
            ...existing,
            state: 'completed',
            quarantined: event.data.quarantined,
            bytes_done: event.data.size_bytes,
            bytes_total: event.data.size_bytes,
            updated_at: event.ts,
          });
        }
        return;
      case 'job.failed':
        if (existing)
          this.jobs.set(id, {
            ...existing,
            state: 'failed',
            last_error: event.data.error,
            updated_at: event.ts,
          });
        return;
      case 'job.retry_scheduled':
        if (existing)
          this.jobs.set(id, { ...existing, last_error: event.data.error, updated_at: event.ts });
        return;
      default:
        return;
    }
  }

  private trim(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    const keep = this.list(MAX_JOBS);
    this.jobs.clear();
    for (const j of keep) this.jobs.set(j.id, j);
  }
}
