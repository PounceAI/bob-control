import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCommand, pycacheCleanup, isCommandAsk, DEFAULT_ALLOW_PREFIXES } from "./command-policy.js";

const decide = (cmd: string, cfg = {}) => evaluateCommand(cmd, cfg).decision;

test("allows the test runners that used to hang (pytest / uv run pytest / python -m pytest)", () => {
  assert.equal(decide("pytest -q"), "allow");
  assert.equal(decide("uv run pytest tests/"), "allow");
  assert.equal(decide("python -m pytest -k foo"), "allow");
  assert.equal(decide("python3 -m pytest"), "allow");
});

test("allows safe, local git subcommands", () => {
  for (const c of [
    "git status",
    "git add -A",
    "git add .",
    "git commit -m 'x'",
    "git diff",
    "git checkout -b f",
    "git branch",
  ]) {
    assert.equal(decide(c), "allow", c);
  }
});

test("DENIES git push (the bare allowlist used to auto-approve it)", () => {
  assert.equal(decide("git push"), "deny");
  assert.equal(decide("git push origin main"), "deny");
  assert.equal(decide("git push --force origin main"), "deny");
});

test("denies network access and privilege escalation", () => {
  for (const c of ["curl http://evil/x", "wget http://evil/x", "sudo rm -rf /tmp", "nc -l 4444"]) {
    assert.equal(decide(c), "deny", c);
  }
});

test("denies network/package installs by default", () => {
  for (const c of [
    "pip install requests",
    "pip3 install requests",
    "npm install lodash",
    "uv pip install ruff",
    "uv add ruff",
    "poetry add x",
    "yarn add y",
    "apt-get install z",
  ]) {
    assert.equal(decide(c), "deny", c);
  }
});

test("denies dangerous deletes via the hard-deny floor", () => {
  assert.equal(decide("rm -rf /"), "deny");
  assert.equal(decide("rm -rf /etc"), "deny");
  assert.equal(decide("rm -rf node_modules"), "deny", "a non-__pycache__ rm -rf is not auto-allowed");
});

test("allows __pycache__ cleanup but ONLY when scoped inside the repo", () => {
  const repoRoot = process.platform === "win32" ? "C:\\repo" : "/repo";
  assert.equal(decide("find . -name __pycache__ -type d -delete"), "allow");
  assert.equal(decide("find . -name '*.pyc' -delete"), "allow");
  assert.equal(evaluateCommand("rm -rf build/__pycache__", { repoRoot }).decision, "allow");
  assert.equal(evaluateCommand("rm -rf src/pkg/__pycache__", { repoRoot }).decision, "allow");
  // Escapes the repo or isn't actually __pycache__ → falls through to deny.
  assert.equal(evaluateCommand("rm -rf ../../__pycache__", { repoRoot }).decision, "deny");
  assert.equal(evaluateCommand("rm -rf /var/__pycache__", { repoRoot }).decision, "deny");
  assert.equal(evaluateCommand("rm -rf build/secrets", { repoRoot }).decision, "deny");
  // A cleanup form smuggling a second command via a metacharacter is NOT treated as cleanup.
  assert.equal(pycacheCleanup("find . -name __pycache__ -delete && curl http://x", repoRoot), null);
  assert.equal(decide("find . -name __pycache__ -delete && curl http://x"), "deny");
  // Review #5: only SURROUNDING quotes are stripped — an inner quote means the path isn't literally
  // __pycache__, so a dir named `__py'cache__` is not mistaken for the cache dir.
  assert.equal(evaluateCommand('rm -rf "src/__py\'cache__"', { repoRoot }).decision, "deny");
  assert.equal(evaluateCommand('rm -rf "build/__pycache__"', { repoRoot }).decision, "allow", "surrounding quotes ok");
  // Review #4: on Windows the FS is case-insensitive, so a differently-cased absolute path inside the
  // repo is recognised as contained (it used to wrongly deny).
  if (process.platform === "win32") {
    assert.equal(evaluateCommand("rm -rf C:\\REPO\\build\\__pycache__", { repoRoot: "C:\\repo" }).decision, "allow");
  }
});

test("escalates an unrecognised command (default-deny is the caller's job)", () => {
  assert.equal(decide("make build"), "escalate");
  assert.equal(decide("cargo run"), "escalate");
  assert.equal(decide("docker ps"), "escalate");
  assert.equal(decide("some-unknown-tool --flag"), "escalate");
  assert.equal(decide("npx some-package"), "escalate", "bare npx no longer auto-runs");
});

