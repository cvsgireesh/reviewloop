import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { GitWorkspaces } from "../src/git.js";
import { Store } from "../src/store.js";
import { exampleConfig, policyHash } from "../src/config.js";
import type { ModelProvider, PullRequest, Job } from "../src/types.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "reviewloop-governance-"));
  const seed = join(dir, "seed"),
    bare = join(dir, "remote.git");
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
        "user.email=fixture@localhost",
        ...args,
      ],
      { cwd: seed, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-q", "--initial-branch=feature");
  writeFileSync(join(seed, "value.cjs"), "module.exports = 1;\n");
  writeFileSync(
    join(seed, "check.cjs"),
    "require('node:assert/strict').equal(require('./value.cjs'), 2);\n",
  );
  writeFileSync(join(seed, ".gitignore"), "helper.cjs\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ scripts: { test: "node check.cjs" } }),
  );
  writeFileSync(join(seed, ".gitattributes"), "retained.txt export-ignore\n");
  writeFileSync(
    join(seed, "retained.txt"),
    "must survive exact materialization\n",
  );
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("init", "-q", "--bare", bare);
  git("push", bare, "HEAD:refs/heads/feature");
  const sha = git("rev-parse", "HEAD");
  const snapshot: PullRequest = {
    repo: "owner/repo",
    number: 1,
    title: "Fix value",
    url: "https://example.invalid/1",
    author: "owner",
    authorId: 1,
    headSha: sha,
    baseSha: sha,
    headRef: "feature",
    headRepo: "owner/repo",
    state: "open",
    feedback: "Return 2",
    fingerprint: "initial",
  };
  const config = exampleConfig();
  config.runtime.stateDir = join(dir, "state");
  config.runtime.sandbox = "unsafe-local";
  config.runtime.maxRepairAttempts = 3;
  config.github.repositories = [
    { name: snapshot.repo, checks: ["node check.cjs"] },
  ];
  const workspace = new GitWorkspaces(config, () => bare);
  const stores: Store[] = [];
  let calls = 0;
  const goodModel: ModelProvider = {
    async complete() {
      return {
        content:
          calls++ % 2 === 0
            ? [
                {
                  type: "tool_use",
                  id: `write-${calls}`,
                  name: "write_file",
                  input: {
                    path: "value.cjs",
                    content: "module.exports = 2;\n",
                  },
                },
              ]
            : [{ type: "text", text: "Fixed value." }],
        inputTokens: 20,
        outputTokens: 10,
      };
    },
  };
  const github = {
    async identity() {
      return { login: "owner", id: 1 };
    },
    async listPullRequests() {
      return [structuredClone(snapshot)];
    },
    async getPullRequest() {
      return structuredClone(snapshot);
    },
  };
  const telegram = {
    async send(_job: Job, _text: string, _buttons?: boolean) {
      return { messageId: 1 };
    },
    async notify() {
      return { messageId: 2 };
    },
    async poll() {
      return { decisions: [], nextOffset: 0 };
    },
  };
  function controller(model = goodModel) {
    const store = new Store(config.runtime.stateDir);
    stores.push(store);
    return new Controller(config, {
      store,
      git: workspace,
      model,
      github,
      telegram,
      allowUnsafeLocal: true,
    });
  }
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    config,
    snapshot,
    workspace,
    goodModel,
    github,
    telegram,
    controller,
  };
}

test("export-ignore does not remove tracked files from work or verification materialization", async (t) => {
  const f = fixture(t),
    c = f.controller();
  const job = c.store.create(f.snapshot);
  const work = await f.workspace.prepare(job);
  assert.equal(
    readFileSync(join(work, "retained.txt"), "utf8"),
    "must survive exact materialization\n",
  );
  const tree = await f.workspace.fingerprint(job);
  const verification = await f.workspace.verificationWorkspace(job, tree);
  assert.equal(
    readFileSync(join(verification, "retained.txt"), "utf8"),
    "must survive exact materialization\n",
  );
});

