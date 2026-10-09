// One-command setup: detect installed agent CLIs, trade a one-time code from
// Tango's "Connect agents" page for worker keys, and write the runner config.
// Detection only resolves binaries and runs `--version`; no project files are read.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import { RUNNER_VERSION } from "./client.js";
import { expandHome, saveConfig, validateConfig } from "./config.js";
import type { AgentConfig, RunnerConfig } from "./types.js";

/** Programs `setup` looks for, in display order. */
export const PROGRAMS = ["claude", "codex", "cursor-agent", "gemini", "opencode", "hermes"] as const;

export interface Detected {
  /** Program id sent to Tango (also the binary name). */
  program: string;
  /** Resolved path, for display only. */
  path: string;
  /** First line of `<bin> --version`, or "" if it printed nothing. */
  version: string;
}

export interface Selection extends Detected {
  cwd: string;
  /** Name sent to Tango; used to match the response back to this selection. */
  name: string;
}

export interface SetupAgent {
  worker_id: string;
  handle: string | null;
  name: string;
  harness: string;
  key?: string;
}

const isWin = process.platform === "win32";

/** `which <bin>` (POSIX) / `where <bin>` (Windows). Returns the path or null. */
export function resolveBinary(bin: string): string | null {
  if (isWin) {
    const r = spawnSync("where", [bin], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (r.status !== 0) return null;
    // `where` lists every match; npm installs an extension-less sh shim next to the .cmd, which Windows can't run.
    const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";");
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => exts.includes(extname(l).toLowerCase())) ?? null;
  }
  const r = spawnSync("which", [bin], { encoding: "utf8", timeout: 3000 });
  if (r.status === 0) return r.stdout.trim().split("\n")[0] || null;
  if (r.error) {
    // Some minimal images ship without `which`.
    const s = spawnSync("sh", ["-c", 'command -v -- "$1"', "sh", bin], { encoding: "utf8", timeout: 3000 });
    if (s.status === 0) return s.stdout.trim().split("\n")[0] || null;
  }
  return null;
}

