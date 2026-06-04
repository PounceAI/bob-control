// Claude-backed answerer for Bob's followup questions. When Bob asks a clarifying
// question (ask_followup_question) mid-task, an unattended worker has no human to
// answer it and the task stalls to timeout. This asks Claude to answer — preferring
// one of Bob's offered options — and the worker sends that back over IPC.
//
// Fail-safe by construction: low confidence, a consequential/irreversible question,
// any transport error, or an unparseable reply all yield answer:null, which the
// caller treats as "escalate to a human" — it never guesses on a risky question.
import { callModel, type LlmDeps } from "./llm.js";
import { parseFirstJsonObject } from "./json-extract.js";

export interface AnswerContext {
  task: string;
  cwd: string;
}

export interface FollowupAnswer {
  /** Text to send back to Bob, or null to escalate to a human. */
  answer: string | null;
  reason: string;
}

const SYSTEM = [
  "You are answering a clarifying question from an UNATTENDED AI coding agent mid-task in a developer's repo.",
  "You are given the task, the agent's question, and any options it offered.",
  "Pick the answer that best advances the task as specified, with the LEAST risk.",
  "- If options are offered, return the text of the single best option VERBATIM.",
  "- Otherwise give a short, concrete instruction.",
  "- Escalate (do NOT answer) if you are not confident, or the question involves deleting data, changing the task's scope, irreversible/destructive actions, secrets/credentials, or anything outside the stated task.",
  'Respond with ONLY compact JSON: {"answer":"<text to send>","escalate":true|false,"reason":"<=12 words"}.',
].join("\n");

function userContent(question: string, options: string[], ctx: AnswerContext): string {
  const opts = options.length ? `\nOptions offered:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : "";
  return `Task: ${ctx.task}\nWorkspace: ${ctx.cwd}\nThe agent asks:\n${question}${opts}`;
}

/**
 * Parse the model's reply. Pure and total: never throws, defaults to escalation
 * (answer:null) whenever the reply isn't a confident, non-empty answer.
 */
export function parseAnswer(text: string): FollowupAnswer {
  // Balanced-object extraction (not a greedy /\{[\s\S]*\}/) so trailing prose after the JSON doesn't
  // turn a confident answer into a spurious escalation.
  const obj = parseFirstJsonObject(text) as { answer?: unknown; reason?: unknown; escalate?: unknown } | null;
  if (!obj) return { answer: null, reason: "no parseable JSON in answerer output" };
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "(no reason)";
  if (obj.escalate === true) return { answer: null, reason };
  const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  if (!answer) return { answer: null, reason: reason === "(no reason)" ? "empty answer" : reason };
  return { answer, reason };
}

/** Answer a followup via the configured backend. Returns answer:null to escalate. */
export async function answerFollowup(
  question: string,
  options: string[],
  ctx: AnswerContext,
  deps: LlmDeps,
): Promise<FollowupAnswer> {
  if (!question.trim()) return { answer: null, reason: "empty question" };
  const res = await callModel(SYSTEM, userContent(question, options, ctx), deps, 200);
  return res.ok ? parseAnswer(res.text) : { answer: null, reason: res.reason };
}
