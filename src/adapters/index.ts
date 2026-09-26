import type { AgentConfig } from "../types.js";
import { claudeSpec, parseClaudeOutput } from "./claude.js";
import { codexSpec, parseCodexOutput } from "./codex.js";
import { commandSpec } from "./command.js";
import type { AdapterInput, SpawnSpec } from "./spec.js";

export type { AdapterInput, SpawnSpec } from "./spec.js";
export { baseEnv, mcpUrl } from "./spec.js";

export function buildSpawn(i: AdapterInput): SpawnSpec {
  switch (i.agent.harness) {
    case "claude":
      return claudeSpec(i);
    case "codex":
      return codexSpec(i);
    case "command":
      return commandSpec(i);
  }
}

/** Pull a session id (for --resume next time) and a one-line summary out of the run's stdout. */
export function parseOutput(agent: AgentConfig, stdout: string): { sessionId?: string; summary?: string } {
  if (agent.harness === "claude") return parseClaudeOutput(stdout);
  if (agent.harness === "codex") return parseCodexOutput(stdout);
  return {};
}
