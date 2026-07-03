import { createHmac } from "node:crypto";

// Best-effort webhook sink: fire-and-forget POSTs of notable worker transitions to a URL. One payload
// serves three consumers with no per-target config — `text` (Slack), `content` (Discord), and the
// structured `event`+`data` (a generic receiver) — each ignoring the fields it doesn't use.

/** The full worker event taxonomy — a closed union so a typo at a call site is a compile error, not a
 *  silently-dropped POST. NOTABLE_EVENTS is the subset the webhook delivers. */
export type WorkerEvent =
  | "taskStart"
  | "taskDone"
  | "taskFail"
  | "taskRetry"
  | "question"
  | "idle"
  | "deferred"
  | "resumed"
  | "connected"
  | "stopped"
  | "error";

export interface WebhookMeta {
  cwd: string;
  assignee: string;
  tag?: string;
}

export interface WebhookSink {
  /** Queue a POST for a notable event; a no-op for events not in NOTABLE_EVENTS. Never throws. */
  post(type: WorkerEvent, data: Record<string, unknown>): void;
  /** Await in-flight POSTs (bounded by the request timeout, then a wall clock). Call before exit. */
  flush(): Promise<void>;
}

// Events that warrant a push: a task reached a terminal / attention state, or the worker itself
// stopped or errored. The chatty between-poll states (idle / deferred / resumed / connected / taskStart)
// are intentionally excluded — a webhook is for "something happened", not a heartbeat.
export const NOTABLE_EVENTS = new Set<WorkerEvent>([
  "taskDone",
  "taskFail",
  "taskRetry",
  "question",
  "stopped",
  "error",
]);

export function isNotable(type: string): boolean {
  return NOTABLE_EVENTS.has(type as WorkerEvent);
}

/** Validate a --webhook value up front so a typo fails loud at startup, not silently at first event.
 *  Returns an error string, or null if the URL is a well-formed http(s) URL. Rejecting non-http(s)
 *  schemes (file:, data:, …) also closes the obvious SSRF-by-scheme door. */
export function validateWebhookUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a valid URL: ${url}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `unsupported scheme '${u.protocol}' (use http: or https:): ${url}`;
  }
  return null;
}

/** Log/display form of a webhook URL with the path, query, and any userinfo stripped — a Slack/Discord
 *  incoming-webhook URL carries its secret in the path, so the full URL must never reach a log. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname && u.pathname !== "/" ? "/…" : "";
    return `${u.protocol}//${u.host}${tail}`;
  } catch {
    return "(unparseable url)";
  }
}

export interface WebhookPayload {
  text: string; // Slack renders this
  content: string; // Discord renders this — intentionally identical to `text`
  event: WorkerEvent;
  seq: number; // monotonic per-worker; concurrent POSTs can land out of order, so receivers can reorder
  data: Record<string, unknown>;
  worker: { cwd: string; assignee: string; tag?: string };
  ts: string;
}

export function buildPayload(
  type: WorkerEvent,
  data: Record<string, unknown>,
  meta: WebhookMeta,
  ts: string,
  seq: number,
): WebhookPayload {
  const summary = summarize(type, data, meta);
  return {
    text: summary,
    content: summary,
    event: type,
    seq,
    data,
    worker: { cwd: meta.cwd, assignee: meta.assignee, tag: meta.tag },
    ts,
  };
}

// A failure `status` → human phrase, so an operator watching Slack can tell a stall from a timeout from
// a verify miss without opening the board. The structured `data.status` still carries the raw value.
const FAIL_PHRASE: Record<string, string> = {
  "verify-failed": "failed verification",
  idle: "stalled (idle)",
  timeout: "timed out",
  aborted: "was aborted",
  error: "errored",
  blocked: "blocked",
};

/** One-line human summary — the Slack `text` / Discord `content`. */
function summarize(type: WorkerEvent, data: Record<string, unknown>, meta: WebhookMeta): string {
  const id = data.id !== undefined ? `#${data.id}` : "";
  const title = typeof data.title === "string" && data.title ? `: ${data.title}` : "";
  const where = meta.tag ? ` [${meta.tag}]` : "";
  switch (type) {
    case "taskDone": {
      const files = typeof data.filesChanged === "number" ? ` — ${data.filesChanged} file(s) changed` : "";
      return `✓ Bob finished ${id} (${data.status})${title}${files}${where}`;
    }
    case "taskFail": {
      const phrase = FAIL_PHRASE[String(data.status)] ?? `failed (${data.status})`;
      const msg = data.message ? ` — ${data.message}` : "";
      return `✗ Bob ${id} ${phrase}${title}${msg}${where}`;
    }
    case "taskRetry":
      return `↻ Bob retrying ${id} (attempt ${data.attempt})${title}${where}`;
    case "question":
      return `❓ Bob needs input on ${id}${title} — ${data.question ?? ""}${where}`;
    case "stopped":
      return `■ Bob worker stopped${where}`;
    case "error":
      return `⚠ Bob worker error${where}: ${data.message ?? ""}`;
    default:
      return `Bob ${type}${id ? ` ${id}` : ""}`;
  }
}

