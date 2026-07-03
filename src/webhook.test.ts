import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  buildPayload,
  isNotable,
  createWebhookSink,
  validateWebhookUrl,
  redactUrl,
  type WebhookMeta,
} from "./webhook.js";

const META: WebhookMeta = { cwd: "/repo", assignee: "bob", tag: "rpg" };

// A recording fake fetch: captures calls, returns a controllable Response.
function fakeFetch(response: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

// A fake fetch whose calls stay pending until the test resolves them — for backpressure / flush races.
function gatedFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const resolvers: Array<(r: Response) => void> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Promise<Response>((r) => resolvers.push(r));
  }) as typeof fetch;
  const releaseAll = () => resolvers.forEach((r) => r({ ok: true, status: 200 } as unknown as Response));
  return { impl, calls, resolvers, releaseAll };
}

test("isNotable: notable transitions vs chatty heartbeats", () => {
  for (const t of ["taskDone", "taskFail", "taskRetry", "question", "stopped", "error"]) {
    assert.equal(isNotable(t), true, t);
  }
  for (const t of ["idle", "deferred", "resumed", "connected", "taskStart"]) {
    assert.equal(isNotable(t), false, t);
  }
});

test("validateWebhookUrl: accepts http(s), rejects junk + non-http schemes", () => {
  assert.equal(validateWebhookUrl("https://hooks.slack.com/services/T/B/X"), null);
  assert.equal(validateWebhookUrl("http://127.0.0.1:9000/hook"), null);
  assert.match(validateWebhookUrl("not a url") ?? "", /not a valid URL/);
  assert.match(validateWebhookUrl("file:///etc/passwd") ?? "", /unsupported scheme/);
  assert.match(validateWebhookUrl("ftp://host/x") ?? "", /unsupported scheme/);
  // The error must never echo the URL — a rejected-but-secret-bearing value would leak to stderr.
  const err = validateWebhookUrl("htp://hooks.slack.com/services/T/B/SECRET") ?? "";
  assert.ok(!err.includes("SECRET") && !err.includes("hooks.slack.com"), "error leaked the URL");
});

test("redactUrl: drops the credential-bearing path/query/userinfo", () => {
  assert.equal(redactUrl("https://hooks.slack.com/services/T00/B00/SECRET"), "https://hooks.slack.com/…");
  assert.equal(redactUrl("https://u:p@example.com/hook?token=abc"), "https://example.com/…");
  assert.equal(redactUrl("https://example.com/"), "https://example.com");
  assert.equal(redactUrl("garbage"), "(unparseable url)");
});

test("buildPayload: same summary in text + content, structured event, seq", () => {
  const p = buildPayload("taskDone", { id: 42, title: "Fix it", status: "done", filesChanged: 3 }, META, "T0", 7);
  assert.equal(p.text, p.content); // Slack reads text, Discord reads content — identical
  assert.ok(p.text.includes("Bob finished #42 (done)"));
  assert.ok(p.text.includes("Fix it"));
  assert.ok(p.text.includes("3 file(s) changed"));
  assert.ok(p.text.includes("[rpg]")); // tag surfaced
  assert.equal(p.event, "taskDone");
  assert.equal(p.seq, 7);
  assert.equal(p.ts, "T0");
  assert.deepEqual(p.worker, { cwd: "/repo", assignee: "bob", tag: "rpg" });
  assert.equal(p.data.filesChanged, 3); // raw event preserved for generic consumers
});

test("buildPayload: status-specific failure phrasing so an operator can tell them apart", () => {
  const s = (data: Record<string, unknown>) => buildPayload("taskFail", data, META, "T", 0).text;
  assert.ok(s({ id: 1, status: "verify-failed" }).includes("failed verification"));
  assert.ok(s({ id: 1, status: "timeout" }).includes("timed out"));
  assert.ok(s({ id: 1, status: "idle" }).includes("stalled (idle)"));
  assert.ok(s({ id: 1, status: "error", message: "boom" }).includes("errored"));
  assert.ok(s({ id: 1, status: "error", message: "boom" }).includes("boom"));
  assert.ok(s({ id: 1, status: "weird-new" }).includes("failed (weird-new)")); // graceful fallback
});

test("buildPayload: other event summaries", () => {
  const s = (type: Parameters<typeof buildPayload>[0], data: Record<string, unknown>) =>
    buildPayload(type, data, META, "T", 0).text;
  assert.ok(s("taskRetry", { id: 2, attempt: 2 }).includes("retrying #2 (attempt 2)"));
  assert.ok(s("question", { id: 3, question: "which branch?" }).includes("needs input on #3"));
  assert.ok(s("question", { id: 3, question: "which branch?" }).includes("which branch?"));
  assert.ok(s("stopped", {}).includes("worker stopped"));
  assert.ok(s("error", { message: "lease held" }).includes("worker error"));
});

test("sink posts notable events, skips heartbeats", async () => {
  const { impl, calls } = fakeFetch();
  const sink = createWebhookSink("http://x/hook", META, { fetchImpl: impl, now: () => "T" });
  sink.post("idle", { gated: 0 }); // skipped
  sink.post("connected", { pipe: "p" }); // skipped
  sink.post("taskDone", { id: 1, status: "done" }); // posted
  await sink.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://x/hook");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.event, "taskDone");
  assert.equal(body.data.id, 1);
});

test("seq increments monotonically across posts", async () => {
  const { impl, calls } = fakeFetch();
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl });
  sink.post("taskDone", { id: 1, status: "done" });
  sink.post("taskDone", { id: 2, status: "done" });
  sink.post("stopped", {});
  await sink.flush();
  const seqs = calls.map((c) => JSON.parse(c.init.body as string).seq);
  assert.deepEqual(seqs, [0, 1, 2]);
});

