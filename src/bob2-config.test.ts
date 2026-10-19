import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_PERMISSIONS,
  BOB_HEADLESS_COMMANDS,
  autoApproveSettings,
  headlessCommands,
  mergeAutoApprove,
  writeAutoApprove,
  bob2SettingsPath,
} from "./bob2-config.js";
import { evaluateCommand } from "./command-policy.js";

// Bob 2.0 auto-approve config writer: merge is pure (preserve foreign keys, our policy wins),
// writeAutoApprove round-trips through a real file (BOM-safe, creates the dir, keeps other settings).

test("bob2SettingsPath resolves ~/.bob/settings/settings.json", () => {
  assert.match(bob2SettingsPath().replace(/\\/g, "/"), /\.bob\/settings\/settings\.json$/);
});

test("autoApproveSettings allows every permission and disables the command security gate", () => {
  const s = autoApproveSettings();
  assert.equal(s.isCommandSecurityEnabled, false);
  const approval = s.approval as Record<string, unknown>;
  assert.equal(approval.autoApprovalEnabled, true);
  assert.deepEqual(approval.allowed_permissions, [...ALL_PERMISSIONS]);
  // Regression: these gate finish-the-review / subtask / workflow tools — if any drops out, a headless
  // dispatch wedges on a manual approval (submit_review_findings did, before 'review' was added).
  const perms: readonly string[] = ALL_PERMISSIONS;
  for (const p of ["review", "subtask", "workflow"]) assert.ok(perms.includes(p), `missing ${p}`);
  assert.ok(!perms.includes("ask"), "'ask' must stay OUT — it gates the human-input checkpoint");
  // Outside-workspace stays a prompt: we don't write permissionOptions (an opt-in would let every Bob session
  // edit or read anywhere on disk unasked).
  assert.equal(approval.permissionOptions, undefined);
});

// Pinned port of Bob 2.x's command matcher (bob-code 2.2.3 HZ/ZVt; same in Bob Shell 2.0.2–2.0.6): whole-token
// prefix match, longest pattern wins, ties allow, no match → undefined (Bob prompts).
function longestMatch(command: string, patterns: string[]): string | undefined {
  const n = command.trim().split(/\s+/);
  let best: string | undefined;
  let len = -1;
  for (const s of patterns) {
    const e = s.trim().split(/\s+/);
    if (e.length === 0 || e[0] === "" || e.length > n.length) continue;
    if (e.every((u, f) => u === n[f]) && e.length > len) {
      best = s;
      len = e.length;
    }
  }
  return best;
}
function bobMatch(command: string, approved: string[], denied: string[]): "allow" | "deny" | undefined {
  const a = longestMatch(command, approved);
  const o = longestMatch(command, denied);
  if (!a && !o) return undefined;
  if (!o) return "allow";
  if (!a) return "deny";
  return a.trim().split(/\s+/).length >= o.trim().split(/\s+/).length ? "allow" : "deny";
}

const execOf = (s: Record<string, unknown>) =>
  ((s.approval as Record<string, unknown>).allowedExecutors as Record<string, unknown>[]).find(
    (e) => e.toolId === "execute_command",
  ) as { approvedCommands: string[]; deniedCommands: string[] };

test("autoApproveSettings' executor list does what we mean under Bob's matcher", () => {
  const exec = execOf(autoApproveSettings({ allow: ["cargo build"] }));
  const m = (c: string) => bobMatch(c, exec.approvedCommands, exec.deniedCommands);
  // Regression: "*" is not a wildcard to Bob — it matched nothing, so every command prompted.
  assert.ok(!exec.approvedCommands.includes("*"));
  assert.equal(bobMatch("npm test", ["*"], []), undefined);
  for (const c of ["npm test", "npm run lint", "git status", "git diff --stat", "git commit -m x", "ls", "cargo build"])
    assert.equal(m(c), "allow", c);
  // Off-list stays unmatched → Bob prompts (the permission gate's / a human's call, never silently run):
  // readers that reach outside the workspace, inline eval, work-discarding git, network, installs.
  for (const c of [
    "cat ~/.ssh/id_rsa",
    "git show HEAD:.env",
    "git config --get credential.helper",
    "echo x > .env",
    "node -e 1",
    "node --no-warnings -e 1",
    "python -c 1",
    "git checkout .",
    "git branch -D x",
    "git push",
    "curl http://x",
    "npm install left-pad",
    "rm -rf x",
    "*",
  ])
    assert.equal(m(c), undefined, c);
  // No denies of our own: Bob CANCELS a denied command in every session, interactive ones too.
  assert.deepEqual(exec.deniedCommands, []);
  assert.equal(new Set(exec.approvedCommands).size, exec.approvedCommands.length, "no duplicate patterns");
});

