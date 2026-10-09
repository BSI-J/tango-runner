// `setup` end to end: the real CLI, fake agent binaries on PATH, a mock Tango.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RUNNER_VERSION } from "../src/client.js";
import { matchAgents, normalizeCode, type Selection } from "../src/setup.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const posix = process.platform !== "win32";

function fakeBins(names: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tango-runner-bin-"));
  for (const [name, version] of Object.entries(names)) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${version}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

type Reply = { status: number; body: unknown; raw?: string };

function mockTango(reply: (body: Record<string, unknown>) => Reply, knownKeys: string[] = []) {
  const setupBodies: Array<Record<string, unknown>> = [];
  const keys = new Set<string>(knownKeys);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown, raw?: string) => {
      res.writeHead(code, { "content-type": raw ? "text/html" : "application/json" });
      res.end(raw ?? JSON.stringify(body));
    };
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api/public/runner/setup" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw) as Record<string, unknown>;
      setupBodies.push(body);
      const r = reply(body);
      for (const a of ((r.body as { agents?: Array<{ key?: string }> })?.agents ?? [])) if (a.key) keys.add(a.key);
      return send(r.status, r.body, r.raw);
    }
    const auth = req.headers.authorization?.replace(/^Bearer /, "");
    if (!auth || !keys.has(auth)) return send(401, { error: "bad key" });
    if (url.pathname === "/api/public/workers/heartbeat") return send(200, { ok: true, worker_id: "w" });
    if (url.pathname === "/api/public/workers/wait") return send(200, { events: [], cursor: "0" });
    send(404, { error: "Not found" });
  });
  return {
    setupBodies,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => server.close(),
  };
}

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { TANGO_RUNNER_NO_BUNDLED: "1", ...env, HOME: cwd }, cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

const okReply = (keyFor: (program: string) => string | undefined) => (body: Record<string, unknown>): Reply => {
  const agents = (body.agents as Array<{ program: string; name: string }>).map((a, i) => ({
    worker_id: `w${i}`,
    handle: `${a.program}-bot`,
    name: a.name,
    harness: a.program === "claude" ? "claude-code" : a.program,
    key: keyFor(a.program),
  }));
  return { status: 200, body: { agents, api_base: "" } };
};

test("normalizeCode follows the server's alphabet", () => {
  assert.equal(normalizeCode("abcd2345"), "ABCD-2345");
  assert.equal(normalizeCode("ABCD-2345"), "ABCD-2345");
  assert.equal(normalizeCode("ABC0-2345"), null);
  assert.equal(normalizeCode("ABCD-234"), null);
});

test("RUNNER_VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
  assert.equal(RUNNER_VERSION, pkg.version);
});

test("matchAgents pairs by name, then by harness, and reports keyless agents", () => {
  const sel = (program: string, bin = program): Selection => ({ program, path: `/bin/${program}`, bin, version: "1", cwd: "/w", name: `${program} on h` });
  const { entries, skipped } = matchAgents(
    [
      { worker_id: "1", handle: null, name: "renamed", harness: "codex", key: "tng_aaaaaaaaaaaaaaaa" },
      { worker_id: "2", handle: "g", name: "gemini on h", harness: "gemini", key: "" },
      { worker_id: "3", handle: "c", name: "claude on h", harness: "claude-code", key: "tng_bbbbbbbbbbbbbbbb" },
    ],
    [sel("claude"), sel("codex"), sel("gemini"), sel("hermes")],
  );
  assert.deepEqual(entries, [
    { name: "renamed", key: "tng_aaaaaaaaaaaaaaaa", cwd: "/w", harness: "codex" },
    { name: "c", key: "tng_bbbbbbbbbbbbbbbb", cwd: "/w", harness: "claude" },
  ]);
  assert.deepEqual(skipped, ["g", "hermes"]);
  const h = matchAgents([{ worker_id: "4", handle: "h", name: "hermes on h", harness: "hermes", key: "tng_cccccccccccccccc" }], [sel("hermes")]);
  assert.equal(h.entries[0].command, "hermes chat --query-file - --oneshot");
  const c = matchAgents([{ worker_id: "7", handle: "c", name: "cursor-agent on h", harness: "cursor", key: "tng_ffffffffffffffff" }], [sel("cursor-agent")]);
  assert.equal(c.entries[0].command, "cursor-agent -p --trust --force");
  const g = matchAgents([{ worker_id: "6", handle: "a", name: "agy on h", harness: "command", key: "tng_eeeeeeeeeeeeeeee" }], [sel("agy")]);
  assert.equal(g.entries[0].command, 'agy --dangerously-skip-permissions -p "$(cat)"');
  const app = "/Applications/OpenCode.app/Contents/Resources/opencode-cli";
  const o = matchAgents([{ worker_id: "5", handle: "o", name: "opencode on h", harness: "opencode", key: "tng_dddddddddddddddd" }], [sel("opencode", app)]);
  assert.equal(o.entries[0].command, `${app} run --standalone --auto`);
});

