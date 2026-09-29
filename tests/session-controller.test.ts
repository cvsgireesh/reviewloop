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
                  name: "run_command",
                  input: {
                    command: "printf 'module.exports = 2;\\n' > value.cjs",
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

test("explicit retry resumes complete tool history without replay and retains uncertain usage", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const c = f.controller({
    async complete(request) {
      calls++;
      if (calls === 1)
        return {
          content: [
            {
              type: "tool_use",
              id: "saved-write",
              name: "run_command",
              input: { command: "printf 'module.exports = 2;\\n' > value.cjs" },
            },
          ],
          inputTokens: 20,
          outputTokens: 10,
        };
      if (calls === 2) throw new Error("Lost model response");
      assert.ok(
        request.messages.some((m) =>
          m.content.some(
            (b) => b.type === "tool_result" && b.toolUseId === "saved-write",
          ),
        ),
        "complete prior round must reach model",
      );
      assert.equal(
        readFileSync(join(f.workspace.workspace(job.id), "value.cjs"), "utf8"),
        "module.exports = 2;\n",
      );
      return {
        content: [{ type: "text", text: "Completed from checkpoint" }],
        inputTokens: 30,
        outputTokens: 10,
      };
    },
  });
  const job = c.store.create(f.snapshot);
  await c.processJob(job.id);
  assert.equal(c.store.get(job.id)?.status, "blocked");
  const reserved = c.store.budget(c.store.get(job.id)!);
  c.retry(job.id);
  await c.processJob(job.id);
  const ready = c.store.get(job.id)!;
  assert.equal(ready.status, "awaiting_approval", ready.error);
  assert.equal(calls, 3);
  assert.ok(ready.inputTokens > reserved.inputTokens);
  assert.equal(await f.workspace.remoteHead(job), f.snapshot.headSha);
});

test("typed revision inherits frozen candidate rather than dirty old workspace", async (t) => {
  const f = fixture(t),
    c = f.controller();
  const job = c.store.create(f.snapshot);
  await c.processJob(job.id);
  assert.equal(c.store.get(job.id)?.status, "awaiting_approval");
  writeFileSync(
    join(f.workspace.workspace(job.id), "value.cjs"),
    "module.exports = 999;\n",
  );
  c.decide({
    action: "revise",
    jobId: job.id,
    text: "Preserve change and clarify",
    updateId: 901,
  });
  const revision = c.store.jobs().at(-1)!;
  const next = f.controller({
    async complete() {
      assert.equal(
        readFileSync(
          join(f.workspace.workspace(revision.id), "value.cjs"),
          "utf8",
        ),
        "module.exports = 2;\n",
      );
      return {
        content: [{ type: "text", text: "Preserved original fix" }],
        inputTokens: 20,
        outputTokens: 10,
      };
    },
  });
  await next.processJob(revision.id);
  assert.equal(
    next.store.get(revision.id)?.status,
    "awaiting_approval",
    next.store.get(revision.id)?.error,
  );
  assert.equal(next.store.get(job.id)?.status, "stale");
  assert.equal(next.store.get(job.id)?.approvalNonce, undefined);
  await next.recover();
  assert.equal(
    next.store.get(job.id)?.status,
    "stale",
    "old checkpoint cannot restore approval",
  );
});

for (const changed of [false, true])
  test(`restart ${changed ? "rejects changed workspace" : "queues complete checkpoint"} without restoring approval`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    const c = f.controller({
      async complete() {
        if (calls++ === 0)
          return {
            content: [
              {
                type: "tool_use",
                id: "once",
                name: "run_command",
                input: {
                  command: "printf 'module.exports = 2;\\n' > value.cjs",
                },
              },
            ],
            inputTokens: 10,
            outputTokens: 10,
          };
        throw new Error("response lost");
      },
    });
    const job = c.store.create(f.snapshot);
    await c.processJob(job.id);
    const interrupted = c.store.get(job.id)!;
    interrupted.status = "running";
    c.store.save(interrupted);
    if (changed)
      writeFileSync(
        join(f.workspace.workspace(job.id), "helper.cjs"),
        "ignored change",
      );
    await c.recover();
    const recovered = c.store.get(job.id)!;
    assert.equal(recovered.status, changed ? "blocked" : "queued");
    assert.equal(recovered.approvalNonce, undefined);
    assert.equal(recovered.candidateSha, undefined);
    if (changed) {
      c.retry(job.id);
      const next = f.controller({
        async complete() {
          assert.equal(
            existsSync(join(f.workspace.workspace(job.id), "helper.cjs")),
            false,
          );
          assert.equal(
            readFileSync(
              join(f.workspace.workspace(job.id), "value.cjs"),
              "utf8",
            ),
            "module.exports = 1;\n",
          );
          return {
            content: [{ type: "text", text: "No new change" }],
            inputTokens: 10,
            outputTokens: 10,
          };
        },
      });
      await next.processJob(job.id);
      assert.equal(next.store.get(job.id)?.status, "no_change");
    }
  });

