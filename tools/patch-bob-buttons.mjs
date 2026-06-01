#!/usr/bin/env node
// Reversible patch: expose Bob's existing pressPrimaryButton/pressSecondaryButton
// over the IPC pipe so an external worker can approve/deny a pending command ask
// (the IPC switch otherwise forwards only StartNewTask/CancelTask/CloseTask/
// ResumeTask/SendMessage — SendMessage can reject, nothing can approve).
//
// The two methods already exist on Bob's API class and are adjacent to sendMessage;
// we only add two `case` labels to the existing `s.on("TaskCommand")` switch. No
// schema change is needed: the commandName union (iLo/jls) is never parsed on
// intake, and nSt emits by message `type`, not by commandName.
//
//   node tools/patch-bob-buttons.mjs            # apply (idempotent; backs up once)
//   node tools/patch-bob-buttons.mjs --revert   # restore the backup
//   node tools/patch-bob-buttons.mjs --path <extension.js>   # override location
//
// Requires a Bob restart to take effect. The patch is dormant — it adds reachable
// commands but changes no behavior until something sends them.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const revert = argv.includes("--revert");
const pathFlag = argv.indexOf("--path");
const target =
  pathFlag !== -1
    ? argv[pathFlag + 1]
    : join(
        process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"),
        "Programs",
        "IBM Bob",
        "resources",
        "app",
        "extensions",
        "bob-code",
        "dist",
        "extension.js",
      );
const backup = target + ".bobtasks-bak";

const ANCHOR = "await this.sendMessage(c.text,c.images);break";
const INJECT =
  ANCHOR +
  ';case"PressPrimaryButton":await this.pressPrimaryButton();break' +
  ';case"PressSecondaryButton":await this.pressSecondaryButton();break';
const MARKER = '"PressPrimaryButton"';

if (!existsSync(target)) {
  console.error(`✗ Bob bundle not found: ${target}\n  Pass --path <extension.js>.`);
  process.exit(1);
}

if (revert) {
  if (!existsSync(backup)) {
    console.error(`✗ No backup at ${backup} — nothing to revert.`);
    process.exit(1);
  }
  copyFileSync(backup, target);
  console.log(`✓ Reverted Bob bundle from backup. Restart Bob to take effect.`);
  process.exit(0);
}

const src = readFileSync(target, "utf8");

if (src.includes(MARKER)) {
  console.log("✓ Already patched (PressPrimaryButton present). No change.");
  process.exit(0);
}
const hits = src.split(ANCHOR).length - 1;
if (hits !== 1) {
  console.error(`✗ Expected exactly 1 anchor, found ${hits}. Bundle changed; aborting to be safe.`);
  process.exit(1);
}

if (!existsSync(backup)) copyFileSync(target, backup);
writeFileSync(target, src.replace(ANCHOR, INJECT));
console.log(`✓ Patched ${target}`);
console.log(`  backup: ${backup}`);
console.log(`  added IPC commands: PressPrimaryButton, PressSecondaryButton`);
console.log(`  → Restart Bob (reload window) for the change to load.`);
