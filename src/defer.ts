import type { TaskLifecycleEvent } from "./bob-ipc.js";

// A started chat we've heard nothing terminal about for this long is treated as
// dead and evicted (see evictStale). Only lifecycle events reach us (bob-ipc
// filters out mid-task chatter), so this is the *only* signal a long but
// genuinely-active chat gives — set it well above a normal task's runtime or a
// live chat could be evicted and dispatched over. Tunable via --defer-stale.
const DEFAULT_STALE_MS = 5 * 60_000;

/**
 * Tracks external (non-worker) Bob chat activity so the worker can defer dispatch
 * while the user is mid-conversation. Clock is injectable for testing.
 */
export class ExternalActivity {
  // taskId -> clock time we last saw it referenced. A Map (not a Set) so a
  // start that never gets its terminal event can age out instead of wedging us.
  private active = new Map<string, number>();
  private lastActivity = 0;
  private everSeen = false;

  constructor(
    private now: () => number = () => Date.now(),
    private staleMs: number = DEFAULT_STALE_MS,
  ) {}

  handle(ev: TaskLifecycleEvent): void {
    if (ev.isOwn) return; // our own dispatch isn't a user chatting
    if (/taskCreated|taskStarted/i.test(ev.name)) {
      this.active.set(ev.taskId, this.now());
      this.lastActivity = this.now();
      this.everSeen = true;
    } else if (/taskCompleted|taskAborted/i.test(ev.name)) {
      this.active.delete(ev.taskId);
      this.lastActivity = this.now();
      this.everSeen = true;
    }
  }

  /** True if a chat is running now, or finished within the idle window. */
  shouldDefer(idleMs: number): boolean {
    this.evictStale();
    if (this.active.size > 0) return true;
    if (!this.everSeen) return false;
    return this.now() - this.lastActivity < idleMs;
  }

  /**
   * Drop active entries with no terminal event for staleMs. Bob normally pairs
   * taskStarted with taskCompleted/taskAborted, but a cancelled sub-task (or an
   * event missed across a reconnect) can leave a start without its end. Without
   * this, that lone start keeps `active` non-empty forever and the worker defers
   * permanently — the idle window below is only reached once `active` is empty.
   * Eviction lets a long-lived worker self-heal instead of staying wedged.
   */
  private evictStale(): void {
    if (this.active.size === 0) return;
    const cutoff = this.now() - this.staleMs;
    for (const [taskId, seen] of this.active) {
      if (seen <= cutoff) this.active.delete(taskId);
    }
  }
}
