import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../config.js";
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
  /** The runner config holding this agent's key. */
  configPath?: string;
}

export function mcpUrl(agent: AgentConfig, tangoUrl: string): string {
  return tangoUrl.replace(/\/+$/, "") + (agent.mcp_path ?? "/mcp");
}

const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

/**
 * A per-agent directory holding a `tango` launcher for this runner's own CLI,
 * so a woken agent can run `tango ...` without installing anything. The
 * launcher pins the agent: some harnesses run tools with a scrubbed env, and
 * without the pin `tango` would fall back to the config and could act as a
 * different agent. Rewritten when the runner moves (npx caches, upgrades).
 */
export function tangoBinDir(agentName: string, configPath?: string): string {
  const dir = join(stateDir(), "bin", agentName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80));
  const node = process.execPath;
  const cli = fileURLToPath(new URL("../tango.js", import.meta.url));
  const [file, body] =
    process.platform === "win32"
      ? [
          join(dir, "tango.cmd"),
          [
            "@echo off",
            "setlocal",
            `set "TANGO_RUNNER_AGENT=${agentName}"`,
            ...(configPath ? [`set "TANGO_RUNNER_CONFIG=${configPath}"`] : []),
            `"${node}" "${cli}" %*`,
            "",
          ].join("\r\n"),
        ]
      : [
          join(dir, "tango"),
          [
            "#!/bin/sh",
            `TANGO_RUNNER_AGENT=${shq(agentName)}; export TANGO_RUNNER_AGENT`,
            ...(configPath ? [`TANGO_RUNNER_CONFIG=${shq(configPath)}; export TANGO_RUNNER_CONFIG`] : []),
            `exec ${shq(node)} ${shq(cli)} "$@"`,
            "",
          ].join("\n"),
        ];
  if (!existsSync(file) || readFileSync(file, "utf8") !== body) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { mode: 0o755 });
  }
  return dir;
}

/** PATH with the `tango` launcher first, under whatever casing this platform's env uses. */
function pathEnv(i: AdapterInput): Record<string, string> {
  const name = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const bin = tangoBinDir(i.agent.name, i.configPath);
  const cur = process.env[name];
  return { [name]: cur ? `${bin}${delimiter}${cur}` : bin };
}

/** Env every harness gets. The key travels by env, never argv (argv shows in `ps`). */
export function baseEnv(i: AdapterInput): Record<string, string> {
  return {
    ...pathEnv(i),
    TANGO_RUNNER_AGENT: i.agent.name,
    ...(i.configPath ? { TANGO_RUNNER_CONFIG: i.configPath } : {}),
    TANGO_URL: i.tangoUrl,
    TANGO_MCP_URL: mcpUrl(i.agent, i.tangoUrl),
    TANGO_WORKER_KEY: i.key,
    TANGO_WAKE_KEY: i.wakeKey,
    TANGO_WAKE_EVENTS: i.eventsJson,
    TANGO_WAKE_PROMPT: i.prompt,
  };
}

