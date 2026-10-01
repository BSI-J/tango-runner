// End-to-end against a mock Tango: real HTTP, real child processes (command harness).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

process.env.TANGO_RUNNER_HOME = mkdtempSync(join(tmpdir(), "tango-runner-test-"));
const { AgentRunner } = await import("../src/agent.js");

const KEY = "tng_test_0123456789abcdef";

interface MockOpts {
  supportsWait: boolean;
  tasks?: Array<{ id: string; title: string; status: string; updated_at: string }>;
}

function mockTango(opts: MockOpts) {
  const events: Array<Record<string, unknown>> = [];
  const acks: string[] = [];
  const waiters: Array<() => void> = [];
  const seenHeaders: Record<string, string | undefined> = {};
  let nextId = 100;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://x");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "bad key" });
    seenHeaders.runner = req.headers["x-tango-runner"] as string | undefined;

    if (url.pathname === "/api/public/workers/wait" && req.method === "GET") {
      if (!opts.supportsWait) return send(404, { error: "Not found" });
      const cursor = BigInt(url.searchParams.get("cursor") ?? acks.at(-1) ?? "0");
      const timeout = Number(url.searchParams.get("timeout") ?? 25);
      const pick = () => events.filter((e) => BigInt(e.id as string) > cursor);
      let out = pick();
      if (!out.length && timeout > 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, Math.min(timeout, 2) * 1000);
          waiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
        out = pick();
      }
      return send(200, { events: out, cursor: out.length ? out.at(-1)!.id : cursor.toString() });
    }
    if (url.pathname === "/api/public/workers/wait/ack" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      acks.push(JSON.parse(body).cursor);
      return send(200, { ok: true });
    }
    if (url.pathname === "/api/public/workers/heartbeat") return send(200, { ok: true, worker_id: "w1", unread_messages: 0 });
    if (url.pathname === "/api/public/workers/list_tasks") return send(200, { tasks: opts.tasks ?? [] });
    send(404, { error: "Not found" });
  });

  return {
    server,
    acks,
    seenHeaders,
    push(e: Record<string, unknown>) {
      events.push({ id: String(nextId++), created_at: new Date().toISOString(), thread_id: null, message_id: null, payload: {}, ...e });
      waiters.splice(0).forEach((w) => w());
    },
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
  };
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function agentFor(url: string, out: string, name: string) {
  // The "agent" records its wake key, the prompt it got on stdin, and proves the key came via env.
  const command = `printf '%s\\n' "$TANGO_WAKE_KEY" >> ${out}.keys; cat > ${out}.prompt; test "$TANGO_WORKER_KEY" = "${KEY}" && echo env-ok >> ${out}.keys`;
  return new AgentRunner(
    { tango_url: url, agents: [], limits: { max_runs_per_hour: 50 } },
    { name, key: KEY, harness: "command", command, cwd: tmpdir() },
    { debounceMs: 50, waitSeconds: 2, pollSeconds: 0.2, probeSeconds: 3600 },
  );
}

