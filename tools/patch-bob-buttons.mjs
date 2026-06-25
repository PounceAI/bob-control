#!/usr/bin/env node
// Reversible patch: let an external worker approve/deny a pending command ask over
// the IPC pipe (the IPC switch otherwise forwards only StartNewTask/CancelTask/
// CloseTask/ResumeTask/SendMessage — SendMessage can reject, nothing can approve).
// The same schema+switch mechanism also carries two read-only queries the worker needs:
// GetReviewFindings (review output) and GetWorkspace (the open folder, for the wrong-Bob guard).
//
// TWO edits are required, and BOTH must be present or presses are silently dropped:
//
//   1. SCHEMA (the long-missing piece). Before the IPC switch runs, the whole
//      incoming envelope is zod-validated: `Utn.safeParse(e)`. Utn's TaskCommand
//      branch validates `data` against a discriminatedUnion("commandName", […])
//      (the `jls` union) whose members are exactly StartNewTask/CancelTask/
//      CloseTask/ResumeTask/SendMessage. A PressPrimaryButton/PressSecondaryButton
//      command fails that parse and is dropped with Bob's own log line
//      "[server#onMessage] invalid paylooooad" (sic) — it NEVER reaches the switch. So we
//      add two members to the union.
//      (Earlier patch versions assumed commandName "is never parsed on intake" — it is.)
//
//   2. SWITCH. We add two `case` labels to the `s.on("TaskCommand")` switch:
//      PressPrimaryButton / PressSecondaryButton.
//
// Why we DON'T just call Bob's own pressPrimaryButton(): it posts the invoke to a
// HARDCODED this.sidebarProvider webview, and that post is only the FIRST half of the
// approve flow — it asks the React webview to act, the webview posts back
// {askResponse:"yesButtonClicked"}, and the host THEN runs
// getCurrentTask().handleWebviewAskResponse(...). The bounce-back only fires when a
// webview is LIVE/mounted, so under unattended dispatch (sidebar not rendering) the
// invoke is dropped and the command sits pending → timeout.
//
// So the switch case does two things:
//   a. SELECT the webview instance that owns the dispatched task — the one whose
//      getCurrentTask().taskId matches the id we sent; else (the IPC taskCreated id can
//      diverge from the running Cline's this.taskId) the SOLE instance actually running
//      a task. Never an idle instance: pressing the idle sidebar while a --new-tab task
//      runs ABORTS that task. Two+ runners with no id match ⇒ press nothing (ambiguous).
//      Candidates = sidebarProvider + activeInstances (deduped); <Provider> and its
//      static activeInstances are reached via this.sidebarProvider.constructor.
//   b. APPROVE the selected instance DIRECTLY: getCurrentTask().handleWebviewAskResponse(
//      "yesButtonClicked") (primary) / "noButtonClicked" (secondary) — the host-side
//      terminus, no live webview needed — falling back to the old webview post only if
//      the method is absent.
//
//   node tools/patch-bob-buttons.mjs            # apply (idempotent; rebuilds from backup)
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

// --- Edit 1: the commandName discriminatedUnion (jls). Anchor = the SendMessage
// member plus the union-closing `])`; we splice our two members in before the `])`.
const SCHEMA_ANCHOR =
  `ye.object({commandName:ye.literal("SendMessage"),data:ye.object({` +
  `text:ye.string().optional(),images:ye.array(ye.string()).optional()})})])`;
const SCHEMA_MEMBERS =
  `,ye.object({commandName:ye.literal("PressPrimaryButton"),data:ye.any().optional()})` +
  `,ye.object({commandName:ye.literal("PressSecondaryButton"),data:ye.any().optional()})` +
  `,ye.object({commandName:ye.literal("GetReviewFindings"),data:ye.any().optional()})` +
  `,ye.object({commandName:ye.literal("GetWorkspace"),data:ye.any().optional()})`;
const SCHEMA_INJECT = SCHEMA_ANCHOR.replace(/\]\)$/, SCHEMA_MEMBERS + "])");
// Unique to the schema edit; "PressPrimaryButton" also appears in the switch, so we
// match the zod-literal form specifically.
const SCHEMA_MARKER = `ye.literal("PressPrimaryButton")`;

// --- Edit 2: the IPC TaskCommand switch. Anchor = the SendMessage case body.
// In the switch the command is destructured as ({commandName:l,data:c}), so `c` is
// our payload — here the task id string sent by approve()/reject(). The injected case
// selects the owning instance (a, above) and approves it directly (b, above).
const SWITCH_ANCHOR = "await this.sendMessage(c.text,c.images);break";
const press = (invoke, answer) =>
  `{try{const _c=this.sidebarProvider.constructor,` +
  `_all=[this.sidebarProvider,...Array.from(_c.activeInstances)],_seen=new Set(),` +
  `_cand=_all.filter(x=>{if(!x||_seen.has(x))return false;_seen.add(x);return true}),` +
  `_ct=(x)=>{try{return(x.getCurrentTask&&x.getCurrentTask())||null}catch{return null}},` +
  `_byId=c?_cand.find(x=>{const t=_ct(x);return!!t&&t.taskId===c}):null,` +
  `_run=_cand.filter(x=>_ct(x)),` +
  `_i=_byId||(_run.length===1?_run[0]:null),` +
  `_task=_i?_ct(_i):null;` +
  `if(_task&&_task.handleWebviewAskResponse)await _task.handleWebviewAskResponse("${answer}");` +
  `else if(_i)await _i.postMessageToWebview({type:"invoke",invoke:"${invoke}"})}catch{}break}`;
