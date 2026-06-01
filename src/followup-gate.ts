// Gray-zone question handling, the question-shaped sibling of command-gate.ts. When
// Bob asks a followup question mid-task, an unattended worker can't answer it and the
// task stalls to timeout. This gate asks Claude to answer (answer.ts) and sends the
// reply back over IPC; when the answerer declines, it escalates to a human instead of
// guessing. Bob's SendMessage is native IPC, so — unlike approve/reject — no patch.
import { answerFollowup } from "./answer.js";

export interface FollowupClient {
  sendMessage(text: string): void;
}

export interface FollowupEvent {
  ask?: string;
  text?: string;
  partial?: boolean;
  /** Message timestamp — dedup a re-emitted ask on it (a genuine re-ask has a new ts). */
  ts?: number;
}

export interface FollowupGateDeps {
  /** --answer-followups is set. */
  enabled: boolean;
  /** api backend chosen but no ANTHROPIC_API_KEY — can't auto-answer, must escalate. */
  blocked: boolean;
  /** --escalate-all is set: escalate every question instead of auto-answering. */
  escalateAll: boolean;
  /** --review-plans is set: escalate plan/design-approval questions, auto-answer mechanical ones. */
  reviewPlans: boolean;
  backend: "api" | "cli";
  model?: string;
  apiKey?: string;
  cliPath?: string;
  task: { id: number; title: string };
  cwd: string;
  client: FollowupClient;
  addNote: (taskId: number, note: string, author?: string) => void;
  log: (msg: string) => void;
  /** Surface a question we won't auto-answer to a human (toast / event). */
  escalate: (question: string, options: string[]) => void;
  /** True while this dispatch is still live (see command-gate). */
  isActive?: () => boolean;
  /** Injectable for tests; defaults to the real answerer. */
  answer?: typeof answerFollowup;
  /** Callback to handle human answers for escalated questions. */
  onHumanAnswer?: (answer: string) => void;
}

/** Tracks a pending escalated question awaiting human answer. */
export interface PendingEscalation {
  question: string;
  options: string[];
  taskId: number;
}

export interface ParsedFollowup {
  question: string;
  options: string[];
}

/** Bob sends a followup as JSON: {question, suggest:[{answer}]}. Falls back to plain text. */
export function parseFollowup(text: string): ParsedFollowup | null {
  let question = "";
  let options: string[] = [];
  try {
    const obj = JSON.parse(text);
    question = typeof obj?.question === "string" ? obj.question : "";
    if (Array.isArray(obj?.suggest)) {
      options = obj.suggest
        .map((s: any) => (typeof s === "string" ? s : s?.answer))
        .filter((x: any): x is string => typeof x === "string" && x.trim().length > 0);
    }
  } catch {
    question = text; // not JSON — treat the whole thing as the question
  }
  question = question.trim();
  return question ? { question, options } : null;
}

/**
 * Classify a followup question as either a plan/design-approval question or a
 * mechanical clarification. Conservative: when unsure, treat as plan (safer to escalate).
 *
 * Plan/design questions ask for approval of an approach, architecture decision, or
 * significant scope/behavior choice. Mechanical questions ask for simple facts like
 * file paths, flag names, or which of several equivalent options to use.
 */
export function classifyQuestion(question: string): "plan" | "mechanical" {
  const q = question.toLowerCase();

  // Mechanical indicators FIRST: asking for simple facts, paths, names, or choosing between equivalent options
  // Check these first because they're more specific and should take precedence
  const mechanicalPatterns = [
    /\bwhich (file|path|directory|folder|flag|option|name|extension)\b/,
    /\bwhat (is|are) the (file|path|directory|folder|flag|option|name)\b/,
    /\bwhere (is|are|should i put)\b/,
    /\bfile (path|name|location)\b/,
    /\bflag (name|value)\b/,
    /\b-[a-z] or -[a-z]\b/,  // e.g., "-x or -y"
    /\boption [a-z] or option [a-z]\b/,
    /\b(should|shall) i use (single|double)( or (single|double))? quotes/,
    /\bwhat (format|extension) (should i use|to use|should)\b/,
    /\bdirectory name\b/,
  ];

  for (const pattern of mechanicalPatterns) {
    if (pattern.test(q)) {
      return "mechanical";
    }
  }

  // Strong plan/design indicators: asking for approval, approach selection, or design decisions
  // More specific patterns to avoid false positives with mechanical questions
  const planPatterns = [
    /\b(should i|shall i) (proceed|continue|refactor|delete|remove|drop|change|modify)\b/,
    /\bdo you want me to\b/,
    /\bwould you like me to\b/,
    /\bmay i (proceed|continue|delete|remove)\b/,
    /\bcan i proceed\b/,
    /\b(approve|confirm|permission)\b/,
    /\bokay to|ok to\b/,
    /\bwhich (approach|strategy|method|design|architecture|pattern)\b/,
    /\bhow (should|shall) (i|we) (implement|structure|organize|design)\b/,
    /\bwhat (approach|strategy|method|design)\b/,
    /\bis (this|that) (okay|ok|acceptable|correct|right|good)\b/,
    /\b(better to|prefer to|recommended to)\b/,
    /\b(refactor|restructure|redesign|rearchitect)\b/,
    /\b(delete|remove|drop) (the )?(table|database)\b/,
    /\bchange the (behavior|logic|flow|structure)\b/,
    /\bmodify the (api|interface|contract|schema)\b/,
    /\bbreak(ing)? (change|compatibility)\b/,
  ];

  for (const pattern of planPatterns) {
    if (pattern.test(q)) {
      return "plan";
    }
  }

  // Default: when unsure, treat as plan (safer to escalate)
  return "plan";
}

