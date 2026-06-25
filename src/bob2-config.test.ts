import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_PERMISSIONS,
  autoApproveSettings,
  mergeAutoApprove,
  writeAutoApprove,
  bob2SettingsPath,
} from "./bob2-config.js";

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
  assert.deepEqual(approval.allowedExecutors, [
    { toolId: "execute_command", approvedCommands: ["*"], deniedCommands: [] },
  ]);
});

test("mergeAutoApprove preserves foreign keys but replaces our policy keys wholesale", () => {
  const merged = mergeAutoApprove({
    auth: { token: "keep-me" },
    approval: { stale: true },
    isCommandSecurityEnabled: true,
  });
  assert.deepEqual(merged.auth, { token: "keep-me" }); // foreign key untouched
  assert.equal((merged.approval as Record<string, unknown>).stale, undefined); // old approval gone
  assert.equal(merged.isCommandSecurityEnabled, false); // our policy wins
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
    assert.equal(parsed.approval.old, undefined); // our approval replaced it
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