test("crash after candidate commit resumes against frozen PR head and preserves full patch", async (t) => {
  const f = fixture(t),
    c = f.controller();
  const job = c.store.create(f.snapshot);
  const original = f.workspace.candidate.bind(f.workspace);
  let crashed = false;
  f.workspace.candidate = async (j, tree) => {
    const result = await original(j, tree);
    if (!crashed) {
      crashed = true;
      throw new Error("Simulated crash after commit before job save");
    }
    return result;
  };
  await c.processJob(job.id);
  const stopped = c.store.get(job.id)!;
  assert.equal(stopped.status, "blocked");
  assert.equal(stopped.candidateSha, undefined);
  // Reproduce on-disk running state left by an actual process death.
  stopped.status = "running";
  c.store.save(stopped);
  await c.recover();
  assert.equal(c.store.get(job.id)?.status, "queued");
  const next = f.controller({
    async complete() {
      return {
        content: [{ type: "text", text: "Existing completed change is ready" }],
        inputTokens: 10,
        outputTokens: 10,
      };
    },
  });
  await next.processJob(job.id);
  const ready = next.store.get(job.id)!;
  assert.equal(ready.status, "awaiting_approval", ready.error);
  await f.workspace.verifyCandidate(ready);
  const parent = execFileSync(
    "git",
    [
      "--git-dir",
      join(f.workspace.directory(job.id), "source/.git"),
      "show",
      "-s",
      "--format=%P",
      ready.candidateSha!,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(parent, f.snapshot.headSha);
  assert.match(
    readFileSync(
      join(f.workspace.directory(job.id), "candidate.patch"),
      "utf8",
    ),
    /module.exports = 2/,
  );
  assert.equal(await f.workspace.remoteHead(job), f.snapshot.headSha);
});

for (const mode of ["retry", "restart"] as const)
  test(`${mode} reconstructs persisted failed verification absent from the session journal`, async (t) => {
    const f = fixture(t);
    const c = f.controller({
      async complete() {
        throw new Error("Simulated interruption after checkpoint");
      },
    });
    const job = c.store.create(f.snapshot);
    await c.processJob(job.id);
    const interrupted = c.store.get(job.id)!;
    assert.equal(interrupted.status, "blocked");
    const diagnostic =
      "fixture-verification-unique: expected exported value 2, received 1";
    const sessionBeforeVerification = readFileSync(
      join(f.workspace.directory(job.id), "agent-session.json"),
      "utf8",
    );
    assert.equal(sessionBeforeVerification.includes(diagnostic), false);
    interrupted.evidence = [
      {
        command: "node check.cjs",
        exitCode: 1,
        output: diagnostic,
        durationMs: 1,
      },
    ];
    interrupted.status = mode === "restart" ? "verifying" : "blocked";
    c.store.save(interrupted);
    const captured: string[] = [];
    const next = f.controller({
      async complete(request) {
        const latestTask = request.messages
          .filter(
            (message) =>
              message.role === "user" &&
              message.content.some((block) => block.type === "text"),
          )
          .at(-1)!;
        captured.push(JSON.stringify(latestTask));
        assert.match(captured.at(-1)!, /fixture-verification-unique/);
        assert.match(captured.at(-1)!, /node check.cjs/);
        return f.goodModel.complete(request);
      },
    });
    if (mode === "restart") await next.recover();
    else next.retry(job.id);
    assert.equal(next.store.get(job.id)?.status, "queued");
    await next.processJob(job.id);
    const ready = next.store.get(job.id)!;
    assert.equal(ready.status, "awaiting_approval", ready.error);
    assert.equal(captured.length, 2);
    assert.equal(ready.evidence?.[0]?.exitCode, 0);
    assert.equal(await f.workspace.remoteHead(job), f.snapshot.headSha);
  });
