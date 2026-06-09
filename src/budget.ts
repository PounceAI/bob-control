// Per-dispatch token/turn budget backstop. A runaway agent (looping, re-reading, churning) can
// burn the whole wall-clock without ever wedging on an ask — the idle watchdog won't catch it.
// This caps a dispatch at a token ceiling (a task's estimate + headroom, else a flat cap) and/or a
// turn cap, so it aborts cleanly instead of running away. All decisions are pure + testable; the
// bob-ipc layer feeds it usage parsed from Bob's api-request events and acts on `budgetExceeded`.

import { parseFirstJsonObject } from "./json-extract.js";

export interface ApiUsage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/**
 * Parse a Bob/Roo `api_req_started` (or `api_req_finished`) say payload for token usage. Those
 * messages carry JSON like {"request":"…","tokensIn":1234,"tokensOut":56,"cost":0.01}. Tolerant of
 * field-name variants and of the early "started" emission that has no counts yet (returns null).
 */
export function parseApiReqUsage(text: string | undefined): Partial<ApiUsage> | null {
  if (!text) return null;
  // Reuse the repo's tolerant JSON extractor (handles any prose Bob wraps around the payload) rather
  // than a bare JSON.parse on the whole string.
  const top = parseFirstJsonObject(text) as Record<string, unknown> | null;
  if (!top) return null;
  // Counts may sit at the top level or nested under a usage-ish object — check both so we tolerate
  // wire-shape variation across Bob/Roo versions instead of silently reading zero.
  const nested = ["usage", "apiReqInfo", "apiReq", "tokenUsage"]
    .map((k) => top[k])
    .find((v): v is Record<string, unknown> => !!v && typeof v === "object");
  const sources = nested ? [top, nested] : [top];
  const pick = (...keys: string[]): number | undefined => {
    for (const src of sources) {
      for (const k of keys) {
        const v = src[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
    return undefined;
  };
  const tokensIn = pick("tokensIn", "tokens_in", "inputTokens", "input_tokens");
  const tokensOut = pick("tokensOut", "tokens_out", "outputTokens", "output_tokens");
  const cost = pick("cost", "totalCost", "total_cost");
  if (tokensIn === undefined && tokensOut === undefined && cost === undefined) return null;
  return { tokensIn, tokensOut, cost };
}

/**
 * Accumulates per-request usage across a dispatch. Bob re-emits one api request's say as it streams
 * (same `ts`, growing counts), so we key by `ts` and keep the latest (last-wins) rather than
 * summing the re-emissions; distinct `ts` values are distinct requests (= turns). Messages with no
 * `ts` fold into a single anonymous slot so a re-emission there can't inflate the total either.
 */
export class BudgetTracker {
  private byTs = new Map<number, ApiUsage>();
  private anon: ApiUsage | null = null;
  // Running sums kept in step with byTs/anon so the getters are O(1) — budgetExceeded reads them on
  // every api-request event, so an O(turns) rebuild per access would be O(turns^2) over a dispatch.
  private sumOut = 0;
  private sumTotal = 0;
  private sumCost = 0;

  update(ts: number | undefined, u: Partial<ApiUsage>): void {
    const rec: ApiUsage = { tokensIn: u.tokensIn ?? 0, tokensOut: u.tokensOut ?? 0, cost: u.cost ?? 0 };
    // Last-wins per request (re-emissions of one streaming frame share a ts): back out the prior
    // record for this slot before adding the new one, so the running sums never double-count.
    const prev = ts === undefined ? this.anon : this.byTs.get(ts);
    if (prev) {
      this.sumOut -= prev.tokensOut;
      this.sumTotal -= prev.tokensIn + prev.tokensOut;
      this.sumCost -= prev.cost;
    }
    if (ts === undefined) this.anon = rec;
    else this.byTs.set(ts, rec);
    this.sumOut += rec.tokensOut;
    this.sumTotal += rec.tokensIn + rec.tokensOut;
    this.sumCost += rec.cost;
  }

  /** Output tokens generated — the metric a runaway loop inflates. */
  get outputTokens(): number {
    return this.sumOut;
  }
  get totalTokens(): number {
    return this.sumTotal;
  }
  get cost(): number {
    return this.sumCost;
  }
  /** Distinct api requests observed (≈ assistant turns). */
  get turns(): number {
    return this.byTs.size + (this.anon ? 1 : 0);
  }
}

export interface CeilingOpts {
  /** Headroom over the estimate, as a percent (e.g. 15 → estimate × 1.15). */
  headroomPct: number;
  /** Lower bound for the estimate-derived ceiling, so a tiny estimate can't abort real work early. */
  floor: number;
  /** Ceiling used when the task carries no estimate. */
  flatCap: number;
}

/**
 * The hard output-token ceiling for a dispatch: an estimate (+ headroom, floored) when the task
 * carries one, else the flat cap. 0 means "no ceiling" (disabled).
 */
export function computeCeiling(estimate: number | undefined, opts: CeilingOpts): number {
  if (estimate && estimate > 0) {
    return Math.max(Math.ceil(estimate * (1 + opts.headroomPct / 100)), opts.floor);
  }
  return opts.flatCap;
}

export interface BudgetLimits {
  /** Output-token ceiling; <= 0 disables the token check. */
  tokenCeiling?: number;
  /** Turn cap; <= 0 disables the turn check. */
  turnCap?: number;
}

/** Reason the dispatch is over budget, or null if within limits. Pure: the caller decides to abort. */
export function budgetExceeded(usage: { outputTokens: number; turns: number }, limits: BudgetLimits): string | null {
  if (limits.tokenCeiling && limits.tokenCeiling > 0 && usage.outputTokens > limits.tokenCeiling) {
    return `output tokens ${usage.outputTokens} exceeded ceiling ${limits.tokenCeiling}`;
  }
  if (limits.turnCap && limits.turnCap > 0 && usage.turns > limits.turnCap) {
    return `turns ${usage.turns} exceeded cap ${limits.turnCap}`;
  }
  return null;
}
