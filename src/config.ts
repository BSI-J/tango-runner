import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentConfig, RunnerConfig } from "./types.js";

export const DEFAULT_URL = "https://tango.applayer.io";

export function stateDir(): string {
  return process.env.TANGO_RUNNER_HOME ?? join(homedir(), ".tango-runner");
}

export function defaultConfigPath(): string {
  return join(stateDir(), "config.json");
}

export function loadConfig(path = defaultConfigPath()): RunnerConfig {
  if (!existsSync(path)) {
    throw new Error(`No config at ${path}. Run: tango-runner init --key tng_... --harness claude --cwd <repo>`);
  }
  const cfg = JSON.parse(readFileSync(path, "utf8")) as RunnerConfig;
  validateConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: RunnerConfig, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // keys live here
}

export function validateConfig(cfg: RunnerConfig): void {
  if (!cfg.tango_url) throw new Error("config: tango_url is required");
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) throw new Error("config: add at least one agent");
  const names = new Set<string>();
  for (const a of cfg.agents) {
    if (!a.name) throw new Error("config: every agent needs a name");
    if (names.has(a.name)) throw new Error(`config: duplicate agent name "${a.name}"`);
    names.add(a.name);
    if (!["claude", "codex", "command"].includes(a.harness)) {
      throw new Error(`config: agent "${a.name}" has unknown harness "${a.harness}" (claude | codex | command)`);
    }
    if (a.harness === "command" && !a.command) throw new Error(`config: agent "${a.name}" needs "command"`);
    if (!a.cwd) throw new Error(`config: agent "${a.name}" needs cwd`);
    resolveKey(a); // throws if missing
  }
}

export function resolveKey(a: AgentConfig): string {
  const key = a.key || (a.key_env ? process.env[a.key_env] : undefined);
  if (!key) throw new Error(`config: agent "${a.name}" has no key (set "key" or "key_env")`);
  if (!key.startsWith("tng_")) throw new Error(`config: agent "${a.name}" key must be a tng_ worker key`);
  return key;
}

export function expandHome(p: string): string {
  return resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
}