export function createFollowupGate(deps: FollowupGateDeps): {
  gate: (ev: FollowupEvent) => Promise<void>;
  answerHuman: (answer: string) => void;
  getPending: () => PendingEscalation | null;
} {
  const answer = deps.answer ?? answerFollowup;
  const handled = new Set<string>();
  let warnedNoKey = false;
  let pendingEscalation: PendingEscalation | null = null;

  function answerHuman(answer: string): void {
    if (!pendingEscalation) {
      deps.log("  ~ received human answer but no pending escalation — ignoring");
      return;
    }
    // Check if dispatch is still active
    if (deps.isActive && !deps.isActive()) {
      deps.log("  ~ received human answer after dispatch ended — ignoring (stale)");
      pendingEscalation = null;
      return;
    }
    const short = pendingEscalation.question.replace(/\s+/g, " ").slice(0, 70);
    deps.client.sendMessage(answer);
    deps.log(`  ✓ human answered escalated followup → ${oneLine(answer)}`);
    deps.addNote(deps.task.id, `Human answered \`${short}\` → "${oneLine(answer, 120)}"`, "human");
    pendingEscalation = null;
  }

  function getPending(): PendingEscalation | null {
    return pendingEscalation;
  }

  function onFollowupAsk(ev: FollowupEvent): Promise<void> {
    if (!deps.enabled || ev.partial) return Promise.resolve();
    if (ev.ask !== "followup") return Promise.resolve();
    const parsed = parseFollowup((ev.text ?? "").trim());
    if (!parsed) return Promise.resolve();
    // Dedup by ASK IDENTITY (ts): Bob re-emits one pending ask as it streams (same ts),
    // while a genuine re-ask arrives as a new ts. Fall back to question text when no ts.
    const key = ev.ts !== undefined ? `ts:${ev.ts}` : `q:${parsed.question}`;
    if (handled.has(key)) return Promise.resolve();
    handled.add(key);

    const short = parsed.question.replace(/\s+/g, " ").slice(0, 70);

    // Helper to escalate and track the pending question
    const doEscalate = (reason: string) => {
      pendingEscalation = { question: parsed.question, options: parsed.options, taskId: deps.task.id };
      deps.escalate(parsed.question, parsed.options);
      deps.addNote(deps.task.id, `Followup escalated (${reason}): ${short}`, "answerer");
    };

    if (deps.blocked) {
      if (!warnedNoKey) {
        deps.log("  ⚠ answerer=api but ANTHROPIC_API_KEY unset — escalating questions to a human.");
        warnedNoKey = true;
      }
      doEscalate("no API key");
      return Promise.resolve();
    }

    // reviewPlans takes precedence over escalateAll when both are on
    if (deps.reviewPlans) {
      const classification = classifyQuestion(parsed.question);
      if (classification === "plan") {
        deps.log(`  ⤴ escalated followup to a human (plan/design question, --review-plans)`);
        doEscalate("plan/design, --review-plans");
        return Promise.resolve();
      }
      // mechanical questions fall through to auto-answer below
      deps.log(`  ⟲ answering mechanical followup (--review-plans): ${short}`);
    } else if (deps.escalateAll) {
      deps.log(`  ⤴ escalated followup to a human (--escalate-all)`);
      doEscalate("--escalate-all");
      return Promise.resolve();
    }

    // Only log if we didn't already log for reviewPlans mechanical case
    if (!deps.reviewPlans) {
      deps.log(`  ⟲ answering followup (${deps.backend}): ${short}`);
    }
    return answer(
      parsed.question,
      parsed.options,
      { task: deps.task.title, cwd: deps.cwd },
      { backend: deps.backend, model: deps.model, apiKey: deps.apiKey, cliPath: deps.cliPath },
    ).then(({ answer: text, reason }) => {
      // Dispatch may have ended while we were thinking; don't answer a stale prompt.
      if (deps.isActive && !deps.isActive()) {
        deps.log(`  ~ stale followup answer after dispatch ended — not sending (${reason})`);
        return;
      }
      if (text) {
        deps.client.sendMessage(text);
        deps.log(`  ✓ answered followup → ${oneLine(text)} (${reason})`);
        deps.addNote(deps.task.id, `Answered \`${short}\` → "${oneLine(text, 120)}" (${reason})`, "answerer");
      } else {
        deps.log(`  ⤴ escalated followup to a human (${reason})`);
        doEscalate(reason);
      }
    });
  }

  return { gate: onFollowupAsk, answerHuman, getPending };
}

function oneLine(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
