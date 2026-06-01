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
}

export interface FollowupGateDeps {
  /** --answer-followups is set. */
  enabled: boolean;
  /** api backend chosen but no ANTHROPIC_API_KEY — can't auto-answer, must escalate. */
  blocked: boolean;
  /** --escalate-all is set: escalate every question instead of auto-answering. */
  escalateAll: boolean;
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

export function createFollowupGate(deps: FollowupGateDeps): (ev: FollowupEvent) => Promise<void> {
  const answer = deps.answer ?? answerFollowup;
  const handled = new Set<string>();
  let warnedNoKey = false;

  return function onFollowupAsk(ev: FollowupEvent): Promise<void> {
    if (!deps.enabled || ev.partial) return Promise.resolve();
    if (ev.ask !== "followup") return Promise.resolve();
    const parsed = parseFollowup((ev.text ?? "").trim());
    // Bob re-emits the ask as it streams; answer each distinct question once.
    if (!parsed || handled.has(parsed.question)) return Promise.resolve();
    handled.add(parsed.question);

    const short = parsed.question.replace(/\s+/g, " ").slice(0, 70);

    if (deps.blocked) {
      if (!warnedNoKey) {
        deps.log("  ⚠ answerer=api but ANTHROPIC_API_KEY unset — escalating questions to a human.");
        warnedNoKey = true;
      }
      deps.escalate(parsed.question, parsed.options);
      deps.addNote(deps.task.id, `Followup escalated (no API key): ${short}`, "answerer");
      return Promise.resolve();
    }

    if (deps.escalateAll) {
      deps.escalate(parsed.question, parsed.options);
      deps.log(`  ⤴ escalated followup to a human (--escalate-all)`);
      deps.addNote(deps.task.id, `Followup escalated (--escalate-all): ${short}`, "answerer");
      return Promise.resolve();
    }

    deps.log(`  ⟲ answering followup (${deps.backend}): ${short}`);
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
        deps.escalate(parsed.question, parsed.options);
        deps.log(`  ⤴ escalated followup to a human (${reason})`);
        deps.addNote(deps.task.id, `Followup escalated (${reason}): ${short}`, "answerer");
      }
    });
  };
}

function oneLine(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
