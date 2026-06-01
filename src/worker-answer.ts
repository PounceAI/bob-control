// Parse and route a human answer (typed in the extension, delivered over the worker's
// stdin) to the right task's followup gate. Extracted from worker.ts so it's unit-
// testable against the REAL implementation rather than a copy.
//
// Wire format, one per line on the worker's stdin:
//   @@ANSWER {"taskId": 123, "answer": "the human's response"}

export interface AnswerableGate {
  answerHuman: (answer: string) => void;
}

/**
 * Route one @@ANSWER payload (the JSON after the prefix) to the matching gate.
 * Total and side-effect-light: malformed input or an unknown/closed task just logs.
 * Generic over the gate type so the worker's full gate object map fits directly.
 */
export function handleStdinAnswer<G extends AnswerableGate>(
  json: string,
  gates: Map<number, G>,
  log: (msg: string) => void,
): void {
  let parsed: { taskId?: number; answer?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    log(`  ~ malformed @@ANSWER line (not JSON): ${json.slice(0, 60)}`);
    return;
  }
  const { taskId, answer } = parsed;
  if (typeof taskId !== "number" || typeof answer !== "string") {
    log(`  ~ malformed @@ANSWER (missing taskId or answer): ${json.slice(0, 60)}`);
    return;
  }
  const gate = gates.get(taskId);
  if (!gate) {
    log(`  ~ received answer for task #${taskId} but no active gate (task may have completed)`);
    return;
  }
  gate.answerHuman(answer);
}
