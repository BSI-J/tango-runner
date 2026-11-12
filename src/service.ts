import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNNER_VERSION } from "./client.js";
import { defaultConfigPath, stateDir } from "./config.js";
import { lockHolder } from "./lock.js";

/**
 * Run the runner as a per-user login service, so agents keep waking after the
 * terminal closes or the machine restarts:
 *
 *   macOS    ~/Library/LaunchAgents/io.applayer.tango-runner.plist  (RunAtLoad, KeepAlive)
 *   Windows  logon task "TangoRunner" → hidden VBS → restart-loop .cmd
 *   Linux    ~/.config/systemd/user/tango-runner.service              (Restart=always)
 *
 * The runner's files are copied to ~/.tango-runner/app/<version>/ first, so the
 * service doesn't depend on an npx cache that can be cleaned. It runs on the
 * Node binary that installed it (process.execPath). A supervisor such as Tango
 * Desktop runs this with ELECTRON_RUN_AS_NODE=1, and that is carried into the
 * service so the app's own binary is the Node.
 */

export const MAC_LABEL = "io.applayer.tango-runner";
export const WIN_TASK = "TangoRunner";
export const LINUX_UNIT = "tango-runner.service";

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const unitPath = () => join(homedir(), ".config", "systemd", "user", LINUX_UNIT);
const appDir = () => join(stateDir(), "app");
export const serviceLogPath = () => join(stateDir(), "logs", "runner.log");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
function run(cmd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });
}

export interface ServiceState {
  platform: NodeJS.Platform;
  /** The service definition exists (it will start at login). */
  installed: boolean;
  /** Loaded into the service manager right now. */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  name: string;
}

// --- the program the service runs ---------------------------------------------

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const s = join(from, name);
    const d = join(to, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else if (name.endsWith(".js")) writeFileSync(d, readFileSync(s));
  }
}

/** Copy this runner's build to a stable per-version folder; return what to run. */
export function installProgram(): { exe: string; cli: string; version: string } {
  const here = dirname(fileURLToPath(import.meta.url)); // .../dist
  const dest = join(appDir(), RUNNER_VERSION);
  if (!existsSync(join(dest, "cli.js"))) {
    copyDir(here, dest);
    writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "tango-runner", version: RUNNER_VERSION, type: "module", private: true }, null, 2) + "\n");
  }
  return { exe: process.execPath, cli: join(dest, "cli.js"), version: RUNNER_VERSION };
}

