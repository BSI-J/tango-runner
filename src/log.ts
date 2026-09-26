export type Level = "debug" | "info" | "warn" | "error";

let verbose = process.env.TANGO_RUNNER_DEBUG === "1";

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function log(level: Level, scope: string, msg: string): void {
  if (level === "debug" && !verbose) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

/** Never print a whole key. */
export function redact(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "tng_…";
}
