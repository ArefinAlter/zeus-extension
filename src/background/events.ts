// Event stream handling (spec 02 section 11, 01 section 9). Events are de-duplicated by `seq`, the
// highest processed `seq` is persisted as `last_event_seq` so a reconnect resumes where it
// stopped, and each event type this extension cares about updates local state: approvals, consent
// records, the job mirror and notifications. Unknown or malformed events are skipped, never fatal.
import type { Env } from '../lib/env';
import {
  classifyEvent,
  type DaemonMessageOf,
  type DomainEvent,
  type EventBase,
} from '../lib/protocol';
import type { ApprovalCenter } from './approvals';
import type { JobBook } from './jobs';
import { TERMINAL_STATES } from './jobs';
import type { Notifier } from './notify';
import type { StateStore } from './state';

export interface EventHooks {
  changed(): void;
}

const SEQ_FLUSH_MS = 1000;

export class EventProcessor {
  private lastSeq = 0;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Job ids that came from a handoff of this extension's offers: only these produce notifications. */
  private ownJobs: (id: string) => Promise<boolean> = () => Promise.resolve(false);

  constructor(
    private readonly env: Env,
    private readonly store: StateStore,
    private readonly approvals: ApprovalCenter,
    private readonly jobs: JobBook,
    private readonly notifier: Notifier,
    private readonly hooks: EventHooks,
  ) {}

  /** Tell the processor how to recognise jobs started from this browser. */
  setOwnJobPredicate(fn: (jobId: string) => Promise<boolean>): void {
    this.ownJobs = fn;
  }

  async init(): Promise<void> {
    this.lastSeq = (await this.store.getLastEventSeq()) ?? 0;
  }

  get cursor(): number {
    return this.lastSeq;
  }

  /** Handle one `job.event` frame. */
  async handle(message: DaemonMessageOf<'job.event'>): Promise<void> {
    const raw: EventBase = message.body.event;
    const classified = classifyEvent(raw);
    const seq = raw.seq;
    if (seq !== undefined) {
      if (seq <= this.lastSeq) return; // replay overlap: de-duplicate by seq
      this.lastSeq = seq;
      this.markDirty();
    }
    if (!classified.known) {
      this.env.log.debug('event skipped', { type: classified.type, reason: classified.reason });
      return;
    }
    await this.dispatch(classified.event);
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    this.jobs.apply(event);
    switch (event.type) {
      case 'approval.requested':
        await this.approvals.onPending(event.data.approval);
        break;
      case 'approval.decided':
        this.approvals.onDecided(event.data.approval_id);
        break;
      case 'grant.created':
        await this.approvals.onGrantCreated(event.data.grant);
        break;
      case 'grant.revoked':
        await this.approvals.onGrantEnded(event.data.grant_id, event.data.origin);
        break;
      case 'grant.expired':
        await this.approvals.onGrantEnded(event.data.grant_id, event.data.origin);
        break;
      case 'job.created':
        if (event.job_id !== undefined && event.data.source.run_id !== undefined) {
          await this.store.rememberJobRun(event.job_id, event.data.source.run_id);
        }
        break;
      case 'job.state_changed':
        if (event.job_id !== undefined && TERMINAL_STATES.has(event.data.to))
          await this.endJob(event.job_id);
        break;
      case 'job.completed':
        if (event.job_id !== undefined) {
          await this.endJob(event.job_id);
          if (await this.ownJobs(event.job_id)) {
            await this.notifier.jobCompleted(
              event.job_id,
              this.jobs.get(event.job_id)?.filename ?? null,
              event.data.sha256,
            );
          }
        }
        break;
      case 'job.failed':
        if (event.job_id !== undefined) {
          await this.endJob(event.job_id);
          if (await this.ownJobs(event.job_id)) {
            await this.notifier.jobFailed(
              event.job_id,
              this.jobs.get(event.job_id)?.filename ?? null,
              event.data.error,
            );
          }
        }
        break;
      default:
        break;
    }
    this.hooks.changed();
  }

  /** A job reached a terminal state: a `once` consent record dies with it (spec 02 section 10.2). */
  private async endJob(jobId: string): Promise<void> {
    await this.store.removeConsent((r) => r.scope === 'once' && r.job_id === jobId);
  }

  // ---------- cursor persistence ----------

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, SEQ_FLUSH_MS);
  }

  /** Persist the cursor now (also called before the worker may be suspended). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await this.store.setLastEventSeq(this.lastSeq);
  }
}
