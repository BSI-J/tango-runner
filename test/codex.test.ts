import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexSpec } from "../src/adapters/codex.js";
import type { AgentConfig } from "../src/types.js";

const agent: AgentConfig = { name: "c", key: "tng_x", harness: "codex", cwd: "/tmp" };
const input = (sessionId?: string, a: AgentConfig = agent) => ({
  agent: a,
  tangoUrl: "https://tango.example",
  key: "tng_x",
  prompt: "do it",
  systemRules: "rules",
  sessionId,
  eventsJson: "[]",
  wakeKey: "task:1",
  runDir: mkdtempSync(join(tmpdir(), "codex-spec-")),
});

test("codex: sandboxed without approval prompts, and never the removed --full-auto", () => {
  for (const spec of [codexSpec(input()), codexSpec(input("thread-1"))]) {
    assert.ok(!spec.args.includes("--full-auto"));
    assert.ok(!spec.args.includes("--sandbox"), "exec resume rejects --sandbox");
    assert.ok(spec.args.includes('sandbox_mode="workspace-write"'));
    assert.ok(spec.args.includes('approval_policy="never"'));
    assert.ok(!spec.args.some((x) => x.includes("tng_")), "key stays out of argv");
  }
  assert.deepEqual(codexSpec(input("thread-1")).args.slice(0, 3), ["exec", "resume", "thread-1"]);
});

test("codex: extra_args replaces the defaults", () => {
  const spec = codexSpec(input(undefined, { ...agent, extra_args: ["--dangerously-bypass-approvals-and-sandbox"] }));
  assert.ok(spec.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!spec.args.includes('sandbox_mode="workspace-write"'));
});
