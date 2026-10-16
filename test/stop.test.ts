// Remote stop: a person stops this agent on a task in Tango, and the next
// heartbeat response carries `stop_tasks`. Real runner, real child processes,
// mock Tango.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.TANGO_RUNNER_HOME = mkdtempSync(join(tmpdir(), "tango-stop-test-"));
const { AgentRunner } = await import("../src/agent.js");

const KEY = "tng_stop_test_0123456789";
const HOME = process.env.TANGO_RUNNER_HOME!;
const posix = process.platform !== "win32";

type Stop = { task_id: string; stopped_at: string } | string;

function mockTango() {
  const events: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  let acked = 0;
  let heartbeats = 0;
  /** Delivered once each, like Tango (it marks them acknowledged as it sends them). */
  const stopOnce: Stop[] = [];
  /** Sent on every heartbeat, to check repeats are harmless. */
  let stopAlways: Stop[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    paths.push(url.pathname);
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/public/workers/wait") {
      const out = events.filter((e) => Number(e.id) > acked);
      if (!out.length) await new Promise((r) => setTimeout(r, 200));
      return send({ events: out, cursor: String(out.length ? out.at(-1)!.id : acked) });
    }
    if (url.pathname === "/api/public/workers/wait/ack") {
      acked = Math.max(acked, Number(JSON.parse(raw).cursor));
      return send({ ok: true });
    }
    if (url.pathname === "/api/public/workers/heartbeat") {
      heartbeats++;
      const stops = [...stopOnce.splice(0), ...stopAlways];
      return send({ ok: true, worker_id: "w1", ...(stops.length ? { stop_tasks: stops, stop_notice: "A person stopped you on these tasks." } : {}) });
    }
    if (url.pathname === "/api/public/workers/list_tasks") return send({ tasks: [] });
    res.writeHead(404).end();
  });
  return {
    paths,
    get heartbeats() {
      return heartbeats;
    },
    stop(...s: Stop[]) {
      stopOnce.push(...s);
    },
    stopEveryHeartbeat(s: Stop[]) {
      stopAlways = s;
    },
    push(taskId: string) {
      events.push({
        id: String(events.length + 1),
        type: "task.assigned",
        task_id: taskId,
        thread_id: null,
        message_id: null,
        created_at: new Date().toISOString(),
        title: "Work",
        summary: "assigned",
        actor: { kind: "user", id: "u", handle: "@pm", is_self: false },
        payload: {},
      });
    },
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => server.close(),
  };
}

