import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Remembers the harness session id per (agent, task|thread), so a second wake
 * on the same task resumes the same conversation instead of starting cold.
 */
export class SessionStore {
  private data: { sessions: Record<string, { id: string; at: string }> } = { sessions: {} };

  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
        this.data.sessions ??= {};
      } catch {
        // corrupt state is not fatal; start fresh
      }
    }
  }

  get(key: string): string | undefined {
    return this.data.sessions[key]?.id;
  }

  set(key: string, id: string): void {
    this.data.sessions[key] = { id, at: new Date().toISOString() };
    this.prune();
    this.save();
  }

  delete(key: string): void {
    delete this.data.sessions[key];
    this.save();
  }

  /** Keep the newest 500. */
  private prune(): void {
    const entries = Object.entries(this.data.sessions);
    if (entries.length <= 500) return;
    entries.sort((a, b) => b[1].at.localeCompare(a[1].at));
    this.data.sessions = Object.fromEntries(entries.slice(0, 500));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