// GetReviewFindings: serialize the findings store and broadcast it back over IPC as a
// normal TaskEvent (eventName:"reviewFindings") — reusing this.ipc.broadcast, the proven
// path. The findings manager is reached defensively (controller field, else the registry
// singleton `ii.Instance.findings`); `reachedVia` reports which resolved so the first run
// is self-diagnosing. Read-only: serialize/getAll only, no mutation. Never throws.
const getFindings =
  `{try{` +
  `const _fm=(this.findingsManager&&this.findingsManager.serializeFindings)?this.findingsManager` +
  `:((typeof ii!=="undefined"&&ii&&ii.Instance&&ii.Instance.findings)?ii.Instance.findings:null),` +
  `_via=this.findingsManager?"this":((typeof ii!=="undefined"&&ii&&ii.Instance&&ii.Instance.findings)?"ii":"none"),` +
  `_ser=_fm&&_fm.serializeFindings?_fm.serializeFindings():null,` +
  `_all=_fm&&_fm.getAllFindings?_fm.getAllFindings():null;` +
  `if(this.ipc&&this.ipc.broadcast)this.ipc.broadcast({type:"TaskEvent",origin:"server",` +
  `data:{eventName:"reviewFindings",payload:{taskId:(c&&c.taskId)||null,reachedVia:_via,serialized:_ser,allFindings:_all}}})` +
  `}catch{}break}`;
// GetWorkspace: report which folder this Bob has open so the worker's layer-2 guard can refuse a
// board↔workspace misroute (running git/edits against the wrong tree). this.sidebarProvider.cwd is the
// open workspace root — it falls back to getWorkspacePath() even with no task running — broadcast back
// as a normal TaskEvent (eventName:"workspaceInfo"), reusing this.ipc.broadcast like GetReviewFindings.
const getWorkspace =
  `{try{const _p=this.sidebarProvider,_ws=(_p&&_p.cwd)||null;` +
  `if(this.ipc&&this.ipc.broadcast)this.ipc.broadcast({type:"TaskEvent",origin:"server",` +
  `data:{eventName:"workspaceInfo",payload:{fsPath:_ws,pid:process.pid}}})}catch{}break}`;
const SWITCH_INJECT =
  SWITCH_ANCHOR +
  `;case"PressPrimaryButton":${press("primaryButtonClick", "yesButtonClicked")}` +
  `;case"PressSecondaryButton":${press("secondaryButtonClick", "noButtonClicked")}` +
  `;case"GetReviewFindings":${getFindings}` +
  `;case"GetWorkspace":${getWorkspace}`;
// Unique to the switch edit (the direct handleWebviewAskResponse call).
const SWITCH_MARKER = `handleWebviewAskResponse("yesButtonClicked")`;

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

// Establish a pristine baseline. If a backup exists, rebuild from it so both edits
// are applied to a known-clean file (idempotent regardless of which prior patch
// version is currently on disk). Otherwise the current file IS the baseline — back
// it up, but refuse if it already looks patched (no clean source to recover).
let src;
if (existsSync(backup)) {
  src = readFileSync(backup, "utf8");
} else {
  src = readFileSync(target, "utf8");
  if (src.includes(SCHEMA_MARKER) || src.includes(SWITCH_MARKER)) {
    console.error(`✗ Target looks already patched but no backup at ${backup}. Aborting (no clean source).`);
    process.exit(1);
  }
  copyFileSync(target, backup);
}

// Apply edit 1 (schema).
{
  const hits = src.split(SCHEMA_ANCHOR).length - 1;
  if (hits !== 1) {
    console.error(`✗ Expected exactly 1 schema anchor, found ${hits}. Bundle changed; aborting.`);
    process.exit(1);
  }
  src = src.replace(SCHEMA_ANCHOR, SCHEMA_INJECT);
}

// Apply edit 2 (switch).
{
  const hits = src.split(SWITCH_ANCHOR).length - 1;
  if (hits !== 1) {
    console.error(`✗ Expected exactly 1 switch anchor, found ${hits}. Bundle changed; aborting.`);
    process.exit(1);
  }
  src = src.replace(SWITCH_ANCHOR, SWITCH_INJECT);
}

writeFileSync(target, src);
console.log(`✓ Patched ${target}`);
console.log(`  backup: ${backup}`);
console.log(`  edit 1: PressPrimaryButton/PressSecondaryButton added to the commandName schema (jls union)`);
console.log(`  edit 2: PressPrimaryButton/PressSecondaryButton cases added to the IPC switch (select owning instance [id-match, else sole runner], then call getCurrentTask().handleWebviewAskResponse directly; webview-post fallback)`);
console.log(`  edit 3: GetReviewFindings case added to the IPC switch (serialize the findings store and broadcast it back as a TaskEvent[reviewFindings]; reachedVia self-diagnoses the findings reference)`);
console.log(`  edit 4: GetWorkspace case added to the IPC switch (broadcast the open folder back as a TaskEvent[workspaceInfo] for the worker's layer-2 wrong-Bob guard)`);
console.log(`  → Restart Bob (reload window) for the change to load.`);
