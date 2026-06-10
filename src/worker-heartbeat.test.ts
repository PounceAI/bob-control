import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDb,
  recordWorkerHeartbeat,
  clearWorkerHeartbeat,
  getWorkerLiveness,
  WORKER_HEARTBEAT_WINDOW_MS,
} from "./db.js";

const DB = join(tmpdir(), "bob-test-heartbeat.db");
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

// A worker's heartbeat is the signal board_status uses to tell a foreman whether await_task will
// actually be serviced. recordWorkerHeartbeat stamps real now(); the READ's nowMs is injected so
// the freshness window is exercised deterministically (read in the future → the beat goes stale).
describe("worker heartbeat liveness", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("no heartbeat → not draining, no last-beat", () => {
    assert.deepEqual(getWorkerLiveness(WIN, Date.now()), {
      draining: false,
      workers: 0,
      last_beat_seconds_ago: null,
    });
  });

  it("a fresh heartbeat → draining; reading past the window → stale", () => {
    recordWorkerHeartbeat("w1", { assignee: "bob", pid: 123 });
    const live = getWorkerLiveness(WIN, Date.now());
    assert.equal(live.draining, true);
    assert.equal(live.workers, 1);
    assert.ok((live.last_beat_seconds_ago ?? 99) < 5);
    // Read far enough past the beat that it falls outside the freshness window.
    const stale = getWorkerLiveness(WIN, Date.now() + WIN + 5_000);
    assert.equal(stale.draining, false);
    assert.equal(stale.workers, 0);
    assert.ok((stale.last_beat_seconds_ago ?? 0) >= WIN / 1000); // still reported as the last beat
  });

  it("upsert keeps one row per worker and refreshes the beat", () => {
    recordWorkerHeartbeat("w1", { assignee: "bob" });
    recordWorkerHeartbeat("w1", { assignee: "bob" });
    const row = getDb().prepare("SELECT COUNT(*) c FROM worker_heartbeats WHERE worker_id = 'w1'").get() as {
      c: number;
    };
    assert.equal(row.c, 1);
  });

  it("counts multiple distinct live workers", () => {
    clearWorkerHeartbeat("w1");
    recordWorkerHeartbeat("a");
    recordWorkerHeartbeat("b");
    const live = getWorkerLiveness(WIN, Date.now());
    assert.equal(live.workers, 2);
    assert.equal(live.draining, true);
  });

  it("clearWorkerHeartbeat removes a worker (graceful shutdown)", () => {
    clearWorkerHeartbeat("a");
    clearWorkerHeartbeat("b");
    assert.equal(getWorkerLiveness(WIN, Date.now()).workers, 0);
  });

  it("prunes long-dead rows on read (table can't grow unbounded)", () => {
    recordWorkerHeartbeat("ancient");
    // Read 31× the window ahead → past the prune cutoff (30× window).
    getWorkerLiveness(WIN, Date.now() + WIN * 31);
    const row = getDb().prepare("SELECT COUNT(*) c FROM worker_heartbeats").get() as { c: number };
    assert.equal(row.c, 0);
  });
});
