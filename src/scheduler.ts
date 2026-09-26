import { log } from "./log.js";
import type { WakeEvent } from "./types.js";

/** Event types that mean "you have something to do". Everything else is ignored by default. */
export const DEFAULT_WAKE_TYPES = new Set([
  "task.assigned",
  "task.mentioned",
  "task.commented",
  "task.handoff_received",
  "task.changes_requested",
  "task.question_answered",
  "task.unblocked",
  "task.unparked",
  "task.rerouted",
  "task.escalated",
  "task.deadline_soon",
  "task.stale",
  "message.received",
]);

/** One run per task / thread at a time; events for the same key coalesce. */
export function keyFor(e: WakeEvent): string {
  if (e.task_id) return `task:${e.task_id}`;
  if (e.thread_id) return `thread:${e.thread_id}`;
  if (e.type === "message.received") return "inbox";
  return `event:${e.id}`;
}

export interface SchedulerOptions {
  agentName: string;
  maxConcurrent: number;
  maxRunsPerHour: number;
  /** Consecutive follow-up runs fed only by events that arrived while the previous run was active. */
  maxSelfFollowups: number;
  /** Wait this long after the first event for a key, so bursts (assign + comment) become one run. */
  debounceMs: number;
  wakeTypes?: Set<string>;
  run: (key: string, events: WakeEvent[]) => Promise<void>;
  /** Called with the highest cursor whose events (and all before it) are finished. */
  onAck: (cursor: string) => void;
  now?: () => number;
}

interface Pending {
  events: WakeEvent[];
  /** At least one event arrived while a run for this key was active. */
  duringRun: boolean;
  readyAt: number;
}

export class Scheduler {
  private inFlight = new Set<bigint>();
  /** Finished, but not yet covered by the ack watermark (a lower id is still running). */
  private doneAboveAck = new Set<bigint>();
  private maxSeen = 0n;
  private lastAcked = 0n;
  private pending = new Map<string, Pending>();
  private active = new Set<string>();
  private streak = new Map<string, number>();
  private runStarts: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];
  private now: () => number;
  private wakeTypes: Set<string>;

  constructor(private o: SchedulerOptions) {
    this.now = o.now ?? Date.now;
    this.wakeTypes = o.wakeTypes ?? DEFAULT_WAKE_TYPES;
  }

  receive(events: WakeEvent[]): void {
    for (const e of events) {
      const id = e.synthetic ? null : parseId(e.id);
      if (id !== null) {
        if (id <= this.lastAcked || this.inFlight.has(id) || this.doneAboveAck.has(id)) continue; // redelivery
        this.inFlight.add(id);
        if (id > this.maxSeen) this.maxSeen = id;
      }
      if (e.actor?.is_self) {
        log("debug", this.o.agentName, `skip ${e.type} ${e.id}: caused by this agent`);
        this.done(id);
        continue;
      }
      if (!this.wakeTypes.has(e.type)) {
        log("debug", this.o.agentName, `skip ${e.type} ${e.id}: not a wake type`);
        this.done(id);
        continue;
      }
      const key = keyFor(e);
      const p = this.pending.get(key) ?? { events: [], duringRun: false, readyAt: this.now() + this.o.debounceMs };
      p.events.push(e);
      if (this.active.has(key)) p.duringRun = true;
      this.pending.set(key, p);
    }
    this.pump();
  }

  /** Resolves when nothing is running or queued (for tests and graceful shutdown). */
  idle(): Promise<void> {
    if (this.active.size === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  get activeCount(): number {
    return this.active.size;
  }

  private pump(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    let nextAt = Infinity;

    for (const [key, p] of this.pending) {
      if (this.active.has(key)) continue; // follow-up waits for the current run
      if (p.readyAt > now) {
        nextAt = Math.min(nextAt, p.readyAt);
        continue;
      }
      if (this.active.size >= this.o.maxConcurrent) break;
      this.runStarts = this.runStarts.filter((t) => now - t < 3_600_000);
      if (this.runStarts.length >= this.o.maxRunsPerHour) {
        const freeAt = this.runStarts[0] + 3_600_000;
        log("warn", this.o.agentName, `hit ${this.o.maxRunsPerHour} runs/hour; next run at ${new Date(freeAt).toISOString()}`);
        nextAt = Math.min(nextAt, freeAt);
        break;
      }

      this.pending.delete(key);
      const s = p.duringRun ? (this.streak.get(key) ?? 0) + 1 : 0;
      this.streak.set(key, s);
      if (s > this.o.maxSelfFollowups) {
        log(
          "warn",
          this.o.agentName,
          `${key}: ${s} follow-ups in a row triggered during its own runs; looks like a loop, waiting for fresh activity`,
        );
        for (const e of p.events) this.done(e.synthetic ? null : parseId(e.id));
        continue;
      }
      this.start(key, p.events);
    }

    if (nextAt !== Infinity) this.timer = setTimeout(() => this.pump(), Math.max(0, nextAt - now));
    this.maybeIdle();
  }

  private start(key: string, events: WakeEvent[]): void {
    this.active.add(key);
    this.runStarts.push(this.now());
    this.o
      .run(key, events)
      .catch((err: unknown) => log("error", this.o.agentName, `${key}: run failed: ${(err as Error).message}`))
      .finally(() => {
        this.active.delete(key);
        for (const e of events) this.done(e.synthetic ? null : parseId(e.id));
        this.pump();
      });
  }

  private done(id: bigint | null): void {
    if (id === null) return;
    if (!this.inFlight.delete(id)) return;
    this.doneAboveAck.add(id);
    let mark = this.maxSeen;
    for (const f of this.inFlight) if (f - 1n < mark) mark = f - 1n;
    if (mark > this.lastAcked) {
      this.lastAcked = mark;
      for (const d of this.doneAboveAck) if (d <= mark) this.doneAboveAck.delete(d);
      this.o.onAck(mark.toString());
    }
  }

  private maybeIdle(): void {
    if (this.active.size === 0 && this.pending.size === 0) {
      const w = this.idleWaiters.splice(0);
      for (const r of w) r();
    }
  }
}

function parseId(id: string): bigint | null {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}
