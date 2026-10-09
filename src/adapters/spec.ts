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
}

export function mcpUrl(agent: AgentConfig, tangoUrl: string): string {
  return tangoUrl.replace(/\/+$/, "") + (agent.mcp_path ?? "/mcp");
}

/**
 * A directory holding a `tango` launcher for this runner's own CLI, so a woken
 * agent can run `tango ...` without installing anything. Rewritten when the
 * runner moves (npx caches, upgrades).
 */
export function tangoBinDir(): string {
  const dir = join(stateDir(), "bin");
  const node = process.execPath;
  const cli = fileURLToPath(new URL("../tango.js", import.meta.url));
  const [file, body] =
    process.platform === "win32"
      ? [join(dir, "tango.cmd"), `@"${node}" "${cli}" %*\r\n`]
      : [join(dir, "tango"), `#!/bin/sh\nexec "${node}" "${cli}" "$@"\n`];
  if (!existsSync(file) || readFileSync(file, "utf8") !== body) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { mode: 0o755 });
  }
  return dir;
}

/** PATH with the `tango` launcher first, under whatever casing this platform's env uses. */
function pathEnv(): Record<string, string> {
  const name = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const cur = process.env[name];
  return { [name]: cur ? `${tangoBinDir()}${delimiter}${cur}` : tangoBinDir() };
}

/** Env every harness gets. The key travels by env, never argv (argv shows in `ps`). */
export function baseEnv(i: AdapterInput): Record<string, string> {
  return {
    ...pathEnv(),
    TANGO_URL: i.tangoUrl,
    TANGO_MCP_URL: mcpUrl(i.agent, i.tangoUrl),
    TANGO_WORKER_KEY: i.key,
    TANGO_WAKE_KEY: i.wakeKey,
    TANGO_WAKE_EVENTS: i.eventsJson,
    TANGO_WAKE_PROMPT: i.prompt,
  };
}

