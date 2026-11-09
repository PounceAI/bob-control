// The board-native human-input question round-trip: a worker raises a question (parking its task
// `needs_input`), any board client answers it (resuming the worker), and an unanswered question
// times out fail-safe (parking the task `blocked` — never fabricating an answer). Extracted from
// db.ts as a self-contained subsystem; it reuses db's connection + low-level helpers.
import { randomUUID } from "node:crypto";
import type { TaskQuestion, QuestionState, QuestionResume } from "./types.js";
import { isFinished } from "./types.js";
import { getDb, transaction, nowIso, parseTags, getTask, updateStatus, addNote } from "./db.js";

/** Default time a board question waits for a human answer before the worker parks blocked. */
const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
/** Upper bound so `now + timeoutMs` can't overflow the max Date (toISOString would throw). */
const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function rowToQuestion(r: Record<string, unknown>): TaskQuestion {
  return {
    question_id: String(r.question_id),
    task_id: Number(r.task_id),
    text: String(r.text),
    options: parseTags(r.options), // reuse the tolerant JSON-array parser
    status: r.status as QuestionState,
    answer: (r.answer as string) ?? null,
    asked_at: String(r.asked_at),
    answered_at: (r.answered_at as string) ?? null,
    deadline_at: String(r.deadline_at),
    resume: r.resume === "requeue" ? "requeue" : "live",
    ask_kind: (r.ask_kind as string) ?? null,
  };
}

/**
 * Raise a question on the board: park the task `needs_input`, persist the question, and
 * add a human-readable note. The worker then polls questionState by question_id. Returns
 * the created question (with its generated question_id).
 */
export function askQuestion(
  taskId: number,
  text: string,
  options: string[] = [],
  timeoutMs: number = DEFAULT_QUESTION_TIMEOUT_MS,
  /** Worker-raised questions pass {resume:'requeue', kind} (see TaskQuestion.resume / ask_kind). */
  meta: { resume?: QuestionResume; kind?: string } = {},
): TaskQuestion | null {
  const resume = meta.resume ?? "live";
  const task = getTask(taskId);
  if (!task) return null;
  // Only a task actively being worked can raise a question — prevents a stale/duplicate ask
  // from resurrecting a finished/unclaimed task into needs_input. (needs_input allows a re-ask.)
  if (task.status !== "in_progress" && task.status !== "needs_input") return null;
  const now = Date.now();
  const asked = nowIso();
  const deadline = new Date(now + Math.min(timeoutMs, MAX_QUESTION_TIMEOUT_MS)).toISOString();
  const id = randomUUID();
  // One transaction for the whole ask: supersede the prior open question, insert the new one, park
  // the task needs_input, and log — so a crash mid-sequence can never strand the task needs_input
  // with no open question to answer (an unrecoverable wedge).
  return transaction(() => {
    // One open question per task: supersede any prior open one so the answer/timeout correlation
    // by question_id is unambiguous (getOpenQuestion can't shadow a second open row).
    supersedeOpenQuestions(taskId);
    getDb()
      .prepare(
        `INSERT INTO task_questions (question_id, task_id, text, options, status, asked_at, deadline_at, resume, ask_kind)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(id, taskId, text, JSON.stringify(options), asked, deadline, resume, meta.kind ?? null);
    updateStatus(taskId, "needs_input");
    const optStr = options.length ? `\nOptions: ${options.join(" | ")}` : "";
    addNote(taskId, `❓ Awaiting answer [${id}]: ${text}${optStr}`, "worker");
    return getQuestion(id);
  });
}

export function getQuestion(questionId: string): TaskQuestion | null {
  const row = getDb().prepare("SELECT * FROM task_questions WHERE question_id = ?").get(questionId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToQuestion(row) : null;
}

/** The task's current open question, or null. (askQuestion keeps at most one open per task;
 *  rowid breaks any asked_at tie deterministically.) Powers get_task. */
export function getOpenQuestion(taskId: number): TaskQuestion | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM task_questions WHERE task_id = ? AND status = 'open' ORDER BY asked_at DESC, rowid DESC LIMIT 1",
    )
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToQuestion(row) : null;
}

/** All open questions across the board (for `bob questions`). */
export function listOpenQuestions(): TaskQuestion[] {
  return (
    getDb().prepare("SELECT * FROM task_questions WHERE status = 'open' ORDER BY asked_at ASC").all() as Record<
      string,
      unknown
    >[]
  ).map(rowToQuestion);
}

/** The bare "supersede any still-open question for this task" UPDATE (status open → timed_out),
 *  returning the rows closed. Shared by askQuestion (one open question per task) and
 *  closeOpenQuestions; gating on status='open' keeps it from clobbering a concurrent answer. Adds no
 *  note — callers log as they see fit. */
function supersedeOpenQuestions(taskId: number): number {
  const info = getDb()
    .prepare("UPDATE task_questions SET status = 'timed_out' WHERE task_id = ? AND status = 'open'")
    .run(taskId);
  return Number(info.changes);
}

/**
 * Close any still-open question for a task — called when the task SETTLES (completed via completeTask,
 * or cancelled) so a late answer can't resurrect a finished run into a redundant re-dispatch (the
 * bug-report idempotency backstop). A closed question lands in 'timed_out', the same state the answer
 * and overdue-sweep guards already treat as "no longer open"; the human-readable reason goes in a
 * note. Returns the number of questions closed.
 */
export function closeOpenQuestions(taskId: number, reason: string): number {
  const n = supersedeOpenQuestions(taskId);
  if (n > 0) addNote(taskId, `🚫 Closed ${n} open question(s) — ${reason}.`, "worker");
  return n;
}

export type AnswerResult =
  | {
      ok: true;
      alreadyAnswered: boolean;
      /** Where the answer moved the task; null when it wasn't parked needs_input (nothing resumed). */
      resumedTo: "in_progress" | "pending" | "blocked" | null;
    }
  | { ok: false; error: string };

/** Answers to the same kind of worker-raised question after which re-queuing again is futile: the answer
 *  can't change what raised it (a denied command, the wrong Bob), so the task parks blocked instead. */
export const MAX_REQUEUE_ANSWERS = 2;

/** Move a parked (needs_input) task on after its question was answered — conditional on still being parked,
 *  so a concurrent timeout/cancel can't be clobbered. Must run inside the caller's transaction. */
function resumeParkedTask(q: TaskQuestion): "in_progress" | "pending" | "blocked" | null {
  let to: "in_progress" | "pending" | "blocked" = "in_progress";
  if (q.resume === "requeue") {
    const n = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM task_questions WHERE task_id = ? AND status = 'answered'
           AND resume = 'requeue' AND COALESCE(ask_kind, '') = ?`,
        )
        .get(q.task_id, q.ask_kind ?? "") as { n: number }
    ).n;
    to = n > MAX_REQUEUE_ANSWERS ? "blocked" : "pending";
  }
  const info = getDb()
    .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'needs_input'")
    .run(to, nowIso(), q.task_id);
  if (Number(info.changes) === 0) return null;
  if (to === "pending") {
    addNote(q.task_id, "↻ Re-queued with the answer; the next dispatch carries it in the prompt.", "worker");
  } else if (to === "blocked") {
    addNote(
      q.task_id,
      `⛔ Blocked: answered ${MAX_REQUEUE_ANSWERS + 1} '${q.ask_kind ?? "?"}' questions and it re-asked each time — ` +
        "an answer can't fix this (e.g. allow the command with --allow-commands, or run the task by hand), then re-queue it.",
      "worker",
    );
  }
  return to;
}

