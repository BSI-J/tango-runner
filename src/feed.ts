import { HttpError, type TaskRow, type TangoClient } from "./client.js";
import { log } from "./log.js";
import type { WakeEvent } from "./types.js";

export interface FeedOptions {
  agentName: string;
  client: TangoClient;
  onEvents: (events: WakeEvent[]) => void;
  /** Long-poll timeout (server clamps). */
  waitSeconds?: number;
  /** Fallback polling interval when the server has no /wait yet. */
  pollSeconds?: number;
  /** How often to re-check for /wait while in fallback mode. */
  probeSeconds?: number;
  /** On start, wake for tasks already waiting for this agent. Default true. */
  sweepOnStart?: boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Task statuses that mean "waiting for its assignee to start". */
const STARTABLE = new Set(["assigned", "queued", "escalated"]);

/**
 * Delivers wake events for one agent. Prefers the server long-poll
 * (GET /workers/wait, events in ~1s). If the server predates it (404), falls
 * back to polling list_tasks + heartbeat and synthesizing events, and keeps
 * probing so it upgrades itself once /wait ships.
 */
export class Feed {
  mode: "wait" | "poll" = "wait";
  private cursor: string | null = null;
  private seenTasks = new Map<string, string>(); // task id -> updated_at|status
  private lastUnread = 0;
  private synthSeq = 0;
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private o: FeedOptions) {
    this.sleep = o.sleep ?? abortableSleep;
  }

  async run(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    let nextProbe = 0;
    await this.sweepOnStart();
    while (!signal.aborted) {
      try {
        if (this.mode === "poll" && Date.now() >= nextProbe) {
          if (await this.probeWait(signal)) {
            log("info", this.o.agentName, "server supports /wait now; switching to instant wake");
            this.mode = "wait";
            continue;
          }
          nextProbe = Date.now() + (this.o.probeSeconds ?? 300) * 1000;
        }
        if (this.mode === "wait") await this.waitOnce(signal);
        else {
          await this.pollOnce();
          await this.sleep((this.o.pollSeconds ?? 20) * 1000, signal);
        }
        backoff = 1000;
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof HttpError && err.status === 404 && this.mode === "wait") {
          log("info", this.o.agentName, `server has no /wait yet; polling every ${this.o.pollSeconds ?? 20}s until it does`);
          this.mode = "poll";
          nextProbe = Date.now() + (this.o.probeSeconds ?? 300) * 1000;
          continue;
        }
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          log("error", this.o.agentName, `key rejected (${err.status}). Issue a new tng_ key and update the config. Stopping this agent.`);
          return;
        }
        const wait = err instanceof HttpError && err.retryAfterMs ? err.retryAfterMs : backoff;
        log("warn", this.o.agentName, `${(err as Error).message}; retrying in ${Math.round(wait / 1000)}s`);
        await this.sleep(wait, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async waitOnce(signal: AbortSignal): Promise<void> {
    const res = await this.o.client.wait(this.cursor, this.o.waitSeconds ?? 25, signal);
    if (res.paused) {
      log("info", this.o.agentName, "worker is paused in Tango; idling");
      await this.sleep(30_000, signal);
      return;
    }
    if (res.cursor) this.cursor = res.cursor;
    if (res.events?.length) this.o.onEvents(res.events);
  }

  private async probeWait(signal: AbortSignal): Promise<boolean> {
    try {
      await this.o.client.wait(this.cursor, 0, signal);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Wake events are acked once handled, even when the run failed (bad cwd,
   * missing binary). So after a fix and a restart nothing would redeliver
   * them; tasks still waiting for this agent are picked up here instead.
   * Events /wait returns for the same task coalesce with these in the scheduler.
   */
  private async sweepOnStart(): Promise<void> {
    if (this.o.sweepOnStart === false) return;
    try {
      const events = this.taskEvents(await this.o.client.listMyTasks());
      if (events.length) {
        log("info", this.o.agentName, `${events.length} task${events.length === 1 ? "" : "s"} already waiting for this agent`);
        this.o.onEvents(events);
      }
    } catch (err) {
      log("warn", this.o.agentName, `startup check for waiting tasks failed: ${(err as Error).message}`);
    }
  }

  /** Fallback: diff my task list and unread count against the last poll. */
  async pollOnce(): Promise<void> {
    const [tasks, hb] = await Promise.all([this.o.client.listMyTasks(), this.o.client.heartbeat()]);
    const events = this.taskEvents(tasks);

    const unread = hb.unread_messages ?? 0;
    if (unread > this.lastUnread) {
      events.push({
        id: `poll-${++this.synthSeq}`,
        type: "message.received",
        created_at: new Date().toISOString(),
        task_id: null,
        thread_id: null,
        message_id: null,
        actor: { kind: "system", id: null, handle: null, is_self: false },
        title: null,
        summary: `${unread} unread message${unread === 1 ? "" : "s"} from other agents`,
        payload: { unread },
        synthetic: true,
      });
    }
    this.lastUnread = unread;
    if (events.length) this.o.onEvents(events);
  }

  /** Startable tasks that are new or changed since the last look. */
  private taskEvents(tasks: TaskRow[]): WakeEvent[] {
    const events: WakeEvent[] = [];
    const live = new Set<string>();
    for (const t of tasks) {
      live.add(t.id);
      const status = (t.status ?? "").toLowerCase();
      const sig = `${t.updated_at ?? ""}|${status}`;
      const prev = this.seenTasks.get(t.id);
      this.seenTasks.set(t.id, sig);
      if (!STARTABLE.has(status) || prev === sig) continue;
      events.push(this.synth("task.assigned", t, prev === undefined ? "assigned to you" : "updated and waiting for you"));
    }
    for (const id of this.seenTasks.keys()) if (!live.has(id)) this.seenTasks.delete(id);
    return events;
  }

  private synth(type: string, t: TaskRow, what: string): WakeEvent {
    return {
      id: `poll-${++this.synthSeq}`,
      type,
      created_at: new Date().toISOString(),
      task_id: t.id,
      thread_id: null,
      message_id: null,
      actor: { kind: "system", id: null, handle: null, is_self: false },
      title: t.title ?? null,
      summary: `"${t.title ?? t.id}" is ${what}`,
      payload: { status: t.status },
      synthetic: true,
    };
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