test("setup --yes registers detected programs and appends a 0600 config", { skip: !posix }, async () => {
  const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
  const work = join(realpathSync(home), "repo");
  mkdirSync(work);
  const bins = fakeBins({ claude: "2.1.9 (Claude Code)", gemini: "0.9.0" });
  const keys: Record<string, string> = { claude: "tng_claudekey_0123456789", gemini: "tng_geminikey_0123456789" };
  const tango = mockTango(okReply((p) => keys[p]), ["tng_priorkey_0123456789"]);
  const url = await tango.listen();
  const configPath = join(home, "cfg", "config.json");
  mkdirSync(join(home, "cfg"));
  const prior = { tango_url: url, poll_seconds: 5, agents: [{ name: "claude-bot", harness: "claude", key_env: "PRIOR_KEY", cwd: home }] };
  writeFileSync(configPath, JSON.stringify(prior));

  const r = await runCli(["setup", "--code", "abcd-2345", "--url", url, "--yes", "--no-start", "--config", configPath], { PATH: `${bins}:/usr/bin:/bin`, PRIOR_KEY: "tng_priorkey_0123456789" }, work);
  tango.close();
  assert.equal(r.code, 0, r.out);

  const body = tango.setupBodies[0]!;
  assert.equal(body.code, "ABCD-2345");
  assert.equal(body.runner_version, RUNNER_VERSION);
  assert.equal(typeof body.host, "string");
  assert.deepEqual(
    (body.agents as Array<{ program: string; version: string }>).map((a) => [a.program, a.version]),
    [["claude", "2.1.9 (Claude Code)"], ["gemini", "0.9.0"]],
  );

  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(cfg.poll_seconds, 5);
  assert.deepEqual(cfg.agents, [
    prior.agents[0],
    { name: "claude-bot-2", key: keys.claude, cwd: work, harness: "claude" },
    { name: "gemini-bot", key: keys.gemini, cwd: work, harness: "command", command: "gemini --skip-trust --approval-mode yolo -p 'Do what the instructions above say.'" },
  ]);
  assert.match(r.out, /✓ key .* works/);
  for (const k of Object.values(keys)) assert.ok(!r.out.includes(k), "key leaked to output");
});

test("setup --yes sends at most 6 agents and says which it skipped", { skip: !posix }, async () => {
  const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
  const bins = fakeBins({ claude: "1", codex: "1", "cursor-agent": "1", agy: "1", gemini: "1", opencode: "1", hermes: "1" });
  const tango = mockTango(okReply((p) => `tng_${p.replace(/\W/g, "")}_key_0123456789`));
  const url = await tango.listen();
  const r = await runCli(["setup", "--code", "ABCD-2345", "--url", url, "--yes", "--no-start", "--config", join(home, "c.json")], { PATH: `${bins}:/usr/bin:/bin` }, home);
  tango.close();
  assert.equal((tango.setupBodies[0]!.agents as unknown[]).length, 6);
  assert.match(r.out, /at most 6 agents at a time; skipping hermes/);
});

test("setup reports agents that came back without a key", { skip: !posix }, async () => {
  const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
  const bins = fakeBins({ claude: "2.1.9", opencode: "0.3.1" });
  const tango = mockTango(okReply((p) => (p === "claude" ? "tng_claudekey_0123456789" : undefined)));
  const url = await tango.listen();
  const configPath = join(home, "config.json");
  const r = await runCli(["setup", "--code", "ABCD-2345", "--url", url, "--yes", "--no-start", "--config", configPath], { PATH: `${bins}:/usr/bin:/bin` }, home);
  tango.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Skipped \(Tango returned no key\): opencode-bot/);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).agents.map((a: { name: string }) => a.name), ["claude-bot"]);
});

for (const [status, error, message] of [
  [410, "code_used", "That setup code was already used."],
  [410, "code_expired", "That setup code expired. Create a new one in Tango."],
  [404, "invalid_code", "That setup code is not valid."],
  [500, "setup_failed", "Could not create agents. Try again with a new code."],
] as const) {
  test(`setup exits 1 with the server's message on ${status} ${error}`, { skip: !posix }, async () => {
    const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
    const bins = fakeBins({ codex: "codex-cli 0.159.0" });
    const tango = mockTango(() => ({ status, body: { error, message } }));
    const url = await tango.listen();
    const configPath = join(home, "config.json");
    const r = await runCli(["setup", "--code", "ABCD-2345", "--url", url, "--yes", "--config", configPath], { PATH: `${bins}:/usr/bin:/bin` }, home);
    tango.close();
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(message), r.out);
    assert.equal(r.out.includes("Connect agents page"), error !== "invalid_code");
    assert.equal(tango.setupBodies.length, 1, "must not retry");
    assert.throws(() => statSync(configPath));
  });
}

test("setup explains a server without the endpoint instead of dumping HTML", { skip: !posix }, async () => {
  const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
  const bins = fakeBins({ codex: "codex-cli 0.159.0" });
  const tango = mockTango(() => ({ status: 404, body: null, raw: "<!DOCTYPE html><html>404</html>" }));
  const url = await tango.listen();
  const r = await runCli(["setup", "--code", "ABCD-2345", "--url", url, "--yes", "--config", join(home, "c.json")], { PATH: `${bins}:/usr/bin:/bin` }, home);
  tango.close();
  assert.equal(r.code, 1);
  assert.match(r.out, /doesn't support one-command setup/);
  assert.ok(!r.out.includes("<html"));
});

test("setup rejects a malformed code before calling Tango", async () => {
  const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
  const r = await runCli(["setup", "--code", "OOOO-1111", "--url", "http://127.0.0.1:9", "--yes"], { PATH: process.env.PATH ?? "" }, home);
  assert.equal(r.code, 1);
  assert.match(r.out, /ABCD-2345/);
});

test("setup with nothing installed points at init --key and exits 1", { skip: !posix }, async () => {
  const home = mkdtempSync(join(tmpdir(), "tango-runner-home-"));
  const empty = mkdtempSync(join(tmpdir(), "tango-runner-bin-"));
  const r = await runCli(["setup", "--code", "ABCD-2345", "--url", "http://127.0.0.1:9", "--yes"], { PATH: `${empty}:/usr/bin:/bin` }, home);
  assert.equal(r.code, 1);
  assert.match(r.out, /init --key/);
});
