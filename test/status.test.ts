import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StatusWriter, type RunnerStatus } from "../src/status.js";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as RunnerStatus;

test("status.json tracks contact, runs and state, and never holds a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "tr-status-"));
  const path = join(dir, "status.json");
  const w = new StatusWriter(
    { version: "0.5.0", config: "/x/config.json", tangoUrl: "https://t", agents: [{ name: "claude", harness: "claude" }] },
    path,
    0, // no throttle in tests
  );
  w.flush();
  let s = read(path);
  assert.equal(s.state, "running");
  assert.equal(s.pid, process.pid);
  assert.equal(s.agents[0].last_contact_at, null);

  w.contact("claude", true);
  w.runStarted("claude", "task:1");
  s = read(path);
  assert.ok(s.agents[0].last_contact_at);
  assert.equal(s.agents[0].active_runs, 1);
  assert.equal(s.agents[0].last_run?.key, "task:1");

  w.runEnded("claude", "task:1", "done");
  w.contact("claude", false, "HTTP 502");
  w.mode("claude", "poll");
  s = read(path);
  assert.equal(s.agents[0].active_runs, 0);
  assert.equal(s.agents[0].last_run?.result, "done");
  assert.equal(s.agents[0].last_error, "HTTP 502");
  assert.equal(s.agents[0].mode, "poll");

  w.setState("stopped");
  s = read(path);
  assert.equal(s.state, "stopped");
  assert.ok(!JSON.stringify(s).includes("tng_"));
});

test("unknown agents are ignored and active_runs never goes negative", () => {
  const dir = mkdtempSync(join(tmpdir(), "tr-status-"));
  const path = join(dir, "status.json");
  const w = new StatusWriter({ version: "0.5.0", config: "c", tangoUrl: "u", agents: [{ name: "a", harness: "command" }] }, path, 0);
  w.contact("nobody", true);
  w.runEnded("a", "task:x", "done");
  w.flush();
  assert.equal(read(path).agents[0].active_runs, 0);
});
