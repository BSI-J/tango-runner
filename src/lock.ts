import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";

/**
 * One runner per config. Two runners on the same config would both receive
 * every wake event and start the same task twice.
 */
export function lockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/** Pid of the live runner holding the lock, if any. A lock left by a dead process doesn't count. */
export function lockHolder(configPath: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath(configPath), "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

/** Take the lock or throw if another runner holds it. Released on process exit. */
export function acquireLock(configPath: string): void {
  const path = lockPath(configPath);
  const holder = lockHolder(configPath);
  if (holder !== undefined) {
    throw new Error(`Another tango-runner (pid ${holder}) is already running with this config. Stop it first (Ctrl-C in its terminal, or kill ${holder}).`);
  }
  try {
    unlinkSync(path); // stale lock from a process that's gone
  } catch {
    // no lock file
  }
  const fd = openSync(path, "wx", 0o600);
  writeSync(fd, String(process.pid));
  closeSync(fd);
  process.on("exit", () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {
      // already gone
    }
  });
}
