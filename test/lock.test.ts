import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, lockHolder, lockPath } from "../src/lock.js";

test("lock: a live holder blocks a second runner; a dead one doesn't", async () => {
  const cfg = join(mkdtempSync(join(tmpdir(), "lock-")), "config.json");
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  try {
    writeFileSync(lockPath(cfg), String(other.pid));
    assert.equal(lockHolder(cfg), other.pid);
    assert.throws(() => acquireLock(cfg), /already running/);
  } finally {
    other.kill();
    await new Promise((r) => other.on("exit", r));
  }
  assert.equal(lockHolder(cfg), undefined, "dead pid is a stale lock");
  acquireLock(cfg);
  assert.ok(existsSync(lockPath(cfg)));
  assert.equal(lockHolder(cfg), undefined, "our own lock isn't reported as another runner");
});
