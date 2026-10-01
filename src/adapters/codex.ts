import { baseEnv, mcpUrl, type AdapterInput, type SpawnSpec } from "./spec.js";

/**
 * Codex CLI headless: `codex exec --json [-c mcp...] <prompt>`, or
 * `codex exec resume <session> --json <prompt>` to continue.
 * The Tango MCP server is passed as -c overrides; Codex reads the bearer from
 * $TANGO_WORKER_KEY via bearer_token_env_var.
 */
/**
 * Sandboxed, no approval prompts (nobody is there to answer). Set through -c
 * rather than flags: codex-cli 0.159 removed --full-auto, and `exec resume`
 * accepts neither --full-auto nor --sandbox, but every version takes -c.
 */
export const CODEX_DEFAULT_ARGS = ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"'];

export function codexSpec(i: AdapterInput): SpawnSpec {
  const a = i.agent;
  const args = ["exec"];
  if (i.sessionId) args.push("resume", i.sessionId);
  args.push(
    "--json",
    "--skip-git-repo-check",
    "-c",
    `mcp_servers.tango.url=${JSON.stringify(mcpUrl(a, i.tangoUrl))}`,
    "-c",
    `mcp_servers.tango.bearer_token_env_var="TANGO_WORKER_KEY"`,
  );
  if (a.model) args.push("-m", a.model);
  args.push(...(a.extra_args ?? CODEX_DEFAULT_ARGS));
  // Codex has no separate system prompt flag for exec; prepend the rules.
  args.push(`${i.systemRules}\n\n${i.prompt}`);
  return { cmd: a.bin ?? "codex", args, env: baseEnv(i) };
}

/** `--json` streams JSONL events; the first is {type:"thread.started", thread_id}. */
export function parseCodexOutput(stdout: string): { sessionId?: string; summary?: string } {
  let sessionId: string | undefined;
  let summary: string | undefined;
  for (const l of stdout.split("\n")) {
    try {
      const o = JSON.parse(l) as { type?: string; thread_id?: string; item?: { type?: string; text?: string } };
      if (o.type === "thread.started" && o.thread_id) sessionId = o.thread_id;
      if (o.type === "item.completed" && o.item?.type === "agent_message" && o.item.text) summary = o.item.text.slice(0, 300);
    } catch {
      // ignore non-JSON lines
    }
  }
  return { sessionId, summary };
}
