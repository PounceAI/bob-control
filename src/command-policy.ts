// Deterministic, non-interactive command permission policy — the resolver a headless worker uses so
// it NEVER blocks on a shell-command approval prompt. Pure and total: given a command (+ optional
// repo root and extra allow/deny lists) it returns allow | deny | escalate, with NO model call.
//
//   - allow:    safe + scoped — auto-run it (the gate presses approve; these prefixes also seed the
//               allowlist Bob auto-runs, so most never even surface a prompt).
//   - deny:     clearly out of scope — reject and surface it (git push, network installs, curl/wget,
//               sudo, rm -rf outside the repo, the universal hard-deny floor).
//   - escalate: not recognised — the caller hands it to the optional LLM classifier, or default-denies
//               and surfaces it. Default-deny by construction: unknown is never auto-approved.
import { hardDeny } from "./classify.js";
import { resolve, isAbsolute, sep } from "node:path";

export type PolicyDecision = "allow" | "deny" | "escalate";
export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

/**
 * The ask types Bob raises for a shell command — it has two wire spellings. Both the command and
 * permission gates resolve these, and the watchdog treats them as gate-answerable. Kept as the single
 * source of truth so a new spelling (Roo versions change them) is a one-line edit, not four.
 */
export const COMMAND_ASK_KINDS = ["command", "command_security_warning"] as const;
export function isCommandAsk(ask: string | undefined): boolean {
  return ask !== undefined && (COMMAND_ASK_KINDS as readonly string[]).includes(ask);
}

export interface PolicyConfig {
  /** Extra allow prefixes merged with the defaults (case-insensitive startsWith). */
  allow?: string[];
  /** Extra deny substrings merged with the defaults (case-insensitive substring match). */
  deny?: string[];
  /** Repo root, so a scoped __pycache__ cleanup is told apart from rm-ing an arbitrary path. */
  repoRoot?: string;
}

// Auto-run prefixes — ALSO the source for Bob's dispatch allowlist (see modes.ts). Deliberately
// scoped: there is no bare `git `/`npm `/`pip ` here, so `git push` and network installs fall through
// to the deny rules below instead of being silently auto-approved.
export const DEFAULT_ALLOW_PREFIXES: readonly string[] = [
  // read-only inspection
  "ls",
  "dir",
  "pwd",
  "cat ",
  "type ",
  "echo ",
  "grep ",
  "rg ",
  "findstr ",
  "cd ",
  "tsc",
  // version control — local & non-destructive only (push / reset --hard fall through to deny)
  "git status",
  "git add",
  "git commit",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git checkout",
  "git switch",
  "git stash",
  "git restore",
  "git fetch",
  "git rm",
  "git mv",
  "git tag",
  "git rev-parse",
  "git ls-files",
  "git config --get",
  // test / build runners (running tests, NOT installing)
  "pytest",
  "uv run pytest",
  "uv run python -m pytest",
  "python -m pytest",
  "python3 -m pytest",
  "npm run",
  "npm test",
  "npm ci",
  "pnpm run",
  "pnpm test",
  "yarn run",
  "yarn test",
  "node ",
  "make test",
  "make lint",
  "make check",
  // interpreters
  "python ",
  "python3 ",
  "py ",
];

// Pre-lowercased once (the defaults above are authored lowercase) so matchesAnyPrefix doesn't
// re-lowercase ~50 constants on every command evaluation.
const DEFAULT_ALLOW_PREFIXES_LC: readonly string[] = DEFAULT_ALLOW_PREFIXES.map((p) => p.toLowerCase());