test("every Bob headless pattern is something the command policy allows (Bob never runs more than the gate)", () => {
  for (const p of BOB_HEADLESS_COMMANDS) {
    assert.equal(p, p.trim().split(/\s+/).join(" "), `${p}: not a normalized token pattern`);
    assert.equal(evaluateCommand(`${p} arg`).decision, "allow", p);
  }
});

test("headlessCommands keeps vetted extras and drops bare verbs and policy-denied ones", () => {
  const { approved, dropped } = headlessCommands({
    allow: ["cargo build", "  go   test  ", "git", "npm", "git push", "npm install", "node -e", "curl x", "make x", ""],
    deny: ["make x"],
  });
  assert.ok(approved.includes("cargo build") && approved.includes("go test"));
  assert.deepEqual(dropped, ["git", "npm", "git push", "npm install", "node -e", "curl x", "make x"]);
  for (const d of dropped) assert.ok(!approved.includes(d), d);
});

test("mergeAutoApprove keeps foreign keys, the user's approval extras and denies; replaces what we own", () => {
  const merged = mergeAutoApprove({
    auth: { token: "keep-me" },
    approval: {
      permissionOptions: [{ groupId: "read", enableOutsideWorkspace: true }],
      allowed_permissions: ["read"],
      allowedExecutors: [
        { toolId: "execute_command", approvedCommands: ["*", "cat"], deniedCommands: ["rm", "rm"] },
        { toolId: "other_tool", approvedCommands: ["x"], deniedCommands: [] },
      ],
    },
    isCommandSecurityEnabled: true,
  });
  const approval = merged.approval as Record<string, unknown>;
  assert.deepEqual(merged.auth, { token: "keep-me" }); // foreign key untouched
  assert.equal(merged.isCommandSecurityEnabled, false); // our policy wins
  assert.deepEqual(approval.allowed_permissions, [...ALL_PERMISSIONS]);
  assert.deepEqual(approval.permissionOptions, [{ groupId: "read", enableOutsideWorkspace: true }]); // user's
  const execs = approval.allowedExecutors as Record<string, unknown>[];
  assert.deepEqual(
    execs.find((e) => e.toolId === "other_tool"),
    { toolId: "other_tool", approvedCommands: ["x"], deniedCommands: [] },
  );
  const exec = execOf(merged);
  assert.deepEqual(exec.approvedCommands, [...BOB_HEADLESS_COMMANDS]); // the legacy "*" (and stale entries) gone
  assert.deepEqual(exec.deniedCommands, ["rm"]); // the user's deny survives — never quietly becomes an auto-run
  assert.equal(execs.filter((e) => e.toolId === "execute_command").length, 1);
});

test("writeAutoApprove creates the file (and dir) when absent, writing valid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob2cfg-"));
  const path = join(dir, "nested", "settings.json"); // dir does not exist yet
  try {
    const res = writeAutoApprove(path);
    assert.equal(res.created, true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.isCommandSecurityEnabled, false);
    assert.equal(parsed.approval.autoApprovalEnabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAutoApprove keeps a pre-existing unrelated key and tolerates a BOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob2cfg-"));
  const path = join(dir, "settings.json");
  try {
    const bom = String.fromCharCode(0xfeff); // U+FEFF UTF-8 BOM
    writeFileSync(path, bom + JSON.stringify({ installationId: "abc", approval: { old: 1 } }));
    const res = writeAutoApprove(path);
    assert.equal(res.created, false);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.installationId, "abc"); // foreign key survived
    assert.equal(parsed.approval.old, 1); // the user's approval keys survive the overlay
    assert.equal(parsed.approval.autoApprovalEnabled, true); // ours merged in
    assert.equal(parsed.isCommandSecurityEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAutoApprove refuses to overwrite an existing file that isn't valid JSON (no clobber)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob2cfg-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(path, "{ not json ]"); // unreadable as JSON — could be a real file we just can't parse
    assert.throws(() => writeAutoApprove(path), /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json ]"); // left untouched — Bob's content preserved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