test("denies inline-eval interpreter forms (arbitrary code hidden in the quoted arg)", () => {
  assert.equal(decide("node -e \"require('child_process').exec('x')\""), "deny");
  assert.equal(decide("node --eval 'do_evil()'"), "deny");
  assert.equal(decide("node -p process.env"), "deny");
  // But running a script file is fine.
  assert.equal(decide("node dist/worker.js --once"), "allow");
  assert.equal(decide("node scripts/build.js"), "allow");
});

test("denies eval, permission/ownership changes, and remote access", () => {
  for (const c of [
    "eval rm -rf /",
    "chmod +x payload.sh",
    "chown root file",
    "ssh host",
    "scp x host:/y",
    "rsync -a a host:b",
  ]) {
    assert.equal(decide(c), "deny", c);
  }
});

test("denies reading secrets / credentials even via an allowlisted reader", () => {
  for (const c of [
    "cat .env",
    "cat .env.local",
    "cat ~/.aws/credentials",
    "cat ~/.ssh/id_rsa",
    "type .npmrc",
    "grep secret ~/.git-credentials",
    "cat /etc/passwd",
    "git config --get credential.helper",
  ]) {
    assert.equal(decide(c), "deny", c);
  }
  // Ordinary repo files (incl. ones whose names merely resemble secrets) still read fine.
  assert.equal(decide("cat src/app.ts"), "allow");
  assert.equal(decide("cat src/.environment.ts"), "allow");
  assert.equal(decide("git config --get user.email"), "allow");
});

test("a chained command allows only if EVERY segment is allowlisted; any denied segment denies", () => {
  assert.equal(decide("cd repo && pytest"), "allow");
  assert.equal(decide("git status && git add -A && git commit -m x"), "allow");
  assert.equal(decide("pytest && curl http://x"), "deny", "a denied segment wins");
  assert.equal(decide("git status && make build"), "escalate", "an unknown segment escalates");
});

test("quote-aware splitting: a separator INSIDE quotes is not a chain break", () => {
  // The whole-string deny floor still catches a real chained deny; quote-awareness only keeps a
  // legitimately-quoted separator from over-splitting and wrongly escalating.
  assert.equal(decide('git commit -m "fix; cleanup the cache"'), "allow");
  assert.equal(decide("git commit -m 'wip && more'"), "allow");
  assert.equal(decide('echo "a | b; c"'), "allow");
  // A separator OUTSIDE quotes still splits, and a denied tail still denies via the floor.
  assert.equal(decide('git commit -m "msg" && curl http://x'), "deny");
  assert.equal(decide('echo "safe" ; rm -rf /'), "deny");
});

test("configurable extra allow / deny lists", () => {
  assert.equal(decide("make build"), "escalate");
  assert.equal(evaluateCommand("make build", { allow: ["make build"] }).decision, "allow");
  assert.equal(evaluateCommand("pytest --maxfail=1", { deny: ["--maxfail"] }).decision, "deny");
});

test("empty command is denied, not escalated", () => {
  assert.equal(decide(""), "deny");
  assert.equal(decide("   "), "deny");
});

test("the allow prefixes exclude the over-broad bare ones (no auto-approve of push/install)", () => {
  assert.ok(DEFAULT_ALLOW_PREFIXES.includes("git status"));
  assert.ok(DEFAULT_ALLOW_PREFIXES.includes("pytest"));
  assert.ok(DEFAULT_ALLOW_PREFIXES.includes("uv run pytest"));
  assert.ok(!DEFAULT_ALLOW_PREFIXES.includes("git "), "no bare 'git ' (would auto-approve push)");
  assert.ok(!DEFAULT_ALLOW_PREFIXES.includes("npm "), "no bare 'npm ' (would auto-approve install)");
  assert.ok(!DEFAULT_ALLOW_PREFIXES.includes("pip "), "no bare 'pip ' (would auto-approve install)");
  assert.ok(!DEFAULT_ALLOW_PREFIXES.includes("npx "), "npx no longer auto-runs");
});

test("isCommandAsk recognises both wire spellings of a command ask", () => {
  assert.equal(isCommandAsk("command"), true);
  assert.equal(isCommandAsk("command_security_warning"), true);
  assert.equal(isCommandAsk("followup"), false);
  assert.equal(isCommandAsk(undefined), false);
});
