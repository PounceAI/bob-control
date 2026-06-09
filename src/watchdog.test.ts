import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleWatchdog, type WatchdogTimer, type WatchdogTrip } from "./watchdog.js";

// A controllable fake timer: only ever one watchdog timer is armed at a time, so we keep the
// latest pending callback + its delay and fire it on demand. clear() drops the pending callback.
function fakeTimer(): WatchdogTimer & { fire: () => void; pending: () => number | null } {
  let cb: (() => void) | null = null;
  let delay: number | null = null;
  let seq = 0;
  return {
    set(fn, ms) {
      cb = fn;
      delay = ms;
      return ++seq;
    },
    clear() {
      cb = null;
      delay = null;
    },
    fire() {
      const fn = cb;
      cb = null;
      delay = null;
      fn?.();
    },
    pending() {
      return delay;
    },
  };
}

test("trips on pure idle after the idle window elapses with no activity", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 1000, blockedAskGraceMs: 100, onTrip: (t) => trips.push(t), timer });
  wd.start();
  assert.equal(timer.pending(), 1000, "armed the full idle window");
  timer.fire();
  assert.equal(trips.length, 1);
  assert.equal(trips[0].reason, "idle");
  assert.equal(trips[0].elapsedMs, 1000);
  assert.equal(trips[0].pendingAsk, undefined);
});

test("activity resets the idle window (no trip while progress continues)", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 1000, blockedAskGraceMs: 100, onTrip: (t) => trips.push(t), timer });
  wd.start();
  wd.activity();
  assert.equal(timer.pending(), 1000, "re-armed on activity");
  wd.activity();
  assert.equal(trips.length, 0, "no trip while activity keeps coming");
});

test("an UNANSWERABLE blocking ask arms the short grace and trips fast, naming the ask", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 300_000, blockedAskGraceMs: 5000, onTrip: (t) => trips.push(t), timer });
  wd.start();
  assert.equal(timer.pending(), 300_000, "starts on the long wall-clock-ish idle window");
  // Bob surfaces a command-permission ask the headless worker can't answer.
  wd.ask("command", "rm -rf build", false);
  assert.equal(timer.pending(), 5000, "shortened to the blocked-ask grace, not the full idle window");
  timer.fire();
  assert.equal(trips.length, 1, "tripped on the grace, well before the idle window");
  assert.equal(trips[0].reason, "blocked-ask");
  assert.equal(trips[0].pendingAsk, "command");
  assert.equal(trips[0].pendingAskText, "rm -rf build");
  assert.equal(trips[0].elapsedMs, 5000);
});

test("an ANSWERABLE ask is treated as progress (a gate will handle it) — no fast trip", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 1000, blockedAskGraceMs: 50, onTrip: (t) => trips.push(t), timer });
  wd.start();
  wd.ask("command", "npm test", true);
  assert.equal(timer.pending(), 1000, "stayed on the full idle window (gate will answer)");
  wd.activity();
  assert.equal(trips.length, 0);
});

test("activity after a blocked ask clears the blocked state (resumes normal idle)", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 1000, blockedAskGraceMs: 50, onTrip: (t) => trips.push(t), timer });
  wd.start();
  wd.ask("command", "deploy", false);
  assert.equal(timer.pending(), 50, "blocked grace armed");
  wd.activity(); // e.g. a late classifier approved it and Bob resumed
  assert.equal(timer.pending(), 1000, "back to the full idle window");
  timer.fire();
  assert.equal(trips[0].reason, "idle", "later trip is a plain idle, not blocked-ask");
});

test("trips at most once; stop() prevents any trip", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 1000, blockedAskGraceMs: 50, onTrip: (t) => trips.push(t), timer });
  wd.start();
  timer.fire();
  timer.fire(); // a stray second fire must not double-trip
  assert.equal(trips.length, 1);

  const wd2 = new IdleWatchdog({ idleMs: 1000, blockedAskGraceMs: 50, onTrip: (t) => trips.push(t), timer });
  wd2.start();
  wd2.stop();
  timer.fire();
  assert.equal(trips.length, 1, "stop() disarmed the watchdog");
});

test("idleMs <= 0 disables the watchdog (never arms, never trips)", () => {
  const timer = fakeTimer();
  const trips: WatchdogTrip[] = [];
  const wd = new IdleWatchdog({ idleMs: 0, blockedAskGraceMs: 50, onTrip: (t) => trips.push(t), timer });
  wd.start();
  assert.equal(timer.pending(), null, "nothing armed when disabled");
  wd.ask("command", "x", false);
  assert.equal(timer.pending(), null, "asks ignored when disabled");
  assert.equal(trips.length, 0);
});
