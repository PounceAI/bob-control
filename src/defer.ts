import type { TaskLifecycleEvent } from "./bob-ipc.js";

/**
 * Tracks external (non-worker) Bob chat activity so the worker can defer dispatch
 * while the user is mid-conversation. Clock is injectable for testing.
 */
export class ExternalActivity {
  private active = new Set<string>();
  private lastActivity = 0;
  private everSeen = false;

  constructor(private now: () => number = () => Date.now()) {}

  handle(ev: TaskLifecycleEvent): void {
    if (ev.isOwn) return; // our own dispatch isn't a user chatting
    if (/taskCreated|taskStarted/i.test(ev.name)) {
      this.active.add(ev.taskId);
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
    if (this.active.size > 0) return true;
    if (!this.everSeen) return false;
    return this.now() - this.lastActivity < idleMs;
  }
}
