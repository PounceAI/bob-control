/**
 * Binds a dispatch to its Bob task id from the IPC lifecycle stream, ignoring foreign (chat)
 * tasks. StartNewTask is fire-and-forget (the Ack carries no task id), so we infer "our" task
 * from the events that follow. Binding to the first taskCreated/taskStarted is wrong when a Bob
 * chat is open: the chat is another live task on the same pipe and can win the race, after which
 * our task's taskCompleted never matches and the dispatch hangs to the timeout.
 *
 * Fix: track foreign (non-ours) ids continuously and refuse to bind to one, so a chat already
 * open is known-foreign and skipped while our fresh id binds. Residual: a chat created in the
 * window between our send and our own taskCreated has no id to distinguish it — the idle
 * watchdog recovers that far sooner than the flat timeout.
 */

// Hard cap on tracked foreign ids: a missed terminal (e.g. across a reconnect) would otherwise
// leak an entry forever. Far above any real concurrent-chat count; entries are inert, so
// evicting the oldest on overflow is safe.
const MAX_FOREIGN = 256;

export class TaskBinder {
  // Live task ids that are not the current dispatch's task. Bounded by MAX_FOREIGN: terminal
  // events delete entries, and overflow evicts the oldest, so it can't grow without bound.
  private foreign = new Set<string>();
  private our: string | null = null;
  private armed = false;

  /** Begin binding a new dispatch. Foreign set persists — open chats stay known. */
  arm(): void {
    this.our = null;
    this.armed = true;
  }

  /** End the dispatch so later foreign events aren't mistaken for ours. */
  disarm(): void {
    this.armed = false;
  }

  /** Feed one lifecycle event (taskCreated/taskStarted/taskCompleted/taskAborted). */
  observe(name: string, taskId: string | undefined): void {
    if (!taskId) return;
    const created = /taskCreated|taskStarted/i.test(name);
    const ended = /taskCompleted|taskAborted/i.test(name);
    // Bind the first create/start of an armed dispatch that isn't an already-known chat.
    if (this.armed && this.our === null && created && !this.foreign.has(taskId)) {
      this.our = taskId;
    }
    // Everything that isn't our bound task is foreign; terminal events clear it.
    const isOurs = this.armed && taskId === this.our;
    if (created && !isOurs) {
      this.foreign.add(taskId);
      if (this.foreign.size > MAX_FOREIGN) {
        const oldest = this.foreign.values().next().value; // Set iterates in insertion order
        if (oldest !== undefined) this.foreign.delete(oldest);
      }
    } else if (ended) {
      this.foreign.delete(taskId);
    }
  }

  /** The bound task id for the current dispatch, or null if not yet bound. */
  get taskId(): string | null {
    return this.our;
  }
}