test("ignored helper cannot make an unpublished dependency pass independent checks", async (t) => {
  const f = fixture(t);
  f.config.runtime.maxRepairAttempts = 1;
  let calls = 0;
  const c = f.controller({
    async complete() {
      return {
        content:
          calls++ === 0
            ? [
                {
                  type: "tool_use",
                  id: "helper",
                  name: "write_file",
                  input: {
                    path: "helper.cjs",
                    content: "module.exports = 2;\n",
                  },
                },
                {
                  type: "tool_use",
                  id: "value",
                  name: "write_file",
                  input: {
                    path: "value.cjs",
                    content: "module.exports = require('./helper.cjs');\n",
                  },
                },
              ]
            : [{ type: "text", text: "Prepared candidate with helper." }],
        inputTokens: 20,
        outputTokens: 10,
      };
    },
  });
  const job = c.store.create(f.snapshot);
  await c.processJob(job.id);
  const result = c.store.get(job.id)!;
  assert.equal(result.status, "blocked");
  assert.notEqual(result.evidence?.[0]?.exitCode, 0);
  assert.ok(existsSync(join(f.workspace.workspace(job.id), "helper.cjs")));
  assert.equal(
    existsSync(
      join(f.workspace.directory(job.id), "verification", "helper.cjs"),
    ),
    false,
  );
  assert.equal(result.candidateSha, undefined);
  assert.equal(result.approvalNonce, undefined);
  assert.equal(await f.workspace.remoteHead(job), f.snapshot.headSha);
});

test("uncertain request reservation survives reopened state and cannot be reset by retry or revision", async (t) => {
  const f = fixture(t);
  f.config.model.inputPricePerMillion = 1;
  f.config.model.outputPricePerMillion = 1;
  let requests = 0;
  const c = f.controller({
    async complete() {
      requests++;
      throw new Error("Response lost after upstream dispatch");
    },
  });
  const job = c.store.create(f.snapshot);
  await c.processJob(job.id);
  const reserved = c.store.get(job.id)!;
  assert.equal(reserved.status, "blocked");
  assert.ok(reserved.costUsd > 0);
  assert.ok(reserved.inputTokens > 0);
  assert.ok(reserved.outputTokens > 0);
  const reopened = f.controller();
  assert.equal(reopened.store.totalCost(), reserved.costUsd);
  f.config.runtime.maxCostUsd = reserved.costUsd + 0.000001;
  c.retry(job.id);
  await c.processJob(job.id);
  assert.equal(requests, 1, "retry must stop before another paid dispatch");
  c.decide({
    action: "revise",
    jobId: job.id,
    text: "Try an alternative",
    updateId: 11,
  });
  const revision = c.store.jobs().at(-1)!;
  assert.equal(c.store.budget(revision).costUsd, reserved.costUsd);
  await c.processJob(revision.id);
  assert.equal(requests, 1);
  assert.equal(c.store.totalCost(), reserved.costUsd);
});

for (const action of ["revise", "pause"] as const)
  test(`${action} during final snapshot cannot resurrect candidate approval`, async (t) => {
    const f = fixture(t);
    const entered = latch(),
      release = latch();
    let snapshots = 0;
    f.github.getPullRequest = async () => {
      if (++snapshots === 2) {
        entered.resolve();
        await release.promise;
      }
      return structuredClone(f.snapshot);
    };
    const c = f.controller(),
      job = c.store.create(f.snapshot);
    const running = c.processJob(job.id);
    await entered.promise;
    c.decide({
      action,
      ...(action === "revise"
        ? { jobId: job.id, text: "Change the explanation" }
        : {}),
      updateId: 20,
    });
    release.resolve();
    await running;
    const result = c.store.get(job.id)!;
    assert.equal(result.status, action === "revise" ? "stale" : "blocked");
    assert.equal(result.approvalNonce, undefined);
    assert.equal(
      c.store.outbox().some((item) => item.buttons && item.jobId === job.id),
      false,
    );
  });

test("late notification receipt preserves concurrent revision and never restores old approval", async (t) => {
  const f = fixture(t),
    entered = latch(),
    release = latch();
  f.telegram.send = async () => {
    entered.resolve();
    await release.promise;
    return { messageId: 88 };
  };
  const c = f.controller(),
    job = c.store.create(f.snapshot, f.snapshot.feedback, policyHash(f.config));
  job.status = "awaiting_approval";
  job.approvalNonce = "1234";
  c.store.save(job);
  c.store.enqueue("candidate", "Ready", job, true);
  const flushing = c.flushNotifications();
  await entered.promise;
  c.decide({
    action: "revise",
    jobId: job.id,
    text: "Revise this",
    updateId: 30,
  });
  release.resolve();
  await flushing;
  assert.equal(c.store.get(job.id)?.status, "stale");
  assert.equal(c.store.get(job.id)?.approvalNonce, undefined);
  assert.equal(c.store.messageJob(88), job.id);
  assert.equal(c.store.jobs().at(-1)?.status, "queued");
});

