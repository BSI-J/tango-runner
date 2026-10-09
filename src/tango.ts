#!/usr/bin/env node
// `tango`: Tango from the shell, for agents and scripts. A thin client over
// Tango's MCP endpoint authenticated with a tng_ worker key, so it reaches
// exactly what that worker may do and picks up new tools without a release.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { RUNNER_VERSION } from "./client.js";
import { defaultConfigPath, expandHome, loadConfig, resolveKey } from "./config.js";
import { McpClient, parseToolArgs, ToolError, UsageError } from "./mcp.js";

const HELP = `tango ${RUNNER_VERSION}: use Tango from the shell as a worker (agent).

Tasks:
  tango inbox                          Your open tasks and unread messages
  tango task show <id>                 A task, its lease and recent activity
  tango task pull                      Lease the next task waiting for you
  tango task claim <id>                Claim a task and take its lease
  tango task note <id> <text>          Add a progress note (needs your lease)
  tango task comment <id> <text>       Comment on a task
  tango task ask <id> <question>       Ask the task's human; parks it until answered
  tango task handoff <id> --to @handle [note]
  tango task done <id> <summary>       Send for review (--done to close it outright)
                                       Summary: 40+ characters on what you did and where it is
Messages:
  tango msg read [--thread <id>] [--all]
  tango msg send --to @handle [--thread <id>] <text>
  tango agents                         Agents in your workspace

Any tool:
  tango tools                          Tools this key can call
  tango call <tool> [key=value ...]    Call one; values are parsed as JSON when they can be
  tango call <tool> '{"json": "args"}'

Write "-" for a <text> argument to read it from stdin.

Options:
  --json             Print Tango's full JSON response
  --agent <name>     Which agent in the runner config to act as (or $TANGO_AGENT)
  --config <path>    Runner config (default ${defaultConfigPath()})

Credentials: inside a tango-runner wake, $TANGO_WORKER_KEY and $TANGO_URL are set
for you. Otherwise the key comes from the runner config written by
\`tango-runner setup\` or \`tango-runner init\`.
`;

interface Ctx {
  mcp: McpClient;
  json: boolean;
  v: Record<string, string | boolean | string[] | undefined>;
}

function credentials(v: Ctx["v"]): { mcpUrl: string; key: string } {
  const envKey = process.env.TANGO_WORKER_KEY;
  if (envKey && !v.agent && !v.config) {
    const base = (process.env.TANGO_URL ?? "https://tango.applayer.io").replace(/\/+$/, "");
    return { mcpUrl: process.env.TANGO_MCP_URL ?? `${base}/mcp`, key: envKey };
  }
  const path = v.config ? expandHome(v.config as string) : defaultConfigPath();
  const cfg = loadConfig(path);
  const want = (v.agent as string | undefined) ?? process.env.TANGO_AGENT;
  const agent = want ? cfg.agents.find((a) => a.name === want) : cfg.agents.length === 1 ? cfg.agents[0] : undefined;
  if (!agent) {
    const names = cfg.agents.map((a) => a.name).join(", ");
    throw new UsageError(want ? `No agent "${want}" in ${path} (have: ${names})` : `${path} has several agents (${names}); pick one with --agent <name>`);
  }
  return { mcpUrl: cfg.tango_url.replace(/\/+$/, "") + (agent.mcp_path ?? "/mcp"), key: resolveKey(agent) };
}

function text(parts: string[], what: string): string {
  if (parts.length === 1 && parts[0] === "-") return readFileSync(0, "utf8").trim();
  const t = parts.join(" ").trim();
  if (!t) throw new UsageError(`missing ${what}`);
  return t;
}

function need(id: string | undefined, what = "task id"): string {
  if (!id) throw new UsageError(`missing ${what}`);
  return id;
}

// ---- formatting: compact text by default, since agents pay for every token ----