export interface WebhookOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout, ms — long enough for a slow Slack, short enough not to stall exit. Default 5000. */
  timeoutMs?: number;
  /** Injectable clock (ISO string); defaults to wall clock. */
  now?: () => string;
  /** Diagnostic sink for delivery failures; defaults to stderr. */
  log?: (msg: string) => void;
  /** Shared secret: when set, sign the body with HMAC-SHA256 and send it as `X-Bob-Signature: sha256=…`
   *  so a generic receiver can verify authenticity (Slack/Discord URLs are already pre-authenticated). */
  secret?: string;
  /** Backpressure cap on concurrent in-flight POSTs; excess is dropped (best-effort). Default 16. */
  maxInFlight?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_IN_FLIGHT = 16;

export function createWebhookSink(url: string, meta: WebhookMeta, opts: WebhookOptions = {}): WebhookSink {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date().toISOString());
  const log = opts.log ?? ((m: string) => console.error(m));
  const maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const safeUrl = redactUrl(url); // never log the credential-bearing path
  const inFlight = new Set<Promise<unknown>>();
  let seq = 0;
  let warnedOverflow = false;

  return {
    post(type, data) {
      if (!isNotable(type)) return;
      // Backpressure: a slow/dead endpoint must not accumulate unbounded connections + abort timers.
      // Dropping under overload is correct for a best-effort sink; warn once per overload episode.
      if (inFlight.size >= maxInFlight) {
        if (!warnedOverflow) {
          log(
            `[bob-control] webhook: ${maxInFlight} POSTs in flight to ${safeUrl} (endpoint slow/down?) — dropping until it drains`,
          );
          warnedOverflow = true;
        }
        return;
      }
      let body: string;
      try {
        body = JSON.stringify(buildPayload(type, data, meta, now(), seq++));
      } catch (e) {
        log(`[bob-control] webhook: could not build payload for ${type}: ${(e as Error).message}`);
        return;
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.secret)
        headers["x-bob-signature"] = `sha256=${createHmac("sha256", opts.secret).update(body).digest("hex")}`;
      const p = doFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) })
        .then((res) => {
          if (!res.ok) log(`[bob-control] webhook ${safeUrl} → HTTP ${res.status} for ${type}`);
        })
        .catch((e) => log(`[bob-control] webhook ${safeUrl} POST failed for ${type}: ${(e as Error).message}`))
        .finally(() => {
          inFlight.delete(p);
          if (inFlight.size === 0) warnedOverflow = false; // re-arm the overload warning for the next episode
        });
      inFlight.add(p);
    },
    async flush() {
      // Drain until the set is empty — a post() that arrives while we're awaiting is picked up on the next
      // loop, so a late final event isn't dropped at the flush boundary. Bounded by a wall clock (a hair
      // over the per-request timeout) so a stuck request can never hold the process exit open.
      const drain = (async () => {
        while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      })();
      const deadline = new Promise<void>((r) => {
        const t = setTimeout(r, timeoutMs + 1000);
        t.unref?.();
      });
      await Promise.race([drain, deadline]);
    },
  };
}
