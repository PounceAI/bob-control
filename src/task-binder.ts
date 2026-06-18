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
  // Live task ids that are not part of our dispatch's tree. Bounded by MAX_FOREIGN: terminal
  // events delete entries, and overflow evicts the oldest, so it can't grow without bound.
  private foreign = new Set<string>();
  // Our dispatch's task TREE: the bound root + subtasks it spawned via `newTask` (noteSpawnFrom).
  // Membership = "ours". A user chat has no such provenance, so treating owned tasks as not-foreign
  // (no defer; press their prompts) can't auto-act on a user's own chat.
  private owned = new Set<string>();
  private our: string | null = null;
  private armed = false;
  // Announced-but-not-yet-created subtask spawns; each adopts the next new task id. A count (not a
  // boolean) so several newTask calls before their creates adopt every child, not just the first.
  private pendingChildren = 0;
  // ts of every newTask frame already counted, so a re-emit (same ts) isn't counted twice; a genuine
  // second spawn has a new ts. (Undefined ts can't be deduped; Bob always sends one — see noteSpawnFrom.)
  private spawnTsSeen = new Set<number>();

  /** Begin binding a new dispatch. Foreign set persists — open chats stay known. */
  arm(): void {
    this.our = null;
    this.owned.clear();
    this.pendingChildren = 0;
    this.spawnTsSeen.clear();
    this.armed = true;
  }

  /** End the dispatch so later foreign events aren't mistaken for ours. */
  disarm(): void {
    this.armed = false;
  }

  /**
   * An owned task emitted a `newTask` tool call: count a pending adoption so the next taskCreated joins
   * the tree. Only an owned task can spawn (a user chat is never in `owned`); `ts` dedups a re-emit.
   */
  noteSpawnFrom(taskId: string | undefined, ts?: number): void {
    if (!taskId) return;
    if (!this.armed || !this.owned.has(taskId)) return;
    if (ts !== undefined) {
      if (this.spawnTsSeen.has(ts)) return; // same spawn frame re-emitted — don't double-count
      this.spawnTsSeen.add(ts);
    }
    this.pendingChildren += 1;
  }

  /**
   * True if the task id is in our dispatch's tree (root or adopted subtask). Gated on `armed`: between
   * dispatches `owned` is stale, so a resumed prior task must read NOT-owned — else the observer would
   * flag it isOwn=true and suppress defer (a same-tab clobber).
   */
  isOwned(taskId: string | undefined): boolean {
    return this.armed && taskId !== undefined && this.owned.has(taskId);
  }

  /**
   * Drop an adopted subtask on its terminal so `owned` stays bounded; also undoes a create-race
   * mis-adoption. Never drops the root (cleared by arm()); no-op for unknown ids.
   */
  releaseChild(taskId: string | undefined): void {
    if (!taskId || taskId === this.our) return;
    this.owned.delete(taskId);
  }

  /** Feed one lifecycle event (taskCreated/taskStarted/taskCompleted/taskAborted). */
  observe(name: string, taskId: string | undefined): void {
    if (!taskId) return;
    const created = /taskCreated|taskStarted/i.test(name);
    const ended = /taskCompleted|taskAborted/i.test(name);
    // Bind the root: the first create/start of an armed dispatch that isn't an already-known chat.
    if (this.armed && this.our === null && created && !this.foreign.has(taskId)) {
      this.our = taskId;
      this.owned.add(taskId);
    }
    // Adopt a subtask: a pending newTask spawn (noteSpawnFrom) and here's the next new id. Consumes one.
    else if (
      this.armed &&
      this.pendingChildren > 0 &&
      created &&
      !this.owned.has(taskId) &&
      !this.foreign.has(taskId)
    ) {
      this.owned.add(taskId);
      this.pendingChildren -= 1;
    }
    // Everything outside our tree is foreign; terminal events clear it.
    const isOurs = this.armed && this.owned.has(taskId);
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