/** First non-empty line of `<path> --version` (3s timeout), capped to what Tango accepts. */
export function programVersion(path: string): string {
  const r = isWin
    ? spawnSync(`"${path}" --version`, { encoding: "utf8", shell: true, timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawnSync(path, ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.slice(0, 60);
}

export function detectPrograms(programs: readonly string[] = PROGRAMS): Detected[] {
  const found: Detected[] = [];
  for (const program of programs) {
    const path = resolveBinary(program);
    if (path) found.push({ program, path, version: programVersion(path) });
  }
  return found;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Same rules as the server: 8 chars from the alphabet (no 0/O/1/I); case and dash optional. */
export function normalizeCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 8 || [...c].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function agentName(program: string, host: string): string {
  return `${program} on ${host.replace(/[^\w .-]/g, "").slice(0, 60) || "computer"}`.slice(0, 60);
}

/** Line-based prompts: work in any terminal (including Windows) and with piped stdin. */
export class Prompter {
  private rl = createInterface({ input: process.stdin, output: process.stdout });
  private lines: string[] = [];
  private waiting: ((l: string | null) => void) | null = null;
  private closed = false;

  constructor() {
    this.rl.on("line", (l) => (this.waiting ? (this.waiting(l), (this.waiting = null)) : this.lines.push(l)));
    this.rl.on("close", () => {
      this.closed = true;
      this.waiting?.(null);
      this.waiting = null;
    });
  }

  /** Resolves null once stdin is closed. */
  ask(q: string): Promise<string | null> {
    process.stdout.write(q);
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => (this.waiting = r));
  }

  close(): void {
    this.rl.close();
  }
}

export async function choosePrograms(found: Detected[], p: Prompter): Promise<Detected[]> {
  const ticked = found.map(() => true);
  const width = Math.max(...found.map((f) => f.program.length));
  for (;;) {
    found.forEach((f, i) => process.stdout.write(`  ${i + 1}. [${ticked[i] ? "x" : " "}] ${f.program.padEnd(width)}  ${f.version || f.path}\n`));
    const a = await p.ask("Type numbers to tick/untick (e.g. \"2 3\"), or press Enter to continue: ");
    if (a === null || a.trim() === "") return found.filter((_, i) => ticked[i]);
    for (const t of a.split(/[\s,]+/).filter(Boolean)) {
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= found.length) ticked[n - 1] = !ticked[n - 1];
      else process.stdout.write(`  (ignoring "${t}")\n`);
    }
  }
}

export async function chooseFolder(program: string, def: string, p: Prompter): Promise<string> {
  for (;;) {
    const a = await p.ask(`Working folder for ${program} [${def}]: `);
    const dir = a === null || a.trim() === "" ? def : expandHome(a.trim());
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    process.stdout.write(`  ${dir} is not a folder. Try again.\n`);
    if (a === null) return def;
  }
}

export class SetupError extends Error {}

const FRESH_CODE = "Get a fresh setup command from the Connect agents page in Tango.";

/**
 * POST the detected programs. Errors carry only the server's `message` (never the
 * response body of a success, which holds keys).
 */
export async function register(
  url: string,
  body: { code: string; host: string; runner_version: string; agents: Array<{ program: string; version?: string; name?: string }> },
): Promise<{ agents: SetupAgent[]; api_base: string }> {
  const endpoint = `${url.replace(/\/+$/, "")}/api/public/runner/setup`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tango-Runner": `tango-runner/${RUNNER_VERSION}` },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  } catch (e) {
    throw new SetupError(`Could not reach ${url}: ${(e as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new SetupError(`${url} redirected to ${res.headers.get("location")}. Pass the canonical Tango URL with --url.`);
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* handled below */
  }
  if (res.ok) {
    const agents = json?.agents;
    if (!Array.isArray(agents)) throw new SetupError(`Unexpected response from ${url} (no agents). ${FRESH_CODE}`);
    const apiBase = typeof json?.api_base === "string" && /^https?:\/\//.test(json.api_base) ? json.api_base : url;
    return { agents: agents as SetupAgent[], api_base: apiBase.replace(/\/+$/, "") };
  }
  const error = typeof json?.error === "string" ? json.error : null;
  const message = typeof json?.message === "string" ? json.message : null;
  if (!error) {
    if (res.status === 404) throw new SetupError(`${url} doesn't support one-command setup (HTTP 404). Check --url, or use: tango-runner init --key tng_...`);
    throw new SetupError(`Setup failed: HTTP ${res.status} from ${url}.`);
  }
  const hint =
    error === "code_used" || error === "code_expired" || error === "setup_failed"
      ? ` ${FRESH_CODE}`
      : error === "invalid_code" && res.status === 400
        ? " Codes look like ABCD-2345 (no 0, O, 1 or I)."
        : error === "invalid_json" || error === "invalid_input"
          ? " (The runner sent a request Tango didn't accept; try npx tango-runner@latest.)"
          : "";
  throw new SetupError(`${message ?? `Setup failed (${error}).`}${hint}`);
}

/**
 * How to run a program headless with the prompt on stdin, where its bare name
 * would open an interactive session instead. Checked against each CLI's --help.
 */
const HEADLESS: Record<string, string> = {
  hermes: "hermes chat --query-file - --oneshot",
};

/** Tango harness id → runner harness, per the setup contract. */
export function toAgentConfig(a: SetupAgent, sel: Selection): AgentConfig {
  const base = { name: (a.handle || a.name).trim(), key: a.key!, cwd: sel.cwd };
  if (a.harness === "claude-code") return { ...base, harness: "claude" };
  if (a.harness === "codex") return { ...base, harness: "codex" };
  return { ...base, harness: "command", command: HEADLESS[sel.program] ?? sel.program };
}

/** The Tango harness the server will assign to a program (mirrors its map). */
function expectedHarness(program: string): string {
  const m: Record<string, string> = { claude: "claude-code", codex: "codex", "cursor-agent": "cursor", gemini: "gemini", opencode: "opencode", hermes: "hermes" };
  return m[program] ?? "command";
}

/** Pair each returned agent with the selection it came from; agents without a key are reported as skipped. */
export function matchAgents(returned: SetupAgent[], sels: Selection[]): { entries: AgentConfig[]; skipped: string[] } {
  const unused = new Set(sels);
  const entries: AgentConfig[] = [];
  const skipped: string[] = [];
  for (const a of returned) {
    const sel = [...unused].find((s) => s.name === a.name) ?? [...unused].find((s) => expectedHarness(s.program) === a.harness);
    if (sel) unused.delete(sel);
    if (!sel || typeof a.key !== "string" || !a.key) {
      skipped.push(a.handle || a.name || sel?.program || "?");
      continue;
    }
    entries.push(toAgentConfig(a, sel));
  }
  for (const s of unused) skipped.push(s.program);
  return { entries, skipped };
}

/** Existing config, read without validating keys (key_env vars may not be set in this shell). Throws if unreadable. */
export function readExistingConfig(path: string): RunnerConfig | null {
  if (!existsSync(path)) return null;
  let cfg: RunnerConfig;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as RunnerConfig;
  } catch (e) {
    throw new SetupError(`${path} isn't valid JSON (${(e as Error).message}). Fix or move it, then run setup again.`);
  }
  if (!cfg || typeof cfg !== "object" || (cfg.agents !== undefined && !Array.isArray(cfg.agents))) {
    throw new SetupError(`${path} doesn't look like a tango-runner config. Fix or move it, then run setup again.`);
  }
  return { ...cfg, agents: cfg.agents ?? [] };
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  }
}

/**
 * Append new agents, leaving existing entries untouched. A name already in the
 * file gets a numeric suffix rather than replacing the old entry.
 */
export function appendAgents(path: string, existing: RunnerConfig | null, tangoUrl: string, entries: AgentConfig[]): AgentConfig[] {
  const cfg: RunnerConfig = existing ? { ...existing, agents: [...existing.agents] } : { tango_url: tangoUrl, agents: [] };
  cfg.tango_url = tangoUrl;
  const taken = new Set(cfg.agents.map((a) => a.name));
  const added: AgentConfig[] = [];
  for (const e of entries) {
    let name = e.name;
    for (let i = 2; taken.has(name); i++) name = `${e.name}-${i}`;
    taken.add(name);
    added.push({ ...e, name });
  }
  validateConfig({ tango_url: tangoUrl, agents: added });
  cfg.agents.push(...added);
  saveConfig(cfg, path);
  return added;
}
