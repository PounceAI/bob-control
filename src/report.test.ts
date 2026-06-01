import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report.js";
import type { Task, TaskNote } from "./types.js";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function task(over: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return {
    title: `Task ${over.id}`,
    description: null,
    priority: "medium",
    tags: [],
    mode: null,
    assignee: null,
    result: null,
    created_at: ago(60 * MIN),
    updated_at: ago(60 * MIN),
    depends_on: [],
    ...over,
  };
}

function note(text: string, author = "bob"): TaskNote {
  return { id: 1, task_id: 0, author, note: text, created_at: ago(MIN) };
}

test("groups appear in display order with correct counts", () => {
  const tasks = [
    task({ id: 1, status: "done" }),
    task({ id: 2, status: "in_progress" }),
    task({ id: 3, status: "pending" }),
    task({ id: 4, status: "pending" }),
  ];
  const md = buildReport(tasks, new Map(), NOW);
  assert.match(md, /## In progress \(1\)/);
  assert.match(md, /## Blocked \(0\)/);
  assert.match(md, /## Pending \(2\)/);
  assert.match(md, /## Done \(1\)/);
  // In progress section precedes Pending precedes Done.
  assert.ok(md.indexOf("In progress") < md.indexOf("Pending"));
  assert.ok(md.indexOf("Pending") < md.indexOf("Done"));
  assert.match(md, /4 tasks · generated 2026-06-01T12:00:00\.000Z/);
});

test("preserves the order tasks are passed in (pull order)", () => {
  const tasks = [task({ id: 7, status: "pending" }), task({ id: 3, status: "pending" })];
  const md = buildReport(tasks, new Map(), NOW);
  assert.ok(md.indexOf("#7") < md.indexOf("#3"), "#7 should list before #3");
});

test("flags an in_progress task stalled past 30 min, not before", () => {
  const fresh = task({ id: 1, status: "in_progress", updated_at: ago(29 * MIN) });
  const old = task({ id: 2, status: "in_progress", updated_at: ago(31 * MIN) });
  const md = buildReport([fresh, old], new Map(), NOW);
  assert.doesNotMatch(md.split("\n").find((l) => l.includes("#1"))!, /stalled/);
  assert.match(md.split("\n").find((l) => l.includes("#2"))!, /⚠ stalled/);
});

test("does not flag blocked/pending tasks as stalled regardless of age", () => {
  const md = buildReport([task({ id: 1, status: "blocked", updated_at: ago(99 * MIN) })], new Map(), NOW);
  assert.doesNotMatch(md, /stalled/);
});

test("shows the latest note (last by created_at) with its author", () => {
  const notes = new Map([[5, [note("first", "me"), note("latest progress", "bob")]]]);
  const md = buildReport([task({ id: 5, status: "in_progress" })], notes, NOW);
  const line = md.split("\n").find((l) => l.includes("#5"))!;
  assert.match(line, /bob: latest progress/);
  assert.doesNotMatch(line, /first/);
});

test("a task with no notes renders without a note suffix", () => {
  const md = buildReport([task({ id: 9, status: "pending" })], new Map(), NOW);
  const line = md.split("\n").find((l) => l.includes("#9"))!;
  assert.doesNotMatch(line, / — /);
});

test("renders priority, assignee, and mode metadata", () => {
  const t = task({ id: 4, status: "pending", priority: "high", assignee: "bob", mode: "code" });
  const line = buildReport([t], new Map(), NOW).split("\n").find((l) => l.includes("#4"))!;
  assert.match(line, /\(high @bob \{code\}\)/);
});

test("empty board renders every group as none with a zero total", () => {
  const md = buildReport([], new Map(), NOW);
  assert.match(md, /## In progress \(0\)/);
  assert.match(md, /_none_/);
  assert.match(md, /0 tasks · generated/);
});

test("status filter restricts to a single group", () => {
  const tasks = [task({ id: 1, status: "done" }), task({ id: 2, status: "pending" })];
  const md = buildReport(tasks, new Map(), NOW, { status: "pending" });
  assert.match(md, /## Pending \(1\)/);
  assert.doesNotMatch(md, /## Done/);
  assert.doesNotMatch(md, /#1/);
});

test("humanizes age and idle into s/m/h/d", () => {
  const t = task({ id: 1, status: "pending", created_at: ago(2 * 86_400_000), updated_at: ago(3 * 3600_000) });
  const line = buildReport([t], new Map(), NOW).split("\n").find((l) => l.includes("#1"))!;
  assert.match(line, /age 2d/);
  assert.match(line, /idle 3h/);
});

test("limit caps done and cancelled groups with 'more' line, never truncates active groups", () => {
  const tasks = [
    task({ id: 1, status: "in_progress" }),
    task({ id: 2, status: "in_progress" }),
    task({ id: 3, status: "in_progress" }),
    task({ id: 4, status: "blocked" }),
    task({ id: 5, status: "blocked" }),
    task({ id: 6, status: "pending" }),
    task({ id: 7, status: "pending" }),
    task({ id: 8, status: "done" }),
    task({ id: 9, status: "done" }),
    task({ id: 10, status: "done" }),
    task({ id: 11, status: "done" }),
    task({ id: 12, status: "cancelled" }),
    task({ id: 13, status: "cancelled" }),
    task({ id: 14, status: "cancelled" }),
  ];
  const md = buildReport(tasks, new Map(), NOW, { limit: 2 });

  // Active groups (in_progress, blocked, pending) should show all tasks
  assert.match(md, /#1/);
  assert.match(md, /#2/);
  assert.match(md, /#3/);
  assert.match(md, /#4/);
  assert.match(md, /#5/);
  assert.match(md, /#6/);
  assert.match(md, /#7/);

  // Done group should show only first 2 tasks
  assert.match(md, /#8/);
  assert.match(md, /#9/);
  assert.doesNotMatch(md, /#10/);
  assert.doesNotMatch(md, /#11/);

  // Cancelled group should show only first 2 tasks
  assert.match(md, /#12/);
  assert.match(md, /#13/);
  assert.doesNotMatch(md, /#14/);

  // Check for 'more' lines
  const lines = md.split("\n");
  const doneSection = lines.slice(lines.indexOf("## Done (4)"));
  const cancelledSection = lines.slice(lines.indexOf("## Cancelled (3)"));

  assert.ok(doneSection.some((l) => l.includes("… and 2 more")), "Done section should have '… and 2 more'");
  assert.ok(cancelledSection.some((l) => l.includes("… and 1 more")), "Cancelled section should have '… and 1 more'");
});
