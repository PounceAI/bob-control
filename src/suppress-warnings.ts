/**
 * Suppress only the node:sqlite experimental warning. Must be imported before
 * ./db so the override is installed before node:sqlite loads.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning?.message ?? "";
  if (message.includes("SQLite is an experimental feature")) return;
  return (original as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
