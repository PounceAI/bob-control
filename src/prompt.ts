// The dispatch prompt Bob receives for a board task — shared by the 1.x/ACP worker and the 2.0 in-process
// driver loop so the two can't drift. Pure: callers pass the answers in (once per dispatch).
import type { Task, TaskQuestion } from "./types.js";
import { isReadOnlyMode } from "./modes.js";

const QUESTION_PREVIEW = 300;
const ANSWER_MAX = 1000;

/** Collapse whitespace and cap at `max` chars. */
function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * `Task #N: title` + description, then a no-writes line for read-only modes (saves Bob a turn on a rejected
 * `*-plan.md`), then any operator answers — capped and indented so an answer can't forge prompt structure.
 */
export function buildTaskPrompt(task: Task, mode?: string, answers: TaskQuestion[] = []): string {
  let out = `Task #${task.id}: ${task.title}`;
  if (task.description?.trim()) out += `\n\n${task.description.trim()}`;
  if (mode && isReadOnlyMode(mode)) {
    out +=
      `\n\nRead-only ${mode} dispatch: do not create or edit files (writes are rejected). ` +
      `Put the complete plan/findings in your final result.`;
  }
  if (answers.length) {
    const qa = answers.map((q) => {
      let a = (q.answer ?? "").trim();
      if (a.length > ANSWER_MAX) a = `${a.slice(0, ANSWER_MAX)}…`;
      const indented = a.split(/\r?\n/).join("\n     ");
      return `- Q: ${oneLine(q.text, QUESTION_PREVIEW)}\n  A: ${indented}`;
    });
    out += `\n\n## Operator answers\n\nA previous run of this task stopped on these questions; follow the answers.\n\n${qa.join("\n")}`;
  }
  return out;
}