/** Collect the runner's log lines for the duration of a test. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const tap = (orig: typeof process.stdout.write) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = tap(orig.out);
  process.stderr.write = tap(orig.err);
  return { lines, restore: () => ((process.stdout.write = orig.out), (process.stderr.write = orig.err)) };
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const task = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function runner(url: string, name: string, agent: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  return new AgentRunner(
    { tango_url: url, agents: [] },
    { name, key: KEY, harness: "command", cwd: tmpdir(), ...agent } as never,
    { debounceMs: 50, waitSeconds: 1, probeSeconds: 3600, heartbeatSeconds: { active: 0.1, idle: 0.1 }, killGraceMs: 300, ...opts },
  );
}

test("a stop for a running task kills its process; nothing is reported back and heartbeats go on", { skip: !posix }, async () => {
  const m = mockTango();
  const url = await m.listen();
  const out = join(HOME, "running");
  // Marks that it started, then would mark completion 30s later.
  const r = runner(url, "running", { command: `touch ${out}.started; sleep 30; touch ${out}.finished` });
  const logs = captureLogs();
  const running = r.start();
  try {
    m.push(task(1));
    await until(() => existsSync(`${out}.started`), 3000, "the run to start");
    const t0 = Date.now();
    m.stop({ task_id: task(1), stopped_at: new Date().toISOString() });
    await until(() => logs.lines.some((l) => l.includes("result discarded")), 3000, "the run to end");
    assert.ok(Date.now() - t0 < 2000, "killed promptly");
    assert.ok(!existsSync(`${out}.finished`), "the process never got to finish");
    assert.ok(logs.lines.some((l) => l.includes(`stop received for task ${task(1)}: terminating run #1`)));
    assert.ok(logs.lines.some((l) => /run #1 task:\S+ stopped in Tango: terminated after \d+s; result discarded/.test(l)));

    const before = m.heartbeats;
    await until(() => m.heartbeats >= before + 3, 2000, "heartbeats after the stop");
    // The runner only ever talks to the wake feed and heartbeat; no completion, comment or tool call.
    assert.deepEqual(
      [...new Set(m.paths)].sort(),
      ["/api/public/workers/heartbeat", "/api/public/workers/list_tasks", "/api/public/workers/wait", "/api/public/workers/wait/ack"],
    );
  } finally {
    logs.restore();
    await r.stop(0);
    await running;
    m.close();
  }
});

test("a stop for a task that isn't running is ignored, and the runner keeps working", { skip: !posix }, async () => {
  const m = mockTango();
  const url = await m.listen();
  const out = join(HOME, "unknown");
  const r = runner(url, "unknown", { command: `printf '%s\\n' "$TANGO_WAKE_KEY" >> ${out}.keys` });
  const logs = captureLogs();
  const running = r.start();
  try {
    m.stop(task(9), { task_id: task(8), stopped_at: "2026-10-15T00:00:00Z" }, "", { nonsense: true } as never);
    await until(() => logs.lines.some((l) => l.includes(`stop received for task ${task(8)}: not running`)), 2000, "the stop to be seen");
    m.push(task(2));
    await until(() => existsSync(`${out}.keys`), 3000, "a later run");
    assert.equal(readFileSync(`${out}.keys`, "utf8").trim(), `task:${task(2)}`);
  } finally {
    logs.restore();
    await r.stop(0);
    await running;
    m.close();
  }
});

test("a run that ignores SIGTERM is force-killed after the grace period", { skip: !posix }, async () => {
  const m = mockTango();
  const url = await m.listen();
  const out = join(HOME, "stubborn");
  const r = runner(url, "stubborn", { command: `trap '' TERM; touch ${out}.started; sleep 30` });
  const logs = captureLogs();
  const running = r.start();
  try {
    m.push(task(3));
    await until(() => existsSync(`${out}.started`), 3000, "the run to start");
    m.stop(task(3));
    await until(() => logs.lines.some((l) => l.includes("result discarded")), 3000, "the forced kill");
    assert.ok(logs.lines.some((l) => l.includes("force-killed after ignoring SIGTERM")));
  } finally {
    logs.restore();
    await r.stop(0);
    await running;
    m.close();
  }
});

test("a result written as the stop lands is discarded: no session is kept", { skip: !posix }, async () => {
  const m = mockTango();
  const url = await m.listen();
  const out = join(HOME, "midwrite");
  // A fake `claude` that, when told to stop, writes a complete result (with a session id) and exits 0.
  const bin = join(HOME, "fake-claude");
  writeFileSync(
    bin,
    `#!/bin/sh\ntrap 'echo "{\\"type\\":\\"result\\",\\"session_id\\":\\"sess-stopped\\",\\"result\\":\\"all done\\"}"; exit 0' TERM\ntouch ${out}.started\nsleep 30 &\nwait\n`,
  );
  chmodSync(bin, 0o755);
  const r = runner(url, "midwrite", { harness: "claude", bin });
  const logs = captureLogs();
  const running = r.start();
  try {
    m.push(task(4));
    await until(() => existsSync(`${out}.started`), 3000, "the run to start");
    m.stop(task(4));
    await until(() => logs.lines.some((l) => l.includes("result discarded")), 3000, "the run to end");
    assert.ok(logs.lines.some((l) => /stopped in Tango: ended \(exit 0\)/.test(l)), "it exited cleanly with a result");
    const sessions = JSON.parse(readFileSync(join(HOME, "sessions", "midwrite.json"), "utf8"));
    assert.equal(sessions[`task:${task(4)}`], undefined, "the stopped run's session is not kept");
    assert.ok(!logs.lines.some((l) => l.includes("all done")), "its summary is not reported");
  } finally {
    logs.restore();
    await r.stop(0);
    await running;
    m.close();
  }
});

test("the same stop on every heartbeat terminates the run once", { skip: !posix }, async () => {
  const m = mockTango();
  const url = await m.listen();
  const out = join(HOME, "repeat");
  const r = runner(url, "repeat", { command: `touch ${out}.started; sleep 30` }, { killGraceMs: 1000 });
  const logs = captureLogs();
  const running = r.start();
  try {
    m.push(task(5));
    await until(() => existsSync(`${out}.started`), 3000, "the run to start");
    m.stopEveryHeartbeat([task(5)]);
    await until(() => logs.lines.some((l) => l.includes("result discarded")), 3000, "the run to end");
    const before = m.heartbeats;
    await until(() => m.heartbeats >= before + 3, 2000, "more heartbeats with the same stop");
    assert.equal(logs.lines.filter((l) => l.includes("terminating run")).length, 1);
    assert.equal(logs.lines.filter((l) => l.includes("result discarded")).length, 1);
  } finally {
    m.stopEveryHeartbeat([]);
    logs.restore();
    await r.stop(0);
    await running;
    m.close();
  }
});

test("a stop before a queued wake starts means it never runs", { skip: !posix }, async () => {
  const m = mockTango();
  const url = await m.listen();
  const out = join(HOME, "queued");
  const r = runner(url, "queued", { command: `touch ${out}.ran` }, { debounceMs: 1500 });
  const logs = captureLogs();
  const running = r.start();
  try {
    m.push(task(6));
    await until(() => logs.lines.some((l) => l.includes("wake: task.assigned")), 2000, "the wake");
    m.stop(task(6));
    await until(() => logs.lines.some((l) => l.includes("dropped its queued wake")), 2000, "the stop");
    await new Promise((res) => setTimeout(res, 1800)); // past the debounce
    assert.ok(!existsSync(`${out}.ran`));
  } finally {
    logs.restore();
    await r.stop(0);
    await running;
    m.close();
  }
});
