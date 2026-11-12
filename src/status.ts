import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./config.js";

/**
 * `~/.tango-runner/status.json`: a small, frequently refreshed snapshot of the
 * running runner, so a supervisor (Applayer Desktop, a script, `tango-runner
 * status`) can tell "running and talking to Tango" from "process alive but
 * stuck" without parsing logs. Never contains keys.
 *
 * A reader should treat the file as stale when `updated_at` is older than
 * ~2 minutes or `pid` is no longer alive: the runner rewrites it at least every
 * 30 seconds while it runs.
 */
export interface AgentStatus {
  name: string;
  harness: string;
  mode: "wait" | "poll";
  /** Last successful request to Tango (long-poll, ack, heartbeat or poll). */
  last_contact_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  active_runs: number;
  runs_started: number;
  last_run: null | {
    key: string;
    started_at: string;
    ended_at: string | null;
    result: string | null;
  };
}

export interface RunnerStatus {
  version: string;
  pid: number;
  state: "running" | "stopping" | "stopped";
  started_at: string;
  updated_at: string;
  config: string;
  tango_url: string;
  agents: AgentStatus[];
}

export function statusPath(): string {
  return join(stateDir(), "status.json");
}

export function readStatus(path = statusPath()): RunnerStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunnerStatus;
  } catch {
    return undefined;
  }
}

const now = () => new Date().toISOString();

/** One per runner process. Writes are throttled and atomic (tmp + rename). */
export class StatusWriter {
  private status: RunnerStatus;
  private timer?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private lastWrite = 0;

  constructor(
    opts: { version: string; config: string; tangoUrl: string; agents: { name: string; harness: string }[] },
    private path = statusPath(),
    private minIntervalMs = 2000,
  ) {
    this.status = {
      version: opts.version,
      pid: process.pid,
      state: "running",
      started_at: now(),
      updated_at: now(),
      config: opts.config,
      tango_url: opts.tangoUrl,
      agents: opts.agents.map((a) => ({
        name: a.name,
        harness: a.harness,
        mode: "wait",
        last_contact_at: null,
        last_error: null,
        last_error_at: null,
        active_runs: 0,
        runs_started: 0,
        last_run: null,
      })),
    };
  }

  /** Write now and keep the file fresh every `tickMs` even when nothing happens. */
  start(tickMs = 30_000): void {
    this.flush();
    this.timer = setInterval(() => this.flush(), tickMs);
    this.timer.unref?.();
  }

  private agent(name: string): AgentStatus | undefined {
    return this.status.agents.find((a) => a.name === name);
  }

  contact(name: string, ok: boolean, error?: string): void {
    const a = this.agent(name);
    if (!a) return;
    if (ok) a.last_contact_at = now();
    else {
      a.last_error = (error ?? "request failed").slice(0, 300);
      a.last_error_at = now();
    }
    this.touch();
  }

  mode(name: string, mode: "wait" | "poll"): void {
    const a = this.agent(name);
    if (!a || a.mode === mode) return;
    a.mode = mode;
    this.touch();
  }

  runStarted(name: string, key: string): void {
    const a = this.agent(name);
    if (!a) return;
    a.active_runs += 1;
    a.runs_started += 1;
    a.last_run = { key, started_at: now(), ended_at: null, result: null };
    this.touch();
  }

  runEnded(name: string, key: string, result: string): void {
    const a = this.agent(name);
    if (!a) return;
    a.active_runs = Math.max(0, a.active_runs - 1);
    if (a.last_run && a.last_run.key === key && !a.last_run.ended_at) {
      a.last_run.ended_at = now();
      a.last_run.result = result;
    }
    this.touch();
  }

  setState(state: RunnerStatus["state"]): void {
    this.status.state = state;
    if (state === "stopped" && this.timer) clearInterval(this.timer);
    this.flush();
  }

  /** Coalesce bursts: at most one write per `minIntervalMs`. */
  private touch(): void {
    const wait = this.lastWrite + this.minIntervalMs - Date.now();
    if (wait <= 0) return this.flush();
    if (!this.pending) {
      this.pending = setTimeout(() => this.flush(), wait);
      this.pending.unref?.();
    }
  }

  flush(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.status.updated_at = now();
    this.lastWrite = Date.now();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.status, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // Status is best effort; it must never take the runner down.
    }
  }

  snapshot(): RunnerStatus {
    return JSON.parse(JSON.stringify(this.status)) as RunnerStatus;
  }
}
