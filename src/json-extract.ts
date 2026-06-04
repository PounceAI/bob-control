// Robustly pull JSON objects out of an LLM reply. Models wrap JSON in prose, emit trailing notes,
// or include braces inside string values — so the naive `text.match(/\{[\s\S]*\}/)` (which spans the
// FIRST "{" to the LAST "}") fails on anything after the JSON, and `/\{[^{}]*\}/` stops at the first
// inner brace. These string-aware, balance-tracking helpers handle both. Pure; never throw.

/**
 * Every TOP-LEVEL balanced `{...}` object in `text`, in order. String-aware: braces inside JSON
 * strings (and escaped quotes) don't affect nesting, so `{"reason":"see {x}"}` and nested objects
 * are returned whole. An unterminated trailing `{` is ignored (no balanced object).
 */
export function extractJsonObjects(text: string): string[] {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objs;
}

/**
 * The first balanced JSON object in `text` that `JSON.parse`s successfully, or null. A robust drop-in
 * for `JSON.parse(text.match(/\{[\s\S]*\}/)![0])` that doesn't break when prose or extra braces trail
 * the JSON.
 */
export function parseFirstJsonObject(text: string): unknown | null {
  for (const candidate of extractJsonObjects(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* not valid JSON — try the next balanced object */
    }
  }
  return null;
}