/**
 * Answer a question, matched by its unique question_id (so a stale answer can't apply to a
 * different/new question). Records the answer and resumes the task in one transaction: a 'live'
 * question resumes its waiter (in_progress); a 'requeue' one re-queues it (pending), or parks it
 * blocked once re-queuing has proven futile. Idempotent on an already answered question (and repairs
 * a requeue task a crash left parked); rejects unknown / wrong-task / timed-out ids.
 */
export function answerQuestion(taskId: number, questionId: string, answer: string): AnswerResult {
  const q = getQuestion(questionId);
  if (!q || q.task_id !== taskId) {
    return { ok: false, error: `no question '${questionId}' on task #${taskId}` };
  }
  // Idempotency backstop: a task that already SETTLED (done/analysis_done/cancelled) must
  // not be resurrected by a late answer — its run is finished, so resuming would re-dispatch redundant
  // work. Checked before the answered/timed_out branches so it holds whether the question is still
  // open or was auto-closed by completeTask, including the cross-channel case where the run ended
  // out-of-band (e.g. answered in Bob's own UI) while the board question lingered.
  const taskNow = getTask(taskId);
  if (taskNow && isFinished(taskNow.status)) {
    closeOpenQuestions(taskId, `answer arrived after the task settled '${taskNow.status}'`);
    return { ok: true, alreadyAnswered: true, resumedTo: null };
  }
  if (q.status === "answered") {
    // Idempotent. Repair: a requeue answer whose task is still parked with no newer open question
    // (answered by a pre-requeue binary, or a crash) gets the transition it missed.
    const repaired =
      q.resume === "requeue" && taskNow?.status === "needs_input" && !getOpenQuestion(taskId)
        ? transaction(() => resumeParkedTask(q))
        : null;
    return { ok: true, alreadyAnswered: true, resumedTo: repaired };
  }
  if (q.status === "timed_out") {
    return { ok: false, error: `question '${questionId}' timed out; re-ask before answering` };
  }
  return transaction((): AnswerResult => {
    // Conditional on still-open so a concurrent timeout (another process) can't be clobbered:
    // exactly one of answer/timeout wins (SQLite serializes the writes). changes===0 => lost.
    const info = getDb()
      .prepare(
        "UPDATE task_questions SET status = 'answered', answer = ?, answered_at = ? WHERE question_id = ? AND status = 'open'",
      )
      .run(answer, nowIso(), questionId);
    if (Number(info.changes) === 0) {
      const fresh = getQuestion(questionId);
      if (fresh?.status === "answered") return { ok: true, alreadyAnswered: true, resumedTo: null };
      return { ok: false, error: `question '${questionId}' is now '${fresh?.status ?? "gone"}' — cannot answer` };
    }
    addNote(taskId, `✅ Answered [${questionId}]: ${answer}`, "human");
    return { ok: true, alreadyAnswered: false, resumedTo: resumeParkedTask(q) };
  });
}

