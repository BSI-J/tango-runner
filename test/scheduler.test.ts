import assert from "node:assert/strict";
import { test } from "node:test";
import { keyFor, Scheduler } from "../src/scheduler.js";
import type { WakeEvent } from "../src/types.js";

function ev(id: number, over: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id: String(id),
    type: "task.assigned",
    created_at: new Date().toISOString(),
    task_id: "t1",
    thread_id: null,
    message_id: null,
    actor: { kind: "worker", id: "other", handle: "@other", is_self: false },
    title: "T",
    summary: "s",
    payload: {},
    ...over,
  };
}

function harness(opts: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
  const runs: Array<{ key: string; ids: string[]; finish: () => void }> = [];
  const acks: string[] = [];
  const s = new Scheduler({
    agentName: "t",
    maxConcurrent: 2,
    maxRunsPerHour: 100,
    maxSelfFollowups: 2,
    debounceMs: 0,
    run: (key, events) =>
      new Promise<void>((finish) => runs.push({ key, ids: events.map((e) => e.id), finish })),
    onAck: (c) => acks.push(c),
    ...opts,
  });
  return { s, runs, acks };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("keys group by task, thread, inbox", () => {
  assert.equal(keyFor(ev(1)), "task:t1");
  assert.equal(keyFor(ev(2, { task_id: null, thread_id: "th", type: "message.received" })), "thread:th");
  assert.equal(keyFor(ev(3, { task_id: null, type: "message.received" })), "inbox");
});

test("events for one task coalesce into a single run", async () => {
  const { s, runs } = harness();
  s.receive([ev(1), ev(2, { type: "task.commented" })]);
  await tick();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].ids, ["1", "2"]);
});

test("one run per task at a time; events during a run become a follow-up", async () => {
  const { s, runs } = harness();
  s.receive([ev(1)]);
  await tick();
  s.receive([ev(2, { type: "task.commented" })]);
  await tick();
  assert.equal(runs.length, 1, "no concurrent run on the same task");
  runs[0].finish();
  await tick();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].ids, ["2"]);
});

test("different tasks run in parallel up to maxConcurrent", async () => {
  const { s, runs } = harness({ maxConcurrent: 2 });
  s.receive([ev(1, { task_id: "a" }), ev(2, { task_id: "b" }), ev(3, { task_id: "c" })]);
  await tick();
  assert.equal(runs.length, 2);
  runs[0].finish();
  await tick();
  assert.equal(runs.length, 3);
});

test("self-caused and non-wake events are skipped but still acked", async () => {
  const { s, runs, acks } = harness();
  s.receive([
    ev(1, { actor: { kind: "worker", id: "me", handle: "@me", is_self: true } }),
    ev(2, { type: "task.created" }),
  ]);
  await tick();
  assert.equal(runs.length, 0);
  assert.equal(acks.at(-1), "2");
});

test("ack watermark never passes an unfinished event", async () => {
  const { s, runs, acks } = harness();
  s.receive([ev(10, { task_id: "a" }), ev(11, { task_id: "b" })]);
  await tick();
  runs[1].finish(); // 11 done, 10 still running
  await tick();
  assert.ok(!acks.includes("11"), "must not ack past 10 while it runs");
  runs[0].finish();
  await tick();
  assert.equal(acks.at(-1), "11");
});

test("redelivered events are ignored", async () => {
  const { s, runs } = harness();
  s.receive([ev(5)]);
  await tick();
  runs[0].finish();
  await tick();
  s.receive([ev(5)]);
  await tick();
  assert.equal(runs.length, 1);
});

test("follow-ups fed only by events during runs are capped (loop guard)", async () => {
  const { s, runs } = harness({ maxSelfFollowups: 2 });
  s.receive([ev(1)]);
  await tick();
  for (let i = 0; i < 3; i++) {
    s.receive([ev(100 + i, { type: "task.commented" })]); // arrives while run i is active
    await tick();
    runs.at(-1)!.finish();
    await tick();
  }
  // initial run + 2 follow-ups; the 3rd follow-up is dropped
  assert.equal(runs.length, 3);
  // fresh activity after going idle resets the streak
  s.receive([ev(200, { type: "task.commented" })]);
  await tick();
  assert.equal(runs.length, 4);
});

test("runs per hour are capped", async () => {
  let now = 1_000_000;
  const { s, runs } = harness({ maxRunsPerHour: 2, now: () => now });
  s.receive([ev(1, { task_id: "a" }), ev(2, { task_id: "b" }), ev(3, { task_id: "c" })]);
  await tick();
  assert.equal(runs.length, 2);
  runs[0].finish();
  runs[1].finish();
  await tick();
  assert.equal(runs.length, 2, "third run waits for the window");
  s.stop();
});

test("synthetic (polled) events run without touching the ack cursor", async () => {
  const { s, runs, acks } = harness();
  s.receive([ev(0, { id: "poll-1", synthetic: true })]);
  await tick();
  runs[0].finish();
  await tick();
  assert.equal(runs.length, 1);
  assert.equal(acks.length, 0);
});
