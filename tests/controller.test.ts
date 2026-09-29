import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleConfig } from "../src/config.js";
import { Controller } from "../src/controller.js";
import { GitWorkspaces } from "../src/git.js";
import { Store } from "../src/store.js";
import type {
  Decision,
  Job,
  ModelProvider,
  ModelRequest,
  PullRequest,
} from "../src/types.js";

function fixture(t: TestContext, values = [2]) {
  const directory = mkdtempSync(join(tmpdir(), "reviewloop-controller-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = join(directory, "seed");
  const bare = join(directory, "remote.git");
  mkdirSync(seed);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: seed, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet", "--initial-branch=feature");
  writeFileSync(join(seed, "value.cjs"), "module.exports = 1;\n");
  writeFileSync(
    join(seed, "value.test.cjs"),
    "const {test} = require('node:test'); const assert = require('node:assert/strict'); test('review request', () => assert.equal(require('./value.cjs'), 2));\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "Fixture");
  git("init", "--quiet", "--bare", bare);
  git("push", bare, "HEAD:refs/heads/feature");
  const headSha = git("rev-parse", "HEAD");
  const snapshot: PullRequest = {
    repo: "owner/repo",
    number: 1,
    title: "Fix value",
    url: "https://example.invalid/pr/1",
    author: "owner",
    authorId: 7,
    headSha,
    baseSha: headSha,
    headRef: "feature",
    headRepo: "owner/repo",
    state: "open",
    feedback: "Return 2 and preserve the regression test",
    fingerprint: "initial",
  };
  const config = exampleConfig();
  config.runtime.stateDir = join(directory, "state");
  config.runtime.sandbox = "unsafe-local";
  config.runtime.maxRepairAttempts = 2;
  config.github.repositories = [
    { name: "owner/repo", checks: ["node --test value.test.cjs"] },
  ];
  let snapshotNow = structuredClone(snapshot);
  let calls = 0;
  const requests: ModelRequest[] = [];
  const model: ModelProvider = {
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const n = calls++;
      return {
        content:
          n % 2 === 0
            ? [
                {
                  type: "tool_use",
                  id: `read-${n}`,
                  name: "read_file",
                  input: { path: "value.cjs" },
                },
                {
                  type: "tool_use",
                  id: `write-${n}`,
                  name: "write_file",
                  input: {
                    path: "value.cjs",
                    content: `module.exports = ${values[Math.min(Math.floor(n / 2), values.length - 1)]};\n`,
                  },
                },
              ]
            : [
                {
                  type: "text",
                  text: "Updated value; the controller must independently verify it.",
                },
              ],
        inputTokens: 80,
        outputTokens: 20,
      };
    },
  };
  const github = {
    async identity() {
      return { login: "owner", id: 7 };
    },
    async listPullRequests() {
      return snapshotNow.state === "open" ? [structuredClone(snapshotNow)] : [];
    },
    async getPullRequest() {
      return structuredClone(snapshotNow);
    },
  };
  let messageId = 100;
  let decisions: Decision[] = [];
  const sent: { job?: Job; text: string; buttons?: boolean }[] = [];
  const telegram = {
    async send(job: Job, text: string, buttons?: boolean) {
      sent.push({ job: structuredClone(job), text, buttons });
      return { messageId: messageId++ };
    },
    async notify(text: string) {
      sent.push({ text });
      return { messageId: messageId++ };
    },
    async poll() {
      const batch = decisions;
      decisions = [];
      return {
        decisions: batch,
        nextOffset: batch.length
          ? Math.max(...batch.map((d) => d.updateId)) + 1
          : 0,
      };
    },
  };
  const workspaces = new GitWorkspaces(config, () => bare);
  let controller = new Controller(config, {
    github,
    telegram,
    git: workspaces,
    model,
    allowUnsafeLocal: true,
  });
  t.after(async () => {
    await controller.stop();
    controller.store.close();
  });
  return {
    config,
    git,
    bare,
    seed,
    snapshot,
    workspaces,
    requests,
    sent,
    get controller() {
      return controller;
    },
    current: () => structuredClone(snapshotNow),
    setSnapshot: (next: PullRequest) => {
      snapshotNow = next;
    },
    setDecisions: (next: Decision[]) => {
      decisions = next;
    },
    restart() {
      controller.store.close();
      controller = new Controller(config, {
        store: new Store(config.runtime.stateDir),
        github,
        telegram,
        git: workspaces,
        model,
        allowUnsafeLocal: true,
      });
    },
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  await f.controller.sync();
  const job = f.controller.store.jobs().at(-1)!;
  await f.controller.processJob(job.id);
  await f.controller.flushNotifications();
  const current = f.controller.store.get(job.id)!;
  assert.equal(current.status, "awaiting_approval", current.error);
  return current;
}
function approve(f: ReturnType<typeof fixture>, job: Job, updateId = 10) {
  return f.controller.decide({
    action: "approve",
    jobId: job.id,
    nonce: job.approvalNonce,
    messageId: job.telegramMessageId,
    updateId,
  });
}

test("real repair loop independently tests, rejects wrong bindings, then publishes exactly approved candidate", async (t) => {
  const f = fixture(t, [3, 2]);
  const job = await ready(f);
  assert.equal(job.attempts, 2);
  assert.equal(job.evidence?.[0]?.exitCode, 0);
  assert.match(job.evidence![0]!.output, /pass 1/);
  assert.ok(
    f.requests.some((r) =>
      JSON.stringify(r.messages).includes("Previous verification failed"),
    ),
  );
  assert.equal(await f.workspaces.remoteHead(job), job.snapshot.headSha);
  assert.throws(
    () =>
      f.controller.decide({
        action: "approve",
        jobId: job.id,
        nonce: "wrong",
        updateId: 1,
      }),
    /token/,
  );
  assert.throws(
    () =>
      f.controller.decide({
        action: "approve",
        jobId: job.id,
        nonce: job.approvalNonce,
        messageId: 999,
        updateId: 2,
      }),
    /Message does not belong/,
  );
  assert.equal(f.controller.store.get(job.id)?.status, "awaiting_approval");
  approve(f, job);
  assert.equal(
    f.controller.decide({
      action: "approve",
      jobId: job.id,
      nonce: job.approvalNonce,
      updateId: 10,
    }),
    "Already processed",
  );
  writeFileSync(
    join(f.workspaces.workspace(job.id), "value.cjs"),
    "module.exports = 999;\n",
  );
  await f.controller.publishApproved();
  assert.equal(f.controller.store.get(job.id)?.status, "published");
  assert.equal(await f.workspaces.remoteHead(job), job.candidateSha);
  assert.equal(
    f.git("--git-dir", f.bare, "show", "refs/heads/feature:value.cjs"),
    "module.exports = 2;",
  );
  assert.ok(
    f.sent.some((s) => s.buttons && s.job?.candidateSha === job.candidateSha),
  );
});

test("reply revision invalidates old approval and durable owner preferences enter next run after restart", async (t) => {
  const f = fixture(t);
  const original = await ready(f);
  f.controller.decide({
    action: "remember",
    text: "Keep explanations concise",
    updateId: 1,
  });
  f.controller.decide({
    action: "revise",
    messageId: original.telegramMessageId,
    text: "Explain the regression clearly",
    updateId: 2,
  });
  const revision = f.controller.store.jobs().find((j) => j.id !== original.id)!;
  assert.equal(f.controller.store.get(original.id)?.status, "stale");
  assert.equal(revision.status, "queued");
  assert.equal(
    f.controller.store.budget(revision).inputTokens,
    original.inputTokens,
  );
  assert.equal(f.controller.store.budget(revision).attempts, original.attempts);
  assert.throws(() => approve(f, original), /not awaiting approval/);
  f.restart();
  await f.controller.recover();
  await f.controller.processJob(revision.id);
  await f.controller.flushNotifications();
  const next = f.controller.store.get(revision.id)!;
  assert.equal(next.status, "awaiting_approval", next.error);
  assert.notEqual(next.approvalNonce, original.approvalNonce);
  assert.ok(
    f.requests.some(
      (r) =>
        JSON.stringify(r.messages).includes("Keep explanations concise") &&
        JSON.stringify(r.messages).includes("Explain the regression clearly"),
    ),
  );
  const memoryId = f.controller.store.memories()[0]!.id;
  f.controller.decide({
    action: "forget",
    text: String(memoryId),
    updateId: 3,
  });
  f.restart();
  assert.deepEqual(f.controller.store.memories(), []);
});

test("fresh feedback after approval invalidates candidate and queues current feedback without pushing", async (t) => {
  const f = fixture(t);
  const job = await ready(f);
  approve(f, job);
  f.setSnapshot({
    ...f.current(),
    feedback: "Also cover zero",
    fingerprint: "feedback-changed",
  });
  await f.controller.publishApproved();
  assert.equal(f.controller.store.get(job.id)?.status, "stale");
  assert.equal(await f.workspaces.remoteHead(job), job.snapshot.headSha);
  await f.controller.sync();
  const latest = f.controller.store.jobs().at(-1)!;
  assert.equal(latest.status, "queued");
  assert.match(latest.feedback, /Also cover zero/);
});

test("remote movement blocks publication even if GitHub snapshot lags", async (t) => {
  const f = fixture(t);
  const job = await ready(f);
  approve(f, job);
  writeFileSync(join(f.seed, "remote.txt"), "Remote update");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "Remote update");
  f.git("push", f.bare, "HEAD:refs/heads/feature");
  const advanced = f.git("rev-parse", "HEAD");
  await f.controller.publishApproved();
  assert.equal(f.controller.store.get(job.id)?.status, "blocked");
  assert.match(f.controller.store.get(job.id)!.error!, /Remote head moved/);
  assert.equal(await f.workspaces.remoteHead(job), advanced);
});

test("failed independent checks exhaust repair bound and never offer approval or push", async (t) => {
  const f = fixture(t, [3]);
  await f.controller.sync();
  const job = f.controller.store.jobs()[0]!;
  await f.controller.processJob(job.id);
  await f.controller.flushNotifications();
  const blocked = f.controller.store.get(job.id)!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.attempts, 2);
  assert.notEqual(blocked.evidence?.[0]?.exitCode, 0);
  assert.equal(blocked.candidateSha, undefined);
  assert.equal(
    f.sent.some((s) => s.buttons),
    false,
  );
  assert.equal(await f.workspaces.remoteHead(job), job.snapshot.headSha);
});

test("restart retains pending approval, recovers interrupted execution and reconciles completed push", async (t) => {
  const f = fixture(t);
  const job = await ready(f);
  f.restart();
  await f.controller.recover();
  assert.equal(f.controller.store.get(job.id)?.status, "awaiting_approval");
  const interrupted = f.controller.store.create({ ...f.snapshot, number: 2 });
  interrupted.status = "running";
  f.controller.store.save(interrupted);
  await f.controller.recover();
  assert.equal(f.controller.store.get(interrupted.id)?.status, "blocked");
  approve(f, job);
  await f.workspaces.publish(job);
  const publishing = f.controller.store.get(job.id)!;
  publishing.status = "publishing";
  f.controller.store.save(publishing);
  f.restart();
  await f.controller.recover();
  assert.equal(f.controller.store.get(job.id)?.status, "published");
});

test("pause prevents approval and processing; rejected commands are recorded once with advancing Telegram offset", async (t) => {
  const f = fixture(t);
  const job = await ready(f);
  f.controller.decide({ action: "pause", updateId: 1 });
  assert.throws(() => approve(f, job), /paused/);
  f.setDecisions([
    { action: "approve", jobId: job.id, nonce: "forged", updateId: 100 },
  ]);
  await f.controller.receive();
  assert.equal(f.controller.store.handled(100), true);
  assert.equal(f.controller.store.getSetting("telegramOffset"), "101");
  assert.equal(f.controller.store.get(job.id)?.status, "awaiting_approval");
  f.controller.decide({ action: "resume", updateId: 101 });
  approve(f, job);
  await f.controller.publishApproved();
  assert.equal(f.controller.store.get(job.id)?.status, "published");
});

test("empty feedback starts no work and a reasoned no-change response creates no approval", async (t) => {
  const f = fixture(t, [1]);
  f.setSnapshot({ ...f.current(), feedback: "", fingerprint: "empty" });
  await f.controller.sync();
  assert.deepEqual(f.controller.store.jobs(), []);
  assert.equal(f.requests.length, 0);
  f.setSnapshot(f.snapshot);
  await f.controller.sync();
  const job = f.controller.store.jobs()[0]!;
  await f.controller.processJob(job.id);
  assert.equal(f.controller.store.get(job.id)?.status, "no_change");
  assert.equal(f.controller.store.get(job.id)?.approvalNonce, undefined);
  assert.equal(await f.workspaces.remoteHead(job), job.snapshot.headSha);
});

test("expired approval or changed trusted configuration cannot authorize publication", async (t) => {
  const f = fixture(t);
  const job = await ready(f);
  const expiry = job.approvalExpiresAt;
  job.approvalExpiresAt = new Date(Date.now() - 1000).toISOString();
  f.controller.store.save(job);
  assert.throws(() => approve(f, job, 40), /expired/);
  job.approvalExpiresAt = expiry;
  f.controller.store.save(job);
  f.config.runtime.maxChangedFiles++;
  assert.throws(() => approve(f, job, 41), /Configuration changed/);
  assert.equal(await f.workspaces.remoteHead(job), job.snapshot.headSha);
});
