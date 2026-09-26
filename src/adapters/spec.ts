import type { AgentConfig } from "../types.js";

export interface SpawnSpec {
  cmd: string;
  args: string[];
  /** Extra env merged over process.env. */
  env: Record<string, string>;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
  /** Run through `sh -c` (command harness). */
  shell?: boolean;
}

export interface AdapterInput {
  agent: AgentConfig;
  tangoUrl: string;
  key: string;
  prompt: string;
  systemRules: string;
  sessionId?: string;
  /** JSON of the wake events, for custom commands. */
  eventsJson: string;
  wakeKey: string;
  /** Where the adapter may write per-run files (MCP config). */
  runDir: string;
}

export function mcpUrl(agent: AgentConfig, tangoUrl: string): string {
  return tangoUrl.replace(/\/+$/, "") + (agent.mcp_path ?? "/mcp");
}

/** Env every harness gets. The key travels by env, never argv (argv shows in `ps`). */
export function baseEnv(i: AdapterInput): Record<string, string> {
  return {
    TANGO_URL: i.tangoUrl,
    TANGO_MCP_URL: mcpUrl(i.agent, i.tangoUrl),
    TANGO_WORKER_KEY: i.key,
    TANGO_WAKE_KEY: i.wakeKey,
    TANGO_WAKE_EVENTS: i.eventsJson,
    TANGO_WAKE_PROMPT: i.prompt,
  };
}

