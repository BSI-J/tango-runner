import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseEnv, mcpUrl, type AdapterInput, type SpawnSpec } from "./spec.js";

/**
 * Claude Code headless: `claude -p <prompt> --output-format json --mcp-config <file> ...`
 * The MCP config references ${TANGO_WORKER_KEY}; Claude Code expands env vars in MCP
 * config, so the key never lands on disk or in argv.
 */
export function claudeSpec(i: AdapterInput): SpawnSpec {
  const a = i.agent;
  const mcpFile = join(i.runDir, "tango-mcp.json");
  writeFileSync(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        tango: {
          type: "http",
          url: mcpUrl(a, i.tangoUrl),
          headers: { Authorization: "Bearer ${TANGO_WORKER_KEY}" },
        },
      },
    }),
    { mode: 0o600 },
  );

  const args = ["-p", i.prompt, "--output-format", "json", "--mcp-config", mcpFile];
  if (a.strict_mcp !== false) args.push("--strict-mcp-config");
  args.push("--permission-mode", a.permission_mode ?? "acceptEdits");
  args.push("--allowedTools", ["mcp__tango", ...(a.allowed_tools ?? [])].join(","));
  args.push("--append-system-prompt", i.systemRules);
  if (a.model) args.push("--model", a.model);
  if (i.sessionId) args.push("--resume", i.sessionId);
  args.push(...(a.extra_args ?? []));

  return { cmd: a.bin ?? "claude", args, env: baseEnv(i) };
}

/** `--output-format json` prints one result object: {type:"result", session_id, result, is_error, ...}. */
export function parseClaudeOutput(stdout: string): { sessionId?: string; summary?: string } {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const o = JSON.parse(l) as { type?: string; session_id?: string; result?: string };
      if (o.session_id) {
        return { sessionId: o.session_id, summary: typeof o.result === "string" ? o.result.slice(0, 300) : undefined };
      }
    } catch {
      // not JSON; keep looking
    }
  }
  return {};
}
