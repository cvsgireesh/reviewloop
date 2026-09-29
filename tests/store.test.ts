import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import type { PullRequest } from "../src/types.js";
const snapshot: PullRequest = {
  repo: "owner/repo",
  number: 1,
  title: "Fix",
  url: "https://example.invalid/1",
  author: "owner",
  authorId: 1,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  headRef: "feature",
  headRepo: "owner/repo",
  state: "open",
  feedback: "Add tests",
  fingerprint: "snapshot-1",
};

test("preferences, jobs, observations and message binding survive a database reopen", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reviewloop-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  t.after(() => store.close());
  const global = store.remember("Prefer focused tests");
  const scoped = store.remember("Use tabs", "owner/repo");
  store.remember("Use spaces", "owner/other");
  const job = store.create(snapshot);
  store.observe(snapshot);
  store.recordMessage(42, job.id);
  job.status = "published";
  job.summary = "Added regression coverage";
  job.costUsd = 0.02;
  store.save(job);
  store.close();
  store = new Store(dir);
  assert.deepEqual(
    store.memories("owner/repo").map((m) => m.id),
    [global, scoped],
  );
  assert.deepEqual(
    store.memories("unrelated/repo").map((m) => m.id),
    [global],
  );
  assert.equal(store.get(job.id)?.status, "published");
  assert.equal(store.messageJob(42), job.id);
  assert.equal(store.observed(snapshot), true);
  assert.equal(store.observed({ ...snapshot, fingerprint: "changed" }), false);
  assert.deepEqual(store.summaries("owner/repo"), [
    "PR #1: Added regression coverage",
  ]);
  assert.equal(store.totalCost(), 0.02);
  assert.equal(store.forget(scoped), true);
  assert.equal(store.forget(scoped), false);
  store.close();
  store = new Store(dir);
  assert.deepEqual(
    store.memories("owner/repo").map((m) => m.id),
    [global],
  );
});

test("decision transaction rolls back approval, notification, receipt, offset and preferences together", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reviewloop-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  t.after(() => store.close());
  const job = store.create(snapshot);
  job.status = "awaiting_approval";
  store.save(job);
  assert.throws(
    () =>
      store.transaction(() => {
        const current = store.get(job.id)!;
        current.status = "approved";
        store.save(current);
        store.enqueue("approved", "Approval recorded", current);
        store.markHandled(100);
        store.setSetting("telegram.offset", "101");
        store.recordMessage(8, job.id);
        store.remember("Lost preference");
        throw new Error("simulated crash before commit");
      }),
    /simulated crash/,
  );
  store.close();
  store = new Store(dir);
  assert.equal(store.get(job.id)?.status, "awaiting_approval");
  assert.equal(store.handled(100), false);
  assert.equal(store.getSetting("telegram.offset"), "");
  assert.deepEqual(store.outbox(), []);
  assert.equal(store.messageJob(8), undefined);
  assert.deepEqual(store.memories(), []);
  store.transaction(() => {
    const current = store.get(job.id)!;
    current.status = "approved";
    store.save(current);
    store.enqueue("approved", "Approval recorded", current);
    store.markHandled(100);
    store.setSetting("telegram.offset", "101");
  });
  store.close();
  store = new Store(dir);
  assert.equal(store.get(job.id)?.status, "approved");
  assert.equal(store.handled(100), true);
  assert.equal(store.getSetting("telegram.offset"), "101");
  assert.equal(store.outbox().length, 1);
});

test("notification retries survive reopen and duplicate enqueue cannot redeliver completed item", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reviewloop-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  t.after(() => store.close());
  store.enqueue("stable-key", "Needs approval");
  store.enqueue("stable-key", "Duplicate");
  const item = store.outbox()[0]!;
  assert.equal(store.outbox().length, 1);
  store.failed(item, "temporary outage");
  store.close();
  store = new Store(dir);
  assert.equal(store.outbox()[0]?.attempts, 1);
  store.delivered(item.id);
  store.enqueue("stable-key", "Duplicate after delivery");
  assert.deepEqual(store.outbox(), []);
  assert.ok(store.events().some((row) => row.event === "notification.failed"));
});
