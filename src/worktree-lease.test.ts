import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDb,
  recordWorkerHeartbeat,
  clearWorkerHeartbeat,
  worktreeLeaseHolder,
  claimWorktreeLease,
  holderIsLive,
  getWorkerLeases,
  WORKER_HEARTBEAT_WINDOW_MS,
} from "./db.js";

// T7 worktree lease: at most one live worker per checkout (keyed on its normalized cwd, stored in
// worker_heartbeats.worktree). worktreeLeaseHolder reports a DIFFERENT worker's fresh beat on a
// worktree (the worker refuses to start over it / reclaims it if its pid is dead); getWorkerLeases
// lists live owners for board_status. Writes stamp real now(); the READ's nowMs is injected so the
// freshness window is exercised deterministically.
const DB = join(tmpdir(), "bob-test-lease.db");
const WIN = WORKER_HEARTBEAT_WINDOW_MS;
function clean(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("worktree lease", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  beforeEach(() => getDb().exec("DELETE FROM worker_heartbeats")); // each test starts with no leases
  after(clean);

  it("an unowned worktree has no lease holder", () => {
    assert.equal(worktreeLeaseHolder("c:/wt/a", "me"), null);
  });

  it("recordWorkerHeartbeat persists the worktree, and a fresh beat by another worker holds the lease", () => {
    recordWorkerHeartbeat("other", { pid: 111, worktree: "c:/wt/a" });
    const row = getDb().prepare("SELECT worktree FROM worker_heartbeats WHERE worker_id = 'other'").get() as {
      worktree: string;
    };
    assert.equal(row.worktree, "c:/wt/a");
    const holder = worktreeLeaseHolder("c:/wt/a", "me");
    assert.equal(holder?.worker_id, "other");
    assert.equal(holder?.pid, 111);
  });

  it("excludes the calling worker (no self-conflict on its own lease)", () => {
    recordWorkerHeartbeat("me", { pid: 222, worktree: "c:/wt/a" });
    assert.equal(worktreeLeaseHolder("c:/wt/a", "me"), null);
  });

  it("a different worktree is not blocked", () => {
    recordWorkerHeartbeat("other", { pid: 111, worktree: "c:/wt/a" });
    assert.equal(worktreeLeaseHolder("c:/wt/b", "me"), null);
  });

  it("a stale beat is not a live lease (reclaimable after the window)", () => {
    recordWorkerHeartbeat("other", { pid: 111, worktree: "c:/wt/a" });
    assert.ok(worktreeLeaseHolder("c:/wt/a", "me", WIN, Date.now())); // fresh now
    assert.equal(worktreeLeaseHolder("c:/wt/a", "me", WIN, Date.now() + WIN + 5_000), null); // stale later
  });

  it("getWorkerLeases lists live owners with their worktree; reading past the window empties it", () => {
    recordWorkerHeartbeat("a", { pid: 1, worktree: "c:/wt/a" });
    recordWorkerHeartbeat("b", { pid: 2, worktree: "c:/wt/b" });
    const leases = getWorkerLeases(WIN, Date.now());
    assert.deepEqual(leases.map((l) => l.worktree).sort(), ["c:/wt/a", "c:/wt/b"]);
    assert.equal(getWorkerLeases(WIN, Date.now() + WIN + 5_000).length, 0);
  });

  it("clearWorkerHeartbeat releases the lease (graceful shutdown / reclaim of a dead holder)", () => {
    recordWorkerHeartbeat("other", { pid: 111, worktree: "c:/wt/a" });
    clearWorkerHeartbeat("other");
    assert.equal(worktreeLeaseHolder("c:/wt/a", "me"), null);
  });

  it("a corrupt/unparseable last_beat is NOT treated as a live lease (so it can't wedge a worktree)", () => {
    getDb()
      .prepare("INSERT INTO worker_heartbeats (worker_id, pid, worktree, started_at, last_beat) VALUES (?, ?, ?, ?, ?)")
      .run("bad", 111, "c:/wt/a", "x", "not-a-date");
    assert.equal(worktreeLeaseHolder("c:/wt/a", "me"), null);
  });

  it("claimWorktreeLease atomically claims a free worktree, then a 2nd worker loses the claim", () => {
    const first = claimWorktreeLease("w1", { pid: 1, worktree: "c:/wt/a" });
    assert.deepEqual(first, { claimed: true });
    // The claim recorded the heartbeat (it doubles as the first beat).
    assert.equal(worktreeLeaseHolder("c:/wt/a", "w2")?.worker_id, "w1");
    const second = claimWorktreeLease("w2", { pid: 2, worktree: "c:/wt/a" });
    assert.equal(second.claimed, false);
    assert.equal(second.claimed === false && second.holder.worker_id, "w1");
    // After the holder is cleared (reclaim / graceful exit) the worktree is claimable again.
    clearWorkerHeartbeat("w1");
    assert.deepEqual(claimWorktreeLease("w2", { pid: 2, worktree: "c:/wt/a" }), { claimed: true });
  });

  it("holderIsLive: unknown (null) pid is conservatively ALIVE; a known pid follows the probe", () => {
    assert.equal(
      holderIsLive(null, () => false),
      true,
    ); // null = unknown → never reclaim a maybe-live worker
    assert.equal(
      holderIsLive(123, () => true),
      true,
    );
    assert.equal(
      holderIsLive(123, () => false),
      false,
    );
  });
});