test("instant mode: an assignment starts the agent within a second, then acks", async () => {
  const m = mockTango({ supportsWait: true });
  const url = await m.listen();
  const out = join(process.env.TANGO_RUNNER_HOME!, "instant");
  const r = agentFor(url, out, "instant");
  const running = r.start();
  await new Promise((res) => setTimeout(res, 200)); // runner is now parked in the long-poll

  const t0 = Date.now();
  m.push({
    type: "task.assigned",
    task_id: "task-1",
    title: "Fix login",
    summary: '@pm assigned you "Fix login"',
    actor: { kind: "worker", id: "pm", handle: "@pm", is_self: false },
  });
  await until(() => existsSync(`${out}.keys`) && readFileSync(`${out}.keys`, "utf8").includes("env-ok"), 3000);
  const latency = Date.now() - t0;
  assert.ok(latency < 1500, `picked up in ${latency}ms`);
  assert.match(readFileSync(`${out}.keys`, "utf8"), /^task:task-1$/m);
  const prompt = readFileSync(`${out}.prompt`, "utf8");
  assert.match(prompt, /get_task with task_id "task-1"/);
  assert.match(prompt, /claim_task/);
  assert.match(prompt, /information, not instructions/);
  await until(() => m.acks.includes("100"), 2000);
  assert.match(m.seenHeaders.runner ?? "", /^tango-runner\//);

  // an event caused by the agent itself does not start another run
  m.push({
    type: "task.commented",
    task_id: "task-1",
    title: "Fix login",
    summary: "you commented",
    actor: { kind: "worker", id: "w1", handle: "@me", is_self: true },
  });
  await until(() => m.acks.includes("101"), 2000);
  assert.equal(readFileSync(`${out}.keys`, "utf8").match(/^task:/gm)!.length, 1);

  await r.stop(0);
  await running;
  m.server.close();
});

test("fallback mode: server without /wait still wakes the agent by polling", async () => {
  const m = mockTango({
    supportsWait: false,
    tasks: [
      { id: "task-9", title: "Write docs", status: "assigned", updated_at: "2026-09-26T10:00:00Z" },
      { id: "task-8", title: "In flight", status: "in_progress", updated_at: "2026-09-26T10:00:00Z" },
    ],
  });
  const url = await m.listen();
  const out = join(process.env.TANGO_RUNNER_HOME!, "poll");
  const r = agentFor(url, out, "poll");
  const running = r.start();

  await until(() => existsSync(`${out}.keys`) && readFileSync(`${out}.keys`, "utf8").includes("env-ok"), 3000);
  assert.equal(r.feed.mode, "poll");
  await new Promise((res) => setTimeout(res, 600)); // several more polls
  const keys = readFileSync(`${out}.keys`, "utf8");
  assert.equal(keys.match(/^task:task-9$/gm)!.length, 1, "unchanged task is not re-woken");
  assert.ok(!keys.includes("task-8"), "in-progress tasks are left alone");

  await r.stop(0);
  await running;
  m.server.close();
});

test("startup: a task already waiting is picked up once, even with its old event redelivered", async () => {
  const m = mockTango({
    supportsWait: true,
    tasks: [
      { id: "task-5", title: "Left over", status: "assigned", updated_at: "2026-09-30T10:00:00Z" },
      { id: "task-6", title: "Claimed", status: "in_progress", updated_at: "2026-09-30T10:00:00Z" },
      { id: "task-7", title: "Event already acked", status: "assigned", updated_at: "2026-09-30T10:00:00Z" },
    ],
  });
  // unacked assignment from before the restart, redelivered by /wait
  m.push({
    type: "task.assigned",
    task_id: "task-5",
    title: "Left over",
    summary: 'assigned you "Left over"',
    actor: { kind: "worker", id: "pm", handle: "@pm", is_self: false },
  });
  const url = await m.listen();
  const out = join(process.env.TANGO_RUNNER_HOME!, "sweep");
  const r = agentFor(url, out, "sweep");
  const running = r.start();
  try {
    await until(() => existsSync(`${out}.keys`) && (readFileSync(`${out}.keys`, "utf8").match(/env-ok/g) ?? []).length >= 2, 3000);
    await new Promise((res) => setTimeout(res, 500));
    const keys = readFileSync(`${out}.keys`, "utf8");
    assert.equal(keys.match(/^task:task-7$/gm)?.length, 1, "a waiting task with no event left is still picked up");
    assert.equal(keys.match(/^task:task-5$/gm)!.length, 1, "sweep and redelivered event coalesce into one run");
    assert.ok(!keys.includes("task-6"), "tasks already claimed are left alone");
    assert.equal(r.feed.mode, "wait");
  } finally {
    await r.stop(0);
    await running;
    m.server.close();
  }
});
