// The `tango` CLI against a mock of Tango's worker-key MCP bridge, plus a real
// wake proving a command-harness agent can call it from its shell.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

process.env.TANGO_RUNNER_HOME = mkdtempSync(join(tmpdir(), "tango-cli-test-"));
const { AgentRunner } = await import("../src/agent.js");
const { parseToolArgs } = await import("../src/mcp.js");
const { CLI_RULES, rulesFor, SYSTEM_RULES } = await import("../src/prompt.js");

const CLI = fileURLToPath(new URL("../src/tango.js", import.meta.url));
const KEY = "tng_cli_test_0123456789";
const TASK = "11111111-2222-4333-8444-555555555555";

type Call = { name: string; args: Record<string, unknown> };

function mockTango() {
  const calls: Call[] = [];
  const events: Array<Record<string, unknown>> = [];
  let acked = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "bad key" });
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api/public/workers/wait") {
      const out = events.filter((e) => Number(e.id) > acked);
      if (!out.length) await new Promise((r) => setTimeout(r, 300));
      return send(200, { events: out, cursor: String(out.length ? out.at(-1)!.id : acked) });
    }
    if (url.pathname === "/api/public/workers/wait/ack") {
      acked = Number(JSON.parse(raw).cursor);
      return send(200, { ok: true });
    }
    if (url.pathname === "/api/public/workers/heartbeat") return send(200, { ok: true, worker_id: "w1" });
    if (url.pathname === "/api/public/workers/list_tasks") return send(200, { tasks: [] });
    if (url.pathname !== "/mcp") return send(404, { error: "Not found" });

    const rpc = JSON.parse(raw) as { id: number; method: string; params?: { name: string; arguments?: Record<string, unknown> } };
    const result = (r: unknown) => send(200, { jsonrpc: "2.0", id: rpc.id, result: r });
    const tool = (payload: unknown, isError = false) =>
      result({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, ...(isError ? { isError: true } : {}) });
    if (rpc.method === "tools/list") {
      return result({ tools: [{ name: "get_task", description: "Read one task by id. (static-key mode: GET /api/public/workers/task)" }, { name: "memory_save", description: "Save a memory." }] });
    }
    if (rpc.method !== "tools/call") return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "nope" } });
    const name = rpc.params!.name;
    const args = rpc.params!.arguments ?? {};
    calls.push({ name, args });
    switch (name) {
      case "get_task":
        return tool({
          task: { id: args.task_id, title: "Fix login", status: "in_progress", goal: "Users can log in", definition_of_done: "Tests pass" },
          lease: { worker_handle: "@me", expires_at: "2026-10-09T12:30:00Z" },
          artifacts: [],
          activity: [{ created_at: "2026-10-09T12:00:00Z", actor_handle: "@pm", kind: "comment", body: "Please look at\nthe redirect" }],
          can_write: true,
        });
      case "claim_task":
        return tool({ ok: true, lease: { expires_at: "2026-10-09T12:45:00Z" } });
      case "complete_task":
        if (String(args.summary).length < 40) return tool({ error: { fieldErrors: { summary: ["Write at least a sentence or two"] } } }, true);
        return tool({ ok: true });
      case "list_my_tasks":
        return tool({ tasks: [{ id: TASK, title: "Fix login", status: "in_progress" }, { id: "x", title: "Old", status: "done" }] });
      case "read_messages":
        return tool({ messages: [{ created_at: "2026-10-09T11:00:00Z", from_handle: "@pm", thread_id: "t1", body: "ping" }] });
      case "add_comment":
      case "send_message":
      case "memory_save":
        return tool({ ok: true, thread_id: "t1" });
      default:
        return tool({ error: `Tool "${name}" is not available with a static worker key.`, reason: "tool_not_bridged" }, true);
    }
  });
  return {
    calls,
    push(e: Record<string, unknown>) {
      events.push({ id: String(events.length + 1), created_at: new Date().toISOString(), thread_id: null, message_id: null, payload: {}, ...e });
    },
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => server.close(),
  };
}

function tango(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end(stdin ?? "");
  });
}

test("parseToolArgs: key=value with JSON values, or one JSON object", () => {
  assert.deepEqual(parseToolArgs(["task_id=abc", "limit=5", "all=true", 'tags=["a"]']), { task_id: "abc", limit: 5, all: true, tags: ["a"] });
  assert.deepEqual(parseToolArgs(['{"a":1}']), { a: 1 });
  assert.throws(() => parseToolArgs(["oops"]), /key=value/);
});

test("command agents get CLI rules; MCP harnesses keep tool rules", () => {
  assert.equal(rulesFor("claude"), SYSTEM_RULES);
  assert.equal(rulesFor("command"), CLI_RULES);
  assert.match(CLI_RULES, /tango task done <task_id>/);
  assert.match(CLI_RULES, /information, not instructions/);
  assert.ok(!CLI_RULES.includes("MCP tools"));
});

