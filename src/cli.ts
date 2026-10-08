#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { AgentRunner } from "./agent.js";
import { HttpError, RUNNER_VERSION, TangoClient } from "./client.js";
import { DEFAULT_URL, defaultConfigPath, expandHome, loadConfig, resolveKey, saveConfig, validateConfig } from "./config.js";
import { acquireLock, lockHolder } from "./lock.js";
import { log, redact, setVerbose } from "./log.js";
import {
  agentName,
  appendAgents,
  chooseFolder,
  choosePrograms,
  detectPrograms,
  matchAgents,
  normalizeCode,
  Prompter,
  readExistingConfig,
  register,
  sameOrigin,
  SetupError,
  type Selection,
} from "./setup.js";
import type { AgentConfig, Harness, RunnerConfig } from "./types.js";

const HELP = `tango-runner ${RUNNER_VERSION}: wake your local agents the moment Tango has work for them.

Usage:
  tango-runner setup --code ABCD-2345 [--url <url>] [--yes] [--no-start]
  tango-runner init --key tng_... --harness claude|codex|command --cwd <dir> [options]
  tango-runner start [--agent <name>] [--verbose]
  tango-runner doctor
  tango-runner help

setup: detects installed agent CLIs (claude, codex, cursor-agent, gemini, opencode,
hermes), creates them as agents in Tango with the one-time code from the Connect
agents page, saves their keys to the config, then runs doctor and start.
  --yes                 Use every detected program and the current folder; ask nothing.
  --no-start            Stop after doctor.

init options:
  --name <label>        Agent label (default: harness name). Re-running init with the same name replaces it.
  --key-env <VAR>       Read the tng_ key from this env var instead of storing it.
  --command "<cmd>"     For --harness command: shell command to run (prompt on stdin).
  --bin <path>          Harness binary if not on PATH.
  --model <id>          Model to pass to the harness.
  --lite                Use Tango Lite's MCP endpoint (/mcp/lite).
  --url <url>           Tango URL (default ${DEFAULT_URL}).

Global:
  --config <path>       Config file (default ${defaultConfigPath()}).
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      key: { type: "string" },
      "key-env": { type: "string" },
      harness: { type: "string" },
      cwd: { type: "string" },
      name: { type: "string" },
      command: { type: "string" },
      bin: { type: "string" },
      model: { type: "string" },
      lite: { type: "boolean" },
      url: { type: "string" },
      code: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "no-start": { type: "boolean" },
      agent: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.verbose) setVerbose(true);
  const cmd = positionals[0] ?? (values.help ? "help" : "help");
  const configPath = values.config ? expandHome(values.config) : defaultConfigPath();

  switch (cmd) {
    case "setup":
      return setup(configPath, values);
    case "init":
      return init(configPath, values);
    case "start":
      return start(configPath, values.agent);
    case "doctor":
      return doctor(configPath);
    default:
      process.stdout.write(HELP);
      return cmd === "help" ? 0 : 1;
  }
}

function init(configPath: string, v: Record<string, string | boolean | undefined>): number {
  const harness = (v.harness as Harness | undefined) ?? "claude";
  if (!v.cwd) {
    process.stderr.write("init: --cwd <dir> is required (the repo the agent should work in)\n");
    return 1;
  }
  const cwd = expandHome(v.cwd as string);
  if (!existsSync(cwd)) {
    process.stderr.write(`init: --cwd ${cwd} does not exist. Point it at the repo the agent should work in.\n`);
    return 1;
  }
  const agent: AgentConfig = {
    name: (v.name as string) ?? harness,
    harness,
    cwd,
    ...(v["key-env"] ? { key_env: v["key-env"] as string } : { key: v.key as string }),
    ...(v.command ? { command: v.command as string } : {}),
    ...(v.bin ? { bin: v.bin as string } : {}),
    ...(v.model ? { model: v.model as string } : {}),
    ...(v.lite ? { mcp_path: "/mcp/lite" } : {}),
  };
  let cfg: RunnerConfig;
  try {
    cfg = existsSync(configPath) ? loadConfig(configPath) : { tango_url: DEFAULT_URL, agents: [] };
  } catch {
    cfg = { tango_url: DEFAULT_URL, agents: [] };
  }
  if (v.url) cfg.tango_url = v.url as string;
  cfg.agents = [...cfg.agents.filter((a) => a.name !== agent.name), agent];
  try {
    validateConfig(cfg);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
  saveConfig(cfg, configPath);
  process.stdout.write(`Saved agent "${agent.name}" to ${configPath} (mode 600).\nNext: tango-runner doctor, then tango-runner start\n`);
  return 0;
}

async function setup(configPath: string, v: Record<string, string | boolean | undefined>): Promise<number> {
  const fail = (msg: string) => (process.stderr.write(`setup: ${msg}\n`), 1);
  if (!v.code) return fail("--code is required. Copy the full command from the Connect agents page in Tango.");
  const code = normalizeCode(v.code as string);
  if (!code) return fail("that code doesn't look right. Codes look like ABCD-2345 (no 0, O, 1 or I).");
  const url = ((v.url as string | undefined) ?? DEFAULT_URL).replace(/\/+$/, "");

  let existing;
  try {
    existing = readExistingConfig(configPath);
  } catch (e) {
    return fail((e as Error).message);
  }
  // One tango_url per config: don't spend the code if the new agents can't share it.
  if (existing && existing.agents.length && existing.tango_url && !sameOrigin(existing.tango_url, url)) {
    return fail(`${configPath} already has agents for ${existing.tango_url}, not ${url}. Use --config <other file> for a second Tango.`);
  }

  const found = detectPrograms();
  if (found.length === 0) {
    process.stderr.write(
      "setup: no agent CLI found on PATH (looked for claude, codex, cursor-agent, gemini, opencode, hermes).\n" +
        "Install one and run this again, or connect any CLI by hand: create an agent in Tango, issue a worker key, then\n" +
        "  tango-runner init --key tng_... --harness command --command \"<your cli>\" --cwd <dir>\n",
    );
    return 1;
  }

  const here = process.cwd();
  const host = hostname();
  let selections: Selection[];
  if (v.yes) {
    selections = found.map((f) => ({ ...f, cwd: here, name: agentName(f.program, host) }));
    process.stdout.write(`Found ${found.map((f) => f.program).join(", ")}. Using ${here} for each.\n`);
  } else {
    process.stdout.write(`Found ${found.length} agent program(s) on this computer:\n`);
    const p = new Prompter();
    try {
      const chosen = await choosePrograms(found, p);
      if (chosen.length === 0) return fail("nothing selected; no agents created. The code is still unused.");
      selections = [];
      for (const f of chosen) selections.push({ ...f, cwd: await chooseFolder(f.program, here, p), name: agentName(f.program, host) });
    } finally {
      p.close();
    }
  }

  let res;
  try {
    res = await register(url, {
      code,
      host,
      runner_version: RUNNER_VERSION,
      agents: selections.map((s) => ({ program: s.program, ...(s.version ? { version: s.version } : {}), name: s.name })),
    });
  } catch (e) {
    return fail(e instanceof SetupError ? e.message : `could not register agents: ${(e as Error).message}`);
  }

  const { entries, skipped } = matchAgents(res.agents, selections);
  if (entries.length === 0) {
    return fail(`Tango returned no usable keys${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}. Get a fresh setup command from the Connect agents page in Tango.`);
  }
  const added = appendAgents(configPath, existing, res.api_base, entries);
  process.stdout.write(`\nCreated ${added.length} agent(s) in Tango and saved them to ${configPath} (mode 600):\n`);
  for (const a of added) process.stdout.write(`  ✓ ${a.name}  (${a.harness === "command" ? `command: ${a.command}` : a.harness}, cwd ${a.cwd})\n`);
  if (skipped.length) process.stdout.write(`  Skipped (Tango returned no key): ${skipped.join(", ")}\n`);

  process.stdout.write("\nRunning doctor…\n");
  if ((await doctor(configPath)) !== 0) {
    process.stderr.write("\nsetup: the agents are saved, but doctor found a problem (above). Fix it, then run: tango-runner start\n");
    return 1;
  }
  if (v["no-start"]) {
    process.stdout.write("\nDone. Start the runner with: tango-runner start\n");
    return 0;
  }
  const holder = lockHolder(configPath);
  if (holder) {
    process.stdout.write(`\nA runner is already running for this config (pid ${holder}). Restart it to pick up the new agents.\n`);
    return 0;
  }
  process.stdout.write("\nStarting the runner (Ctrl-C to stop)…\n");
  return start(configPath);
}

async function start(configPath: string, only?: string): Promise<number> {
  const cfg = loadConfig(configPath);
  const agents = cfg.agents.filter((a) => !only || a.name === only);
  if (agents.length === 0) {
    process.stderr.write(`No agent named "${only}" in ${configPath}\n`);
    return 1;
  }
  acquireLock(configPath);
  const runners = agents.map((a) => new AgentRunner(cfg, a));
  log("info", "runner", `tango-runner ${RUNNER_VERSION} → ${cfg.tango_url}, ${runners.length} agent(s): ${runners.map((r) => r.name).join(", ")}`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) {
      log("warn", "runner", `${sig} again: killing runs now`);
      await Promise.all(runners.map((r) => r.stop(0)));
      process.exit(130);
    }
    stopping = true;
    log("info", "runner", `${sig}: no new runs; waiting up to 60s for current runs (Ctrl-C again to kill)`);
    await Promise.all(runners.map((r) => r.stop(60_000)));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await Promise.all(runners.map((r) => r.start()));
  return 0;
}

async function doctor(configPath: string): Promise<number> {
  let ok = true;
  const cfg = loadConfig(configPath);
  process.stdout.write(`config: ${configPath}\ntango:  ${cfg.tango_url}\n`);
  const holder = lockHolder(configPath);
  process.stdout.write(holder ? `runner: running (pid ${holder})\n\n` : "runner: not running\n\n");
  for (const a of cfg.agents) {
    process.stdout.write(`agent "${a.name}" (${a.harness}, cwd ${a.cwd})\n`);
    const key = resolveKey(a);
    const client = new TangoClient(cfg.tango_url, key, { host: "doctor", harness: a.harness });
    let keyOk = true;
    try {
      const hb = await client.heartbeat();
      process.stdout.write(`  ✓ key ${redact(key)} works (worker ${hb.worker_id ?? "?"})\n`);
    } catch (e) {
      ok = keyOk = false;
      process.stdout.write(`  ✗ key ${redact(key)}: ${(e as Error).message}\n`);
    }
    if (keyOk) {
      try {
        await client.wait(null, 0);
        process.stdout.write("  ✓ server supports instant wake (/wait)\n");
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          process.stdout.write(`  • server has no /wait yet: runner will poll every ${cfg.poll_seconds ?? 20}s until it does\n`);
        } else {
          ok = false;
          process.stdout.write(`  ✗ /wait: ${(e as Error).message}\n`);
        }
      }
    }
    if (!existsSync(expandHome(a.cwd))) {
      ok = false;
      process.stdout.write(`  ✗ cwd does not exist\n`);
    }
    if (a.harness === "command") {
      // The command runs through sh; check its program resolves the same way.
      const prog = a.command!.trim().split(/\s+/)[0];
      const target = prog.startsWith("~") ? expandHome(prog) : prog;
      const cwd = existsSync(expandHome(a.cwd)) ? expandHome(a.cwd) : undefined;
      const r =
        process.platform === "win32"
          ? spawnSync("where", [target], { encoding: "utf8", cwd, windowsHide: true })
          : spawnSync("sh", ["-c", 'command -v -- "$1"', "sh", target], { encoding: "utf8", cwd });
      if (r.status === 0) process.stdout.write(`  ✓ command ${r.stdout.trim().split(/\r?\n/)[0]}\n`);
      else {
        ok = false;
        process.stdout.write(`  ✗ can't find "${prog}" (the first word of "command"). Install it or use its full path.\n`);
      }
    } else {
      const bin = a.bin ?? a.harness;
      // npm installs .cmd shims on Windows, which only run through the shell.
      const r =
        process.platform === "win32"
          ? spawnSync(`"${bin}" --version`, { encoding: "utf8", shell: true, windowsHide: true })
          : spawnSync(bin, ["--version"], { encoding: "utf8" });
      if (r.status === 0) process.stdout.write(`  ✓ ${bin} ${r.stdout.trim().split("\n")[0]}\n`);
      else {
        ok = false;
        process.stdout.write(`  ✗ can't run "${bin} --version" (${r.error?.message ?? r.stderr.trim()}). Install it or set "bin".\n`);
      }
    }
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  },
);