test("seq is not burned when payload serialization fails", async () => {
  const { impl, calls } = fakeFetch();
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl, log: () => {} });
  sink.post("taskDone", { id: 1n }); // BigInt → JSON.stringify throws → dropped; seq must NOT advance
  sink.post("taskDone", { id: 2, status: "done" }); // first *sent* POST → seq 0, not 1
  await sink.flush();
  assert.equal(calls.length, 1, "the unserializable event is dropped, not sent");
  assert.equal(JSON.parse(calls[0].init.body as string).seq, 0, "seq was not burned by the failed post");
});

test("HMAC: X-Bob-Signature present + correct when a secret is set, absent otherwise", async () => {
  const secret = "s3cr3t";
  const { impl, calls } = fakeFetch();
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl, secret, now: () => "T" });
  sink.post("taskDone", { id: 1, status: "done" });
  await sink.flush();
  const body = calls[0].init.body as string;
  const sig = (calls[0].init.headers as Record<string, string>)["x-bob-signature"];
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(sig, expected);

  const plain = fakeFetch();
  const sink2 = createWebhookSink("http://x", META, { fetchImpl: plain.impl });
  sink2.post("taskDone", { id: 1, status: "done" });
  await sink2.flush();
  assert.equal((plain.calls[0].init.headers as Record<string, string>)["x-bob-signature"], undefined);
});

test("backpressure: over the cap, excess POSTs are dropped and warned once", async () => {
  const { impl, calls } = gatedFetch();
  const logs: string[] = [];
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl, maxInFlight: 2, log: (m) => logs.push(m) });
  sink.post("taskDone", { id: 1, status: "done" }); // in flight
  sink.post("taskDone", { id: 2, status: "done" }); // in flight (now at cap)
  sink.post("taskDone", { id: 3, status: "done" }); // dropped
  sink.post("taskDone", { id: 4, status: "done" }); // dropped, no second warning
  assert.equal(calls.length, 2, "only up-to-cap POSTs reach fetch");
  assert.equal(logs.filter((l) => l.includes("dropping")).length, 1, "warned exactly once");
});

test("flush awaits in-flight POSTs", async () => {
  let release!: (r: Response) => void;
  const gate = new Promise<Response>((r) => (release = r));
  const impl = (async () => gate) as typeof fetch;
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl });
  sink.post("taskDone", { id: 1, status: "done" });
  let settled = false;
  const flushed = sink.flush().then(() => {
    settled = true;
  });
  await Promise.resolve(); // let microtasks drain; the gate is still blocking (manual release)
  assert.equal(settled, false, "flush resolved before the POST settled");
  release({ ok: true, status: 200 } as unknown as Response);
  await flushed;
  assert.equal(settled, true);
});

test("flush drains a POST that arrives while flush is already in progress", async () => {
  const g = gatedFetch();
  const sink = createWebhookSink("http://x", META, { fetchImpl: g.impl });
  sink.post("taskDone", { id: 1, status: "done" }); // A: in flight
  const flushed = sink.flush(); // snapshots [A], then awaits
  sink.post("stopped", {}); // B: arrives DURING the flush — must still be drained
  await Promise.resolve();
  g.resolvers[0]({ ok: true, status: 200 } as unknown as Response); // settle A
  await Promise.resolve();
  g.resolvers[1]({ ok: true, status: 200 } as unknown as Response); // settle B
  await flushed;
  assert.equal(g.calls.length, 2, "both A and the during-flush B were delivered");
});

test("flush is wall-clock bounded — a stuck endpoint can't hang exit", async () => {
  const impl = (async () => new Promise<Response>(() => {})) as typeof fetch; // never settles
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl, timeoutMs: 50 });
  sink.post("taskDone", { id: 1, status: "done" });
  await sink.flush(); // resolves via the deadline (timeoutMs + 1000), not the request
});

test("a failing POST is swallowed (best-effort), logged not thrown", async () => {
  const logs: string[] = [];
  const impl = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const sink = createWebhookSink("http://x", META, { fetchImpl: impl, log: (m) => logs.push(m) });
  assert.doesNotThrow(() => sink.post("taskFail", { id: 2, status: "error" }));
  await sink.flush(); // must not reject
  assert.ok(logs.some((l) => l.includes("network down")));
});

test("a non-2xx response is logged (redacted url), not thrown", async () => {
  const logs: string[] = [];
  const { impl } = fakeFetch({ ok: false, status: 500 });
  const sink = createWebhookSink("https://hooks.slack.com/services/T/B/SECRET", META, {
    fetchImpl: impl,
    log: (m) => logs.push(m),
  });
  sink.post("stopped", {});
  await sink.flush();
  assert.ok(logs.some((l) => l.includes("HTTP 500")));
  assert.ok(!logs.some((l) => l.includes("SECRET")), "the credential path must not appear in logs");
});

test("delivers over the network to a real endpoint (real global fetch)", async () => {
  const received: Array<{ contentType?: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      received.push({ contentType: req.headers["content-type"], body: JSON.parse(buf) });
      res.writeHead(200).end("ok");
    });
  });
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const sink = createWebhookSink(`http://127.0.0.1:${port}/hook`, META, { now: () => "T" });
  sink.post("taskDone", { id: 7, title: "Ship it", status: "done", filesChanged: 2 });
  await sink.flush();
  server.close();
  assert.equal(received.length, 1);
  assert.equal(received[0].contentType, "application/json");
  const body = received[0].body;
  assert.equal(body.event, "taskDone");
  assert.equal(body.seq, 0);
  assert.equal((body.data as Record<string, unknown>).id, 7);
  assert.ok(String(body.text).includes("Ship it"));
});