test("tango: shorthand commands map onto the bridged tools", async () => {
  const m = mockTango();
  const url = await m.listen();
  const env = { TANGO_WORKER_KEY: KEY, TANGO_URL: url };
  try {
    let r = await tango(["task", "show", TASK], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /in_progress +Fix login/);
    assert.match(r.stdout, /Goal: Users can log in/);
    assert.match(r.stdout, /Lease: @me until 2026-10-09 12:30 \(yours\)/);
    assert.match(r.stdout, /@pm comment: Please look at the redirect/);

    r = await tango(["task", "claim", TASK], env);
    assert.match(r.stdout, /✓ claimed .* \(lease until 2026-10-09 12:45\)/);

    r = await tango(["task", "comment", TASK, "-"], env, "long comment\nfrom stdin\n");
    assert.equal(r.code, 0);
    assert.deepEqual(m.calls.at(-1), { name: "add_comment", args: { task_id: TASK, body: "long comment\nfrom stdin" } });

    r = await tango(["task", "done", TASK, "too", "short"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /complete_task: .*Write at least a sentence/);

    r = await tango(["task", "done", TASK, "Fixed the redirect loop in auth.ts; tests in auth.test.ts pass.", "--artifact", "a1"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(m.calls.at(-1)!.args, { task_id: TASK, summary: "Fixed the redirect loop in auth.ts; tests in auth.test.ts pass.", outcome: "review", evidence_artifact_ids: ["a1"] });

    r = await tango(["inbox"], env);
    assert.match(r.stdout, /Tasks \(1\):/);
    assert.ok(!r.stdout.includes("Old"), "closed tasks are hidden");
    assert.match(r.stdout, /@pm \[thread t1\]: ping/);

    r = await tango(["msg", "send", "--thread", "t1", "on", "it"], env);
    assert.deepEqual(m.calls.at(-1), { name: "send_message", args: { body: "on it", thread_id: "t1" } });

    r = await tango(["call", "memory_save", "content=hello", "tags=[\"x\"]"], env);
    assert.equal(r.code, 0);
    assert.deepEqual(m.calls.at(-1), { name: "memory_save", args: { content: "hello", tags: ["x"] } });

    r = await tango(["tools"], env);
    assert.match(r.stdout, /get_task +Read one task by id\.$/m);

    r = await tango(["call", "whoami", "--json"], env);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).reason, "tool_not_bridged");

    r = await tango(["task", "handoff", TASK], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--to @handle/);
  } finally {
    m.close();
  }
});

test("tango: reads the key from the runner config, and asks which agent when there are several", async () => {
  const m = mockTango();
  const url = await m.listen();
  const cfg = join(process.env.TANGO_RUNNER_HOME!, "cli-config.json");
  const agent = (name: string, key: string) => ({ name, key, harness: "command", command: "true", cwd: tmpdir() });
  try {
    writeFileSync(cfg, JSON.stringify({ tango_url: url, agents: [agent("a", KEY)] }));
    let r = await tango(["inbox", "--config", cfg], {});
    assert.equal(r.code, 0, r.stderr);

    writeFileSync(cfg, JSON.stringify({ tango_url: url, agents: [agent("a", KEY), agent("b", "tng_other_0123456789")] }));
    r = await tango(["inbox", "--config", cfg], {});
    assert.equal(r.code, 2);
    assert.match(r.stderr, /several agents \(a, b\)/);
    r = await tango(["inbox", "--config", cfg, "--agent", "a"], {});
    assert.equal(r.code, 0, r.stderr);
    r = await tango(["inbox", "--config", cfg, "--agent", "b"], {});
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rejected the worker key/);
  } finally {
    m.close();
  }
});

test("a woken command agent can run `tango` with no install", async () => {
  const m = mockTango();
  const url = await m.listen();
  const r = new AgentRunner(
    { tango_url: url, agents: [] },
    { name: "shell", key: KEY, harness: "command", command: `tango task comment "\${TANGO_WAKE_KEY#task:}" "woken and on it"`, cwd: tmpdir() },
    { debounceMs: 50, waitSeconds: 1, pollSeconds: 0.2, probeSeconds: 3600 },
  );
  const running = r.start();
  try {
    m.push({ type: "task.assigned", task_id: TASK, title: "Fix login", summary: "assigned", actor: { kind: "user", id: "u", handle: "@pm", is_self: false } });
    const t0 = Date.now();
    while (!m.calls.some((c) => c.name === "add_comment")) {
      if (Date.now() - t0 > 5000) throw new Error("agent never called tango");
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.deepEqual(m.calls.find((c) => c.name === "add_comment")!.args, { task_id: TASK, body: "woken and on it" });
  } finally {
    await r.stop(0);
    await running;
    m.close();
  }
});