let cachedPath: string | undefined;
/** The login shell's PATH (plus common tool folders), so woken agents find claude, codex, hermes… */
export function userPath(): string {
  if (cachedPath) return cachedPath;
  const sep = isWin ? ";" : ":";
  let shellPath = process.env.PATH ?? "";
  if (!isWin) {
    try {
      const out = execFileSync(process.env.SHELL || "/bin/sh", ["-ilc", 'printf "__P__%s__P__" "$PATH"'], {
        timeout: 6000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/__P__([\s\S]*?)__P__/);
      if (m?.[1]) shellPath = m[1];
    } catch {
      // keep this process's PATH
    }
  }
  const extra = isWin
    ? []
    : [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", join(homedir(), ".npm-global", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  // The Node that runs the service must be findable too (npx, harness shims).
  const nodeDir = dirname(process.execPath);
  cachedPath = [...new Set([...shellPath.split(sep), nodeDir, ...extra].filter(Boolean))].join(sep);
  return cachedPath;
}

function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: userPath(), HOME: homedir(), TANGO_RUNNER_SUPERVISOR: process.env.TANGO_RUNNER_SUPERVISOR || "service" };
  if (process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = "1";
  if (process.env.TANGO_RUNNER_HOME) env.TANGO_RUNNER_HOME = process.env.TANGO_RUNNER_HOME;
  return env;
}

function startArgs(prog: { cli: string }, configPath: string): string[] {
  const args = [prog.cli, "start"];
  if (configPath !== defaultConfigPath()) args.push("--config", configPath);
  return args;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- state ------------------------------------------------------------------------

export async function serviceState(configPath = defaultConfigPath()): Promise<ServiceState> {
  if (isMac) {
    const r = await run("launchctl", ["print", `gui/${uid()}/${MAC_LABEL}`]);
    const pid = r.code === 0 ? Number(r.stdout.match(/\n\s*pid = (\d+)/)?.[1]) || null : null;
    const state = r.stdout.match(/\n\s*state = ([a-z ]+)/)?.[1]?.trim();
    return { platform: process.platform, installed: existsSync(plistPath()), loaded: r.code === 0, running: r.code === 0 && state === "running" && !!pid, pid, name: MAC_LABEL };
  }
  if (isWin) {
    const q = await run("schtasks", ["/Query", "/TN", WIN_TASK]);
    const pid = lockHolder(configPath) ?? null;
    return { platform: process.platform, installed: q.code === 0, loaded: q.code === 0, running: !!pid, pid, name: WIN_TASK };
  }
  const a = await run("systemctl", ["--user", "is-active", LINUX_UNIT]);
  const p = await run("systemctl", ["--user", "show", "-p", "MainPID", "--value", LINUX_UNIT]);
  return { platform: process.platform, installed: existsSync(unitPath()), loaded: a.code === 0, running: a.stdout.trim() === "active", pid: Number(p.stdout.trim()) || null, name: LINUX_UNIT };
}

/** After a start, give the service manager a few seconds to bring the process up. */
async function settle(configPath: string, ms = 8000): Promise<ServiceState> {
  const deadline = Date.now() + ms;
  let st = await serviceState(configPath);
  while (!st.running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    st = await serviceState(configPath);
  }
  return st;
}

// --- install / remove -----------------------------------------------------------

/**
 * Install (or repair) the service and start it. A runner already running for this
 * config outside the service would make the service fail on the lock, so it is
 * refused unless `replace` — then that runner gets SIGTERM and up to 75s to
 * finish its current runs first.
 */
export async function installService(configPath = defaultConfigPath(), opts: { replace?: boolean } = {}): Promise<ServiceState> {
  const before = await serviceState(configPath);
  const holder = lockHolder(configPath);
  if (holder && holder !== before.pid) {
    if (!opts.replace) {
      throw new Error(`A runner is already running for this config (pid ${holder}), outside the service. Stop it, or run: tango-runner service install --replace`);
    }
    process.kill(holder, "SIGTERM");
    const deadline = Date.now() + 75_000;
    while (lockHolder(configPath) === holder && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (lockHolder(configPath) === holder) throw new Error(`The other runner (pid ${holder}) is still finishing a run. Try again in a minute.`);
  }

  mkdirSync(dirname(serviceLogPath()), { recursive: true });
  const prog = installProgram();
  const args = startArgs(prog, configPath);
  const env = serviceEnv();
  const log = serviceLogPath();

  if (isMac) {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(
      plistPath(),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key><array>
${[prog.exe, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>WorkingDirectory</key><string>${xml(stateDir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`,
    );
    await run("launchctl", ["bootout", `gui/${uid()}/${MAC_LABEL}`]);
    const r = await run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath()]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
  } else if (isWin) {
    mkdirSync(appDir(), { recursive: true });
    const cmdPath = join(appDir(), "run-runner.cmd");
    const vbsPath = join(appDir(), "run-runner.vbs");
    const stopFlag = join(appDir(), "stop.flag");
    const q = (s: string) => `"${s}"`;
    writeFileSync(
      cmdPath,
      [
        "@echo off",
        ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`),
        ":loop",
        `if exist ${q(stopFlag)} goto end`,
        `${q(prog.exe)} ${args.map(q).join(" ")} >> ${q(log)} 2>&1`,
        "timeout /t 15 /nobreak >nul",
        "goto loop",
        ":end",
      ].join("\r\n"),
    );
    writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run "cmd /c """"${cmdPath}""""", 0, False\r\n`);
    try {
      unlinkSync(stopFlag);
    } catch {
      // not stopped
    }
    const r = await run("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", WIN_TASK, "/TR", `wscript.exe "${vbsPath}"`]);
    if (r.code !== 0) throw new Error(`schtasks failed: ${(r.stderr || r.stdout).trim()}`);
    await run("schtasks", ["/Run", "/TN", WIN_TASK]);
  } else {
    mkdirSync(dirname(unitPath()), { recursive: true });
    const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    writeFileSync(
      unitPath(),
      [
        "[Unit]",
        "Description=Tango Runner",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${[prog.exe, ...args].map(quote).join(" ")}`,
        ...Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`),
        `WorkingDirectory=${stateDir()}`,
        "Restart=always",
        "RestartSec=15",
        `StandardOutput=append:${log}`,
        `StandardError=append:${log}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    await run("systemctl", ["--user", "daemon-reload"]);
    const r = await run("systemctl", ["--user", "enable", "--now", LINUX_UNIT]);
    if (r.code !== 0) throw new Error(`systemctl failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return settle(configPath);
}

/** Stop the runner and remove it from login. */
export async function uninstallService(configPath = defaultConfigPath()): Promise<ServiceState> {
  if (isMac) {
    await run("launchctl", ["bootout", `gui/${uid()}/${MAC_LABEL}`]);
    try {
      unlinkSync(plistPath());
    } catch {
      // already gone
    }
  } else if (isWin) {
    await stopService(configPath);
    await run("schtasks", ["/Delete", "/F", "/TN", WIN_TASK]);
  } else {
    await run("systemctl", ["--user", "disable", "--now", LINUX_UNIT]);
    try {
      unlinkSync(unitPath());
    } catch {
      // already gone
    }
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  return serviceState(configPath);
}

export async function startService(configPath = defaultConfigPath()): Promise<ServiceState> {
  const st = await serviceState(configPath);
  if (!st.installed) return installService(configPath);
  if (isMac) {
    const r = st.loaded ? await run("launchctl", ["kickstart", `gui/${uid()}/${MAC_LABEL}`]) : await run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath()]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  } else if (isWin) {
    try {
      unlinkSync(join(appDir(), "stop.flag"));
    } catch {
      // not stopped
    }
    await run("schtasks", ["/Run", "/TN", WIN_TASK]);
  } else {
    await run("systemctl", ["--user", "start", LINUX_UNIT]);
  }
  return settle(configPath);
}

/** Stop until the next login; the service stays installed. */
export async function stopService(configPath = defaultConfigPath()): Promise<ServiceState> {
  if (isMac) await run("launchctl", ["bootout", `gui/${uid()}/${MAC_LABEL}`]);
  else if (isWin) {
    mkdirSync(appDir(), { recursive: true });
    writeFileSync(join(appDir(), "stop.flag"), "stop");
    const pid = lockHolder(configPath);
    if (pid) await run("taskkill", ["/PID", String(pid), "/T"]);
  } else await run("systemctl", ["--user", "stop", LINUX_UNIT]);
  return serviceState(configPath);
}

export async function restartService(configPath = defaultConfigPath()): Promise<ServiceState> {
  const st = await serviceState(configPath);
  if (!st.installed) return installService(configPath);
  if (isMac) {
    if (!st.loaded) return startService(configPath);
    const r = await run("launchctl", ["kickstart", "-k", `gui/${uid()}/${MAC_LABEL}`]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  } else if (isWin) {
    await stopService(configPath);
    await new Promise((r) => setTimeout(r, 2000));
    await startService(configPath);
  } else await run("systemctl", ["--user", "restart", LINUX_UNIT]);
  return settle(configPath);
}
