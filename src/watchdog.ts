// Idle / blocked-on-ask watchdog for a single Bob dispatch. The flat wall-clock timeout
// (bob-ipc) burns the whole budget on a wedged dispatch; this trips far sooner when the agent
// makes no token/tool progress for an idle window, OR when it surfaces a blocking ask the
// headless worker can't answer (e.g. a command-permission prompt). On trip it reports WHY —
// pure idle vs the exact pending ask — so the cause is surfaced, not swallowed.
//
// Temporal by nature, so the timer is injected: the real one uses setTimeout (unref'd so it
// never keeps the process alive); tests pass a controllable fake and fire it by hand.

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface WatchdogTimer {
  set(fn: () => void, ms: number): TimerHandle;
  clear(h: TimerHandle): void;
}

/** Real timer: unref so a pending watchdog never holds the event loop open on its own. */
export const realTimer: WatchdogTimer = {
  set(fn, ms) {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface WatchdogTrip {
  /** "blocked-ask" = tripped on an unanswerable pending ask; "idle" = no progress for idleMs. */
  reason: "idle" | "blocked-ask";
  /** The ask type that wedged the dispatch (e.g. "command"), when reason is "blocked-ask". */
  pendingAsk?: string;
  /** The ask's payload text (e.g. the command awaiting approval), when available. */
  pendingAskText?: string;
  /** The window (ms) that elapsed with no progress before this trip. */
  elapsedMs: number;
}

export interface IdleWatchdogOpts {
  /** No-progress window before an idle trip. <= 0 disables the watchdog entirely. */
  idleMs: number;
  /**
   * Shorter window armed once an UNANSWERABLE blocking ask is seen, so a wedge on a
   * command-permission prompt ends in seconds instead of the full idle window. The brief grace
   * still lets a racing gate (classifier/answerer) act first. <= 0 falls back to idleMs.
   */
  blockedAskGraceMs: number;
  /** Fired at most once when the dispatch is judged wedged. */
  onTrip: (trip: WatchdogTrip) => void;
  /** Injectable timer (defaults to the real, unref'd setTimeout). */
  timer?: WatchdogTimer;
}

/**
 * Resets on every sign of progress; trips once when progress stops. A blocking ask that no gate
 * will answer (answerable=false) shortens the window so the dispatch dies fast instead of idling
 * out the wall clock. Single-shot: after it trips (or is stopped) it ignores further input.
 */
export class IdleWatchdog {
  private timer: WatchdogTimer;
  private handle: TimerHandle | null = null;
  private armedMs = 0;
  private tripped = false;
  private stopped = false;
  private blocked = false;
  private pendingAsk?: string;
  private pendingAskText?: string;

  constructor(private opts: IdleWatchdogOpts) {
    this.timer = opts.timer ?? realTimer;
  }

  /** Begin watching. No-op when idleMs <= 0 (feature disabled). */
  start(): void {
    if (this.opts.idleMs > 0) this.arm(this.opts.idleMs);
  }

  /** Disabled (idleMs <= 0) or already settled — ignore further input. */
  private get dead(): boolean {
    return this.tripped || this.stopped || this.opts.idleMs <= 0;
  }

  /** Any token/tool/say progress. Clears a prior blocked state and resets to the full idle window. */
  activity(): void {
    if (this.dead) return;
    this.blocked = false;
    this.pendingAsk = undefined;
    this.pendingAskText = undefined;
    this.arm(this.opts.idleMs);
  }

  /**
   * A blocking ask surfaced. `answerable` true → a gate will handle it, so treat it as progress
   * (don't shorten). `answerable` false → arm the short grace and remember the ask so a trip can
   * name it.
   */
  ask(ask: string, text: string | undefined, answerable: boolean): void {
    if (this.dead) return;
    if (answerable) {
      this.activity();
      return;
    }
    this.blocked = true;
    this.pendingAsk = ask;
    this.pendingAskText = text;
    const grace = this.opts.blockedAskGraceMs > 0 ? this.opts.blockedAskGraceMs : this.opts.idleMs;
    this.arm(grace);
  }

  /** Stop watching (dispatch settled some other way). Safe to call repeatedly. */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private arm(ms: number): void {
    this.clear();
    this.armedMs = ms;
    this.handle = this.timer.set(() => this.trip(), ms);
  }

  private clear(): void {
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
  }

  private trip(): void {
    if (this.tripped || this.stopped) return;
    this.tripped = true;
    this.handle = null;
    this.opts.onTrip({
      reason: this.blocked ? "blocked-ask" : "idle",
      pendingAsk: this.pendingAsk,
      pendingAskText: this.pendingAskText,
      elapsedMs: this.armedMs,
    });
  }
}