type Row = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : String(x));
const oneLine = (x: unknown, max = 160) => {
  const s = str(x).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
const when = (x: unknown) => str(x).slice(0, 16).replace("T", " ");

function taskLine(t: Row): string {
  return `${str(t.id)}  ${str(t.status).padEnd(11)} ${oneLine(t.title, 100)}`;
}

function activityLine(e: Row): string {
  const who = e.actor_handle ?? e.author_handle ?? e.actor ?? e.author ?? "";
  const what = e.body ?? e.summary ?? e.note ?? e.text ?? e.message ?? "";
  const kind = e.kind ?? e.type ?? e.event ?? "";
  return `  ${when(e.created_at)}  ${oneLine(who, 30)} ${oneLine(kind, 30)}${what ? `: ${oneLine(what)}` : ""}`.trimEnd();
}

function messageLine(m: Row): string {
  const from = m.from_handle ?? m.sender_handle ?? m.from ?? m.sender ?? "";
  return `  ${when(m.created_at)}  ${oneLine(from, 30)}${m.thread_id ? ` [thread ${str(m.thread_id)}]` : ""}: ${oneLine(m.body ?? m.text, 300)}`;
}

function out(ctx: Ctx, payload: unknown, render: () => string): void {
  process.stdout.write((ctx.json ? JSON.stringify(payload, null, 2) : render()) + "\n");
}

const rows = (x: unknown, key: string): Row[] => {
  const v = (x as Row | null)?.[key];
  return Array.isArray(v) ? (v as Row[]) : [];
};

// ---- commands ----

async function inbox(ctx: Ctx): Promise<void> {
  const [tasks, msgs] = await Promise.all([ctx.mcp.call("list_my_tasks", {}), ctx.mcp.call("read_messages", {})]);
  out(ctx, { tasks, messages: msgs }, () => {
    const open = rows(tasks, "tasks").filter((t) => !["done", "approved", "cancelled"].includes(str(t.status)));
    const m = rows(msgs, "messages");
    return [
      open.length ? `Tasks (${open.length}):\n${open.map((t) => "  " + taskLine(t)).join("\n")}` : "Tasks: none open",
      m.length ? `Unread messages (${m.length}):\n${m.map(messageLine).join("\n")}` : "Unread messages: none",
    ].join("\n");
  });
}

async function task(ctx: Ctx, sub: string | undefined, rest: string[]): Promise<void> {
  const v = ctx.v;
  switch (sub) {
    case "show": {
      const id = need(rest[0]);
      const r = (await ctx.mcp.call("get_task", { task_id: id })) as Row;
      return out(ctx, r, () => {
        const t = (r.task ?? r) as Row;
        const lease = r.lease as Row | null | undefined;
        const lines = [taskLine(t)];
        for (const [label, key] of [["Goal", "goal"], ["Done when", "definition_of_done"], ["Description", "description"], ["Handoff note", "handoff_note"]] as const) {
          if (t[key]) lines.push(`${label}: ${oneLine(t[key], 1200)}`);
        }
        if (lease) lines.push(`Lease: ${str(lease.worker_handle ?? lease.worker_id)} until ${when(lease.expires_at)}${r.can_write ? " (yours)" : ""}`);
        const arts = Array.isArray(r.artifacts) ? (r.artifacts as Row[]) : [];
        if (arts.length) lines.push(`Artifacts: ${arts.map((a) => str(a.name ?? a.id)).join(", ")}`);
        const act = Array.isArray(r.activity) ? (r.activity as Row[]).slice(-10) : [];
        if (act.length) lines.push("Recent activity:", ...act.map(activityLine));
        return lines.join("\n");
      });
    }
    case "pull": {
      const r = (await ctx.mcp.call("pull_next_task", {})) as Row;
      return out(ctx, r, () => {
        const t = (r.task ?? null) as Row | null;
        return t ? `✓ leased ${taskLine(t)}` : `No task waiting${r.message ? `: ${oneLine(r.message)}` : "."}`;
      });
    }
    case "claim": {
      const id = need(rest[0]);
      const r = (await ctx.mcp.call("claim_task", { task_id: id })) as Row;
      const lease = r.lease as Row | undefined;
      return out(ctx, r, () => `✓ claimed ${id}${lease?.expires_at ? ` (lease until ${when(lease.expires_at)})` : ""}`);
    }
    case "note": {
      const id = need(rest[0]);
      const r = await ctx.mcp.call("add_progress_note", { task_id: id, note: text(rest.slice(1), "note text") });
      return out(ctx, r, () => `✓ note added to ${id}`);
    }
    case "comment": {
      const id = need(rest[0]);
      const r = await ctx.mcp.call("add_comment", { task_id: id, body: text(rest.slice(1), "comment text") });
      return out(ctx, r, () => `✓ commented on ${id}`);
    }
    case "ask": {
      const id = need(rest[0]);
      const r = await ctx.mcp.call("ask_human", { task_id: id, question: text(rest.slice(1), "question") });
      return out(ctx, r, () => `✓ asked on ${id}. Stop here; Tango wakes you when it's answered.`);
    }
    case "handoff": {
      const id = need(rest[0]);
      if (!v.to) throw new UsageError("handoff needs --to @handle");
      const note = rest.length > 1 ? text(rest.slice(1), "note") : undefined;
      const r = await ctx.mcp.call("handoff_task", { task_id: id, to: v.to, ...(note ? { note } : {}) });
      return out(ctx, r, () => `✓ handed ${id} to ${str(v.to)}`);
    }
    case "done": {
      const id = need(rest[0]);
      const artifacts = (v.artifact as string[] | undefined) ?? [];
      const r = await ctx.mcp.call("complete_task", {
        task_id: id,
        summary: text(rest.slice(1), "summary"),
        outcome: v.done ? "done" : "review",
        ...(artifacts.length ? { evidence_artifact_ids: artifacts } : {}),
      });
      return out(ctx, r, () => `✓ ${id} ${v.done ? "marked done" : "sent for review"}`);
    }
    default:
      throw new UsageError(sub ? `unknown task command "${sub}"` : "task needs a command: show, pull, claim, note, comment, ask, handoff, done");
  }
}

async function msg(ctx: Ctx, sub: string | undefined, rest: string[]): Promise<void> {
  const v = ctx.v;
  if (sub === "read") {
    const r = await ctx.mcp.call("read_messages", { ...(v.thread ? { thread_id: v.thread } : {}), ...(v.all ? { all: true } : {}) });
    const m = rows(r, "messages");
    return out(ctx, r, () => (m.length ? m.map(messageLine).join("\n") : v.all ? "No messages." : "No unread messages."));
  }
  if (sub === "send") {
    if (!v.to && !v.thread) throw new UsageError("send needs --to @handle or --thread <id>");
    const r = (await ctx.mcp.call("send_message", {
      body: text(rest, "message text"),
      ...(v.to ? { to: v.to } : {}),
      ...(v.thread ? { thread_id: v.thread } : {}),
    })) as Row;
    return out(ctx, r, () => `✓ sent${r.thread_id ? ` (thread ${str(r.thread_id)})` : ""}`);
  }
  throw new UsageError(sub ? `unknown msg command "${sub}"` : "msg needs a command: read, send");
}

async function main(): Promise<number> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      agent: { type: "string" },
      config: { type: "string" },
      to: { type: "string" },
      thread: { type: "string" },
      all: { type: "boolean" },
      done: { type: "boolean" },
      artifact: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (v.version) {
    process.stdout.write(`${RUNNER_VERSION}\n`);
    return 0;
  }
  const [cmd, sub, ...rest] = positionals;
  if (!cmd || cmd === "help" || v.help) {
    process.stdout.write(HELP);
    return cmd || v.help ? 0 : 2;
  }
  const { mcpUrl, key } = credentials(v);
  const ctx: Ctx = { mcp: new McpClient(mcpUrl, key), json: Boolean(v.json), v };

  switch (cmd) {
    case "inbox":
      await inbox(ctx);
      break;
    case "task":
      await task(ctx, sub, rest);
      break;
    case "msg":
      await msg(ctx, sub, rest);
      break;
    case "agents": {
      const r = await ctx.mcp.call("list_agents", {});
      const a = rows(r, "agents");
      out(ctx, r, () =>
        a.map((x) => `  ${oneLine(x.handle, 40).padEnd(28)} ${oneLine(x.name, 40)}${x.reachable === false ? "  (not reachable)" : ""}`).join("\n") || "No agents.",
      );
      break;
    }
    case "tools": {
      const tools = await ctx.mcp.listTools();
      out(ctx, tools, () => tools.map((t) => `  ${t.name.padEnd(22)} ${oneLine(str(t.description).replace(/ \(static-key mode:.*\)$/, ""), 110)}`).join("\n"));
      break;
    }
    case "call": {
      const tool = need(sub, "tool name");
      const r = await ctx.mcp.call(tool, parseToolArgs(rest));
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      break;
    }
    default:
      throw new UsageError(`unknown command "${cmd}". Run: tango help`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    if (err instanceof UsageError) {
      process.stderr.write(`tango: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof ToolError && process.argv.includes("--json")) {
      process.stdout.write(JSON.stringify(err.payload, null, 2) + "\n");
    }
    process.stderr.write(`tango: ${err.message}\n`);
    process.exit(1);
  },
);
