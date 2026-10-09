import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { buildSpawn, parseOutput } from "./adapters/index.js";
import { TangoClient } from "./client.js";
import { expandHome, resolveKey, stateDir } from "./config.js";
import { execRun } from "./exec.js";
import { Feed } from "./feed.js";
import { log } from "./log.js";
import { buildPrompt, rulesFor } from "./prompt.js";
import { Scheduler } from "./scheduler.js";
import { SessionStore } from "./state.js";
import type { AgentConfig, RunnerConfig, WakeEvent } from "./types.js";

/** One configured agent: its feed, its scheduler, and how it runs. */
export class AgentRunner {
  readonly client: TangoClient;
  readonly feed: Feed;
  readonly scheduler: Scheduler;
  private key: string;
  private sessions: SessionStore;
  private ackChain: Promise<unknown> = Promise.resolve();
  private runSeq = 0;
  /** Ends the long-poll / polling loop. */
  private feedAbort = new AbortController();
  /** Kills in-flight agent runs. */
  private runAbort = new AbortController();
  /** Where this agent's key lives, so `tango` can find it if a harness strips the env. */
  private configPath?: string;

  constructor(
    private cfg: RunnerConfig,
    private agent: AgentConfig,
    opts: { debounceMs?: number; waitSeconds?: number; pollSeconds?: number; probeSeconds?: number; configPath?: string } = {},
  ) {
    this.configPath = opts.configPath;
    this.key = resolveKey(agent);
    this.client = new TangoClient(cfg.tango_url, this.key, { host: hostname(), harness: agent.harness });
    this.sessions = new SessionStore(join(stateDir(), "sessions", `${safe(agent.name)}.json`));
    this.scheduler = new Scheduler({
      agentName: agent.name,
      maxConcurrent: agent.max_concurrent ?? 1,
      maxRunsPerHour: cfg.limits?.max_runs_per_hour ?? 30,
      maxSelfFollowups: cfg.limits?.max_self_followups ?? 2,
      debounceMs: opts.debounceMs ?? 1500,
      wakeTypes: agent.events ? new Set(agent.events) : undefined,
      run: (key, events) => this.runOnce(key, events),
      onAck: (cursor) => this.ack(cursor),
    });
    this.feed = new Feed({
      agentName: agent.name,
      client: this.client,
      onEvents: (events) => {
        for (const e of events) log("info", agent.name, `wake: ${e.type} ${e.summary}`);
        this.scheduler.receive(events);
      },
      waitSeconds: opts.waitSeconds,
      pollSeconds: opts.pollSeconds ?? cfg.poll_seconds,
      probeSeconds: opts.probeSeconds,
    });
  }

  get name(): string {
    return this.agent.name;
  }

  async start(): Promise<void> {
    await this.feed.run(this.feedAbort.signal);
  }

  /** Stop listening, let current runs finish (up to graceMs), then kill whatever is left. */
  async stop(graceMs = 0): Promise<void> {
    this.feedAbort.abort();
    this.scheduler.stop();
    if (graceMs > 0) await Promise.race([this.scheduler.idle(), new Promise((r) => setTimeout(r, graceMs))]);
    this.runAbort.abort();
    await this.ackChain;
  }

  private ack(cursor: string): void {
    // Serialize acks; the server keeps the max, so order only matters for tidiness.
    this.ackChain = this.ackChain
      .then(() => this.client.ack(cursor))
      .then(() => log("debug", this.agent.name, `acked ${cursor}`))
      .catch((err: Error) => log("warn", this.agent.name, `ack ${cursor} failed: ${err.message}`));
  }

  private async runOnce(key: string, events: WakeEvent[]): Promise<void> {
    const a = this.agent;
    const sessionKey = key === "inbox" || key.startsWith("event:") ? null : key;
    const sessionId = sessionKey ? this.sessions.get(sessionKey) : undefined;
    const n = ++this.runSeq;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = join(stateDir(), "runs", safe(a.name));
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const logFile = join(stateDir(), "logs", safe(a.name), `${stamp}-${safe(key)}.log`);

    const spec = buildSpawn({
      agent: a,
      tangoUrl: this.cfg.tango_url,
      key: this.key,
      prompt: buildPrompt(events, !!sessionId),
      systemRules: rulesFor(a.harness),
      sessionId,
      eventsJson: JSON.stringify(events),
      wakeKey: key,
      runDir,
      configPath: this.configPath,
    });

    log("info", a.name, `run #${n} ${key} (${events.length} event${events.length === 1 ? "" : "s"})${sessionId ? " resuming session" : ""} → ${logFile}`);
    const t0 = Date.now();
    const res = await execRun(spec, {
      cwd: expandHome(a.cwd),
      logFile,
      timeoutMs: (a.timeout_minutes ?? 30) * 60_000,
      signal: this.runAbort.signal,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const out = parseOutput(a, res.stdout);

    if (sessionKey) {
      if (out.sessionId) this.sessions.set(sessionKey, out.sessionId);
      else if (sessionId && res.exitCode !== 0) this.sessions.delete(sessionKey); // stale session; start fresh next time
    }
    const status = res.timedOut ? "timed out" : res.exitCode === 0 ? "done" : `exit ${res.exitCode}`;
    log(res.exitCode === 0 ? "info" : "warn", a.name, `run #${n} ${key} ${status} in ${secs}s${out.summary ? `: ${oneLine(out.summary)}` : ""}`);
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function oneLine(s: string): string {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > 160 ? l.slice(0, 157) + "..." : l;
}