/** The task's operator answers to worker-raised ('requeue') questions — newest `limit`, oldest first —
 *  carried into the re-dispatch prompt. 'live' answers already reached Bob in-run, so they're excluded. */
export function listOperatorAnswers(taskId: number, limit = 3): TaskQuestion[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM task_questions WHERE task_id = ? AND status = 'answered' AND resume = 'requeue'
         ORDER BY answered_at DESC, rowid DESC LIMIT ?`,
      )
      .all(taskId, limit) as Record<string, unknown>[]
  )
    .map(rowToQuestion)
    .reverse();
}

/**
 * Re-queue tasks an older CLI/MCP server answered by flipping to in_progress with nothing driving them:
 * latest question an answered 'requeue' one, no "Auto-dispatched" note since. Scoped by assignee + tag like
 * reclaimStaleInProgress. Returns the count.
 */
export function requeueOrphanedAnswers(assignee: string, tag?: string): number {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.tags, q.answered_at FROM tasks t
       JOIN task_questions q ON q.task_id = t.id
       WHERE t.status = 'in_progress' AND t.assignee = ? AND q.status = 'answered' AND q.resume = 'requeue'
         AND q.rowid = (SELECT MAX(rowid) FROM task_questions WHERE task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM task_notes n WHERE n.task_id = t.id
                         AND n.note LIKE 'Auto-dispatched%' AND n.created_at >= q.answered_at)`,
    )
    .all(assignee) as { id: number; tags: unknown }[];
  let n = 0;
  for (const r of rows) {
    if (tag && !parseTags(r.tags).includes(tag)) continue;
    const info = getDb()
      .prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'in_progress'")
      .run(nowIso(), r.id);
    if (Number(info.changes) === 0) continue;
    addNote(r.id, "↻ Re-queued: answered but left in_progress with no dispatch (orphaned answer).", "worker");
    n++;
  }
  return n;
}

/**
 * Poll state for await_answer. Reads only the columns the poll needs (no options parse on the
 * hot path). If the question is open but past its deadline, time it out and park the task
 * `blocked` (fail-safe: never fabricate an answer) — conditional on still-open so it can't
 * clobber a concurrent answer. `nowMs` injectable for tests.
 */
export function questionState(
  questionId: string,
  nowMs: number = Date.now(),
): { status: QuestionState | "unknown"; answer?: string } {
  const row = getDb()
    .prepare("SELECT task_id, status, answer, deadline_at FROM task_questions WHERE question_id = ?")
    .get(questionId) as
    | { task_id: number; status: QuestionState; answer: string | null; deadline_at: string }
    | undefined;
  if (!row) return { status: "unknown" };
  if (row.status === "answered") return { status: "answered", answer: row.answer ?? "" };
  if (row.status === "open" && nowMs > Date.parse(row.deadline_at)) {
    const info = getDb()
      .prepare("UPDATE task_questions SET status = 'timed_out' WHERE question_id = ? AND status = 'open'")
      .run(questionId);
    if (Number(info.changes) === 0) {
      // Lost the race to an answer — report the real outcome, don't park blocked.
      const fresh = getQuestion(questionId);
      return fresh?.status === "answered"
        ? { status: "answered", answer: fresh.answer ?? "" }
        : { status: (fresh?.status as QuestionState) ?? "unknown" };
    }
    if (getTask(Number(row.task_id))?.status === "needs_input") updateStatus(Number(row.task_id), "blocked");
    addNote(
      Number(row.task_id),
      `⏰ Question [${questionId}] unanswered past timeout — parked blocked (no answer fabricated).`,
      "worker",
    );
    return { status: "timed_out" };
  }
  return { status: row.status };
}

/**
 * Sweep: time out every open question past its deadline (parking its task blocked), so the
 * fail-safe fires even if the worker that asked never polls again (it died / stopped looping).
 * Call from board activity (board_status / get_next_task) and the worker loop. Returns the count.
 */
export function expireOverdueQuestions(nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs).toISOString();
  const overdue = getDb()
    .prepare("SELECT question_id FROM task_questions WHERE status = 'open' AND deadline_at < ?")
    .all(cutoff) as { question_id: string }[];
  let n = 0;
  for (const r of overdue) {
    if (questionState(r.question_id, nowMs).status === "timed_out") n++;
  }
  return n;
}
