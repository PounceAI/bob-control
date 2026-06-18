// The worker surfaces exactly one "between-dispatch" status at a time. Tracking each with its own
// boolean (idled / deferring / disarmed) let them drift: a resume from defer cleared `deferring`
// but not `idled`, so the loop never re-announced idle and the extension's status line stuck on
// "running". A single current-status latch can't desync that way — returning to a status after a
// different one always re-announces it. Extracted from worker.ts so the loop's status transitions
// are unit-testable against the real implementation rather than a copy.

/**
 * The mutually-exclusive status the worker shows while polling between dispatches. "active" means a
 * task is being dispatched (the loop emits taskStart itself); the other three each map to a one-shot
 * status event the loop emits on entry.
 */
export type PollStatus = "disarmed" | "deferred" | "idle" | "active";

/** One-at-a-time latch: announce a status once per entry, re-announce when returning to it. */
export class PollStatusLatch {
  private current: PollStatus | null = null;

  /** Set `status` as current; returns true only when it changed — i.e. announce it now. */
  enter(status: PollStatus): boolean {
    if (this.current === status) return false;
    this.current = status;
    return true;
  }

  /** Whether the last-entered status is `status` (drives one-shot "leaving" transitions). */
  is(status: PollStatus): boolean {
    return this.current === status;
  }
}
