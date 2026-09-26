import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SpawnSpec } from "./adapters/index.js";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

/**
 * Run one agent process. stdout+stderr stream to `logFile`; stdout is also
 * captured (capped) so the adapter can parse a session id out of it.
 * The key is in env only; it is never written to the log header.
 */
export function execRun(
  spec: SpawnSpec,
  opts: { cwd: string; logFile: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  mkdirSync(join(opts.logFile, ".."), { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: "a", mode: 0o600 });
  const shown = spec.shell ? spec.cmd : [spec.cmd, ...spec.args.map((a) => (a.length > 80 ? a.slice(0, 77) + "..." : a))].join(" ");
  log.write(`# ${new Date().toISOString()} cwd=${opts.cwd}\n# $ ${shown}\n`);

  return new Promise((resolve) => {
    const child = spawn(spec.shell ? "sh" : spec.cmd, spec.shell ? ["-c", spec.cmd] : spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // own process group so we can kill the whole tree
    });

    let stdout = "";
    let timedOut = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (child.exitCode === null && child.pid !== undefined) {
          try {
            process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 10_000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log.write(`\n# timed out after ${Math.round(opts.timeoutMs / 1000)}s, killing\n`);
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      log.write("\n# runner stopping, killing run\n");
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      log.write(d);
      if (stdout.length < MAX_CAPTURE) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => log.write(d));
    child.stdin.on("error", () => {}); // child may exit before reading stdin
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      log.end(`\n# exit ${code}${timedOut ? " (timeout)" : ""}\n`);
      resolve({ exitCode: code, timedOut, stdout });
    };
    child.on("error", (err) => {
      log.write(`\n# failed to start: ${err.message}\n`);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
