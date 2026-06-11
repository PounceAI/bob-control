// Lightweight right-sizing estimate, applied when a task is created. A task whose scope dwarfs
// what one Bob dispatch can finish will time out mid-work (the incident: a multi-file edit that
// never completed) and strand partial work. Rather than dispatch it doomed, creation estimates the
// output-token scope from the description's size, the number of files it names, and the mode, then
// flags an oversized task so it can be split — or routed to orchestrator, which decomposes it into
// subtasks. Deliberately crude (no LLM): a hint, backed at runtime by the token budget backstop.
import { isReadOnlyMode } from "./modes.js";

/** Output tokens one dispatch can comfortably produce before it's better split. Tunable. */
export const SINGLE_DISPATCH_BUDGET = 40_000;

export interface ScopeInput {
  title: string;
  description?: string | null;
  /** Explicit mode if the creator set one (affects the multiplier); null/undefined = auto-route. */
  mode?: string | null;
}

export interface ScopeEstimate {
  /** Estimated output tokens for a single dispatch of this task. */
  tokens: number;
  /** True when the estimate exceeds the single-dispatch budget. */
  oversized: boolean;
  /** The budget the estimate was compared against (echoed for notes/messages). */
  budget: number;
  /** How many distinct files the task text appears to name. */
  fileCount: number;
}

// File-path-ish tokens, gated by a common source/extension allow-list so "e.g."/"etc." don't match.
const FILE_RE =
  /\b[\w./\\-]*\w\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|cs|md|json|ya?ml|toml|sql|sh|ps1|txt|html?|css|scss|vue|svelte|php|swift|kt|kts)\b/gi;

// Fenced code blocks (```…```). For a read-only task an embedded diff/sample is material to READ,
// not work to produce, so it's stripped before sizing. Module-level (like FILE_RE) — .replace()
// resets lastIndex per call, so the shared global is stateless across calls.
const FENCED_RE = /```[\s\S]*?```/g;

function countFiles(text: string): number {
  const matches = text.match(FILE_RE);
  if (!matches) return 0;
  return new Set(matches.map((m) => m.toLowerCase())).size;
}

// Read-only (ask/plan/review): derive it from the mode's permission profile (the canonical
// writes-off signal in modes.ts) rather than a parallel hardcoded list that could drift. Such modes
// read code and emit prose/findings, so their output doesn't scale with how much code is pasted in.
function isReadOnlyScopeMode(mode?: string | null): boolean {
  return mode != null && isReadOnlyMode(mode.trim().toLowerCase());
}

/**
 * Estimate a task's single-dispatch output-token scope. Crude and monotonic: a longer, more
 * detailed description and more named files both raise it. Components:
 *   base            a fixed floor for any task,
 *   per-file work   each named file ≈ several k output tokens to edit,
 *   spec complexity each ~200 chars of description ≈ another chunk of required work.
 */
export function estimateTaskScope(input: ScopeInput, budget: number = SINGLE_DISPATCH_BUDGET): ScopeEstimate {
  const readOnly = isReadOnlyScopeMode(input.mode);
  // For a read-only mode, drop fenced code blocks first: an embedded diff/sample is content to read,
  // not files to write, so it shouldn't read as scope. (Implementation modes keep it — pasted code
  // there often IS the work to produce.) Read-only output is smaller too, hence the 0.5 below.
  const rawDescription = input.description ?? "";
  const description = readOnly ? rawDescription.replace(FENCED_RE, " ") : rawDescription;
  const text = `${input.title}\n${description}`;
  const descChars = description.length;
  const fileCount = countFiles(text);

  const BASE = 3_000;
  const PER_FILE = 10_000;
  const PER_200_CHARS = 2_000;

  const raw = BASE + fileCount * PER_FILE + Math.ceil(descChars / 200) * PER_200_CHARS;
  const tokens = Math.round(raw * (readOnly ? 0.5 : 1));
  return { tokens, oversized: tokens > budget, budget, fileCount };
}