// Denied regardless of the allowlist, matched on the WHOLE command string so a chained `… && curl …`
// is caught. The narrow __pycache__ cleanup is recognised BEFORE this, so a scoped rm isn't blanket-denied.
const DEFAULT_DENY: { re: RegExp; why: string }[] = [
  { re: /\bgit\s+push\b/i, why: "git push (not allowed unattended)" },
  { re: /\bgit\s+reset\s+--hard\b/i, why: "git reset --hard" },
  { re: /(^|[\s;&|`(])\s*(sudo|doas|runas)\b/i, why: "privilege escalation" },
  { re: /(^|[\s;&|`(])\s*(curl|wget|iwr|invoke-webrequest|nc|ncat|telnet)\b/i, why: "network access" },
  {
    re: /\b(pip3?|uv\s+pip|uv|npm|pnpm|yarn|poetry|gem|conda|apt|apt-get|brew|choco|cargo|go)\s+(install|i|add|sync|get)\b/i,
    why: "package / network install",
  },
  // Inline-eval interpreter forms run ARBITRARY code that the other rules can't see (it lives inside
  // the quoted argument), so a bare `node `/`python ` prefix must not auto-approve them — deny the
  // eval flags explicitly. `node <file>` / `python <file>` / `python -c` (in-spec) still allow.
  { re: /\bnode\b[^|&;\n]*\s-(e|p)\b/i, why: "node inline eval (-e/-p)" },
  { re: /\bnode\b[^|&;\n]*\s--(eval|print)\b/i, why: "node inline eval (--eval/--print)" },
  { re: /(^|[\s;&|`(])eval\b/i, why: "shell eval" },
  { re: /(^|[\s;&|`(])(chmod|chown|chgrp|icacls|takeown|attrib)\b/i, why: "permission/ownership change" },
  { re: /(^|[\s;&|`(])(ssh|scp|sftp|rsync|ftp)\b/i, why: "remote access" },
  // Reading secrets / credentials — even via an allowlisted reader like `cat`/`grep`/`git config`.
  { re: /(^|[\s'"=:(/\\])\.(ssh|aws|gnupg)[/\\]/i, why: "accesses a secrets directory (.ssh/.aws/.gnupg)" },
  {
    re: /(^|[\s'"=:(/\\])(\.env(\.\w+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|ed25519|dsa|ecdsa))(\b|$)/i,
    why: "accesses a secret file",
  },
  { re: /\/etc\/(passwd|shadow|sudoers)\b/i, why: "reads a system credential file" },
  { re: /\bgit\s+config\b[^\n]*credential/i, why: "reads git credentials" },
];

// Shell control / redirection / substitution. A command we auto-allow as a "cleanup" must contain
// none of these — otherwise an attacker could smuggle a second command past the scoped check.
const META = /[|&;`$><(){}]/;

/** True when `p` resolves to `root` itself or a path beneath it. Case-insensitive on Windows, whose
 *  filesystem is (so `C:\REPO\…` is correctly recognised as inside `C:\repo`). */
function withinRoot(p: string, root: string): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const r = resolve(root);
  const fold = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  const a = fold(abs);
  const b = fold(r);
  return a === b || a.startsWith(b + sep);
}

/**
 * True when `operand` is a SAFE target for a __pycache__ cleanup: its final path segment is literally
 * `__pycache__`, it has no parent-directory escape, and it stays inside the repo. Strips only
 * SURROUNDING quotes — an INNER quote (e.g. `src/__py'cache__`) means the path isn't literally
 * `__pycache__`, so it must not be treated as one.
 */
function isPycacheOperand(operand: string, repoRoot?: string): boolean {
  const path = operand.replace(/^['"]+|['"]+$/g, "").replace(/[/\\]+$/, "");
  if (!path || path.includes("..")) return false;
  if (!/(^|[/\\])__pycache__$/.test(path)) return false;
  // Without a repo root we can only trust a clearly-relative path; with one, require containment.
  return repoRoot ? withinRoot(path, repoRoot) : !isAbsolute(path);
}

/**
 * Recognise a SAFE Python-cache cleanup, scoped tightly so it can't double as `rm -rf /`: no shell
 * metacharacters, and (for rm) every operand must be a `__pycache__` path that stays inside the repo.
 * Returns a reason string when it's a recognised cleanup, else null.
 */
export function pycacheCleanup(command: string, repoRoot?: string): string | null {
  const c = command.trim();
  if (!c || META.test(c)) return null;
  // find <paths> -name (__pycache__ | *.pyc) … -delete   (never with -exec)
  if (/^find\b[\s\S]*-name\s+['"]?(__pycache__|\*\.pyc)['"]?[\s\S]*-delete\s*$/i.test(c) && !/-exec\b/i.test(c)) {
    return "pycache cleanup (find -delete)";
  }
  // rm [-flags] <operand…> where EVERY operand is a __pycache__ path inside the repo
  const rm = /^rm\s+(?:-[a-zA-Z]+\s+)*(.+)$/.exec(c);
  if (rm) {
    const operands = rm[1].split(/\s+/).filter((o) => o && !o.startsWith("-"));
    if (operands.length > 0 && operands.every((o) => isPycacheOperand(o, repoRoot))) {
      return "pycache cleanup (rm within repo)";
    }
  }
  return null;
}

/** `command` matches one of `lowerPrefixes` (which MUST already be lowercase — see callers). */
function matchesAnyPrefix(command: string, lowerPrefixes: readonly string[]): boolean {
  const c = command.trim().toLowerCase();
  return lowerPrefixes.some((p) => c.startsWith(p));
}

/**
 * Split a command on shell separators (&&, ||, ;, |, &) so a chain auto-runs only if EVERY segment is
 * allowlisted — but NOT on a separator inside single/double quotes, so `git commit -m "fix; bug"` stays
 * one segment instead of being needlessly escalated. Quote-awareness only RELAXES splitting (a more
 * lenient allow); the deny floor (evaluateCommand step 2) runs on the whole string regardless, so a
 * mis-split can never bypass a deny.
 */
function chainSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      segments.push(buf);
      buf = "";
      i++; // consume the second separator char
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * Evaluate one shell command the agent wants to run. Pure; never throws. Order matters: the narrow
 * cleanup allow is checked before the deny floor (so a scoped __pycache__ rm isn't blanket-denied),
 * then deny (hard floor + policy + caller denylist) on the whole string, then allow only when every
 * chained segment is allowlisted, else escalate.
 */
export function evaluateCommand(command: string, config: PolicyConfig = {}): PolicyResult {
  const c = (command ?? "").trim();
  if (!c) return { decision: "deny", reason: "empty command" };

  // 1. Narrow, scoped cleanup — allowed even though `rm -rf` is otherwise a hard deny.
  const cleanup = pycacheCleanup(c, config.repoRoot);
  if (cleanup) return { decision: "allow", reason: cleanup };

  // 2. Deny floor (whole-string, so chained denies are caught).
  const hd = hardDeny(c);
  if (hd) return { decision: "deny", reason: `hard deny: ${hd}` };
  for (const { re, why } of DEFAULT_DENY) if (re.test(c)) return { decision: "deny", reason: why };
  const lc = c.toLowerCase();
  for (const d of config.deny ?? []) {
    if (d.trim() && lc.includes(d.trim().toLowerCase())) return { decision: "deny", reason: `denylisted: ${d.trim()}` };
  }

  // 3. Allow only when EVERY chained segment is on the allowlist. The defaults are pre-lowercased;
  // only the (usually empty) caller extras need lowercasing, and only when present.
  const allow = config.allow?.length
    ? [...DEFAULT_ALLOW_PREFIXES_LC, ...config.allow.map((p) => p.toLowerCase())]
    : DEFAULT_ALLOW_PREFIXES_LC;
  const segments = chainSegments(c);
  if (segments.length > 0 && segments.every((s) => matchesAnyPrefix(s, allow))) {
    return { decision: "allow", reason: "allowlisted command" };
  }

  // 4. Unrecognised — caller escalates to the LLM classifier or default-denies + surfaces.
  return { decision: "escalate", reason: "not on the allowlist" };
}