test("pause while publisher verifies candidate prevents dispatch to remote", async (t) => {
  const f = fixture(t),
    c = f.controller();
  const job = c.store.create(f.snapshot);
  await c.processJob(job.id);
  const ready = c.store.get(job.id)!;
  assert.equal(ready.status, "awaiting_approval", ready.error);
  c.decide({
    action: "approve",
    jobId: job.id,
    nonce: ready.approvalNonce,
    updateId: 40,
  });
  const entered = latch(),
    release = latch();
  const original = f.workspace.verifyCandidate.bind(f.workspace);
  f.workspace.verifyCandidate = async (candidate) => {
    await original(candidate);
    entered.resolve();
    await release.promise;
  };
  const publishing = c.publishApproved();
  await entered.promise;
  c.decide({ action: "pause", updateId: 41 });
  release.resolve();
  await publishing;
  assert.equal(await f.workspace.remoteHead(job), job.snapshot.headSha);
  assert.notEqual(c.store.get(job.id)?.status, "published");
});

test("late model usage stays in revision budget group after owner supersedes active call", async (t) => {
  const f = fixture(t),
    entered = latch(),
    release = latch();
  f.config.model.inputPricePerMillion = 1;
  f.config.model.outputPricePerMillion = 1;
  const c = f.controller({
    async complete() {
      entered.resolve();
      await release.promise;
      return {
        content: [{ type: "text", text: "No change." }],
        inputTokens: 123,
        outputTokens: 45,
      };
    },
  });
  const job = c.store.create(f.snapshot);
  const running = c.processJob(job.id);
  await entered.promise;
  c.decide({
    action: "revise",
    jobId: job.id,
    text: "New owner instruction",
    updateId: 50,
  });
  const revision = c.store.jobs().at(-1)!;
  assert.ok(c.store.budget(revision).costUsd > 0);
  release.resolve();
  await running;
  const group = c.store.budget(revision);
  assert.equal(group.inputTokens, 123);
  assert.equal(group.outputTokens, 45);
  assert.ok(Math.abs(group.costUsd - 0.000168) < 1e-10);
  assert.equal(c.store.get(job.id)?.status, "stale");
  assert.equal(c.store.get(revision.id)?.status, "queued");
});

test("replacing npm test with a no-op is blocked before independent verification or approval", async (t) => {
  const f = fixture(t);
  f.config.github.repositories[0]!.checks = ["npm test"];
  let calls = 0;
  const c = f.controller({
    async complete() {
      return {
        content:
          calls++ === 0
            ? [
                {
                  type: "tool_use",
                  id: "weaken",
                  name: "write_file",
                  input: {
                    path: "package.json",
                    content: JSON.stringify({ scripts: { test: "true" } }),
                  },
                },
              ]
            : [{ type: "text", text: "Tests pass now." }],
        inputTokens: 20,
        outputTokens: 10,
      };
    },
  });
  const job = c.store.create(f.snapshot);
  await c.processJob(job.id);
  const blocked = c.store.get(job.id)!;
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /Verification policy.*package\.json/);
  assert.equal(blocked.evidence, undefined);
  assert.equal(blocked.candidateSha, undefined);
  assert.equal(blocked.approvalNonce, undefined);
  assert.equal(await f.workspace.remoteHead(job), job.snapshot.headSha);
});

test("pilot token totals block a new budget group before any provider dispatch", async (t) => {
  const f = fixture(t);
  let requests = 0;
  const c = f.controller({
    async complete() {
      requests++;
      throw new Error("Must not be called");
    },
  });
  const previous = c.store.create(f.snapshot);
  previous.status = "blocked";
  previous.inputTokens = 1500000;
  previous.outputTokens = 10;
  c.store.save(previous);
  const next = c.store.create(f.snapshot);
  assert.notEqual(previous.id, next.budgetGroup ?? next.id);
  await c.processJob(next.id);
  assert.equal(requests, 0);
  assert.equal(c.store.get(next.id)?.status, "blocked");
  assert.match(c.store.get(next.id)?.error ?? "", /Pilot token budget/);
  assert.equal(c.store.totalTokens().input, 1500000);
});
