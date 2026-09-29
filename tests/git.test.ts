import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleConfig } from "../src/config.js";
import { GitWorkspaces } from "../src/git.js";
import type { Job } from "../src/types.js";
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "reviewloop-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = join(dir, "seed");
  const bare = join(dir, "remote.git");
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
    "const {test} = require('node:test'); const assert = require('node:assert/strict'); test('requested value', () => assert.equal(require('./value.cjs'), 2));\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "Initial fixture");
  git("init", "--quiet", "--bare", bare);
  git("push", bare, "HEAD:refs/heads/feature");
  const headSha = git("rev-parse", "HEAD");
  const config = exampleConfig();
  config.runtime.stateDir = join(dir, "state");
  config.github.repositories = [
    { name: "owner/repo", checks: ["node --test value.test.cjs"] },
  ];
  const job: Job = {
    id: "0123456789abcdef",
    repo: "owner/repo",
    pr: 1,
    snapshot: {
      repo: "owner/repo",
      number: 1,
      title: "Fix value",
      url: "https://example.invalid/pr/1",
      author: "owner",
      authorId: 1,
      headSha,
      baseSha: headSha,
      headRef: "feature",
      headRepo: "owner/repo",
      state: "open",
      feedback: "Return 2 and pass tests",
      fingerprint: "fixture",
    },
    status: "running",
    feedback: "Return 2 and pass tests",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    attempts: 0,
  };
  const workspaces = new GitWorkspaces(config, () => bare);
  return { seed, bare, git, job, workspaces };
}
async function candidate(f: ReturnType<typeof fixture>) {
  const work = await f.workspaces.prepare(f.job);
  writeFileSync(join(work, "value.cjs"), "module.exports = 2;\n");
  const tree = await f.workspaces.fingerprint(f.job);
  const started = performance.now();
  const output = execFileSync(process.execPath, ["--test", "value.test.cjs"], {
    cwd: work,
    encoding: "utf8",
    env: childEnv,
  });
  assert.match(output, /pass 1/);
  assert.equal(
    await f.workspaces.fingerprint(f.job),
    tree,
    "test execution must leave verified tree unchanged",
  );
  f.job.evidence = [
    {
      command: "node --test value.test.cjs",
      exitCode: 0,
      output,
      durationMs: performance.now() - started,
    },
  ];
  const result = await f.workspaces.candidate(f.job, tree);
  f.job.candidateSha = result.sha;
  f.job.patchHash = result.patchHash;
  return { work, tree, result };
}

test("actual tests and exact frozen candidate publish to bare remote with no worker Git metadata", async (t) => {
  const f = fixture(t);
  const { work, result } = await candidate(f);
  assert.equal(existsSync(join(work, ".git")), false);
  assert.deepEqual(result.files, ["value.cjs"]);
  assert.notEqual(result.sha, f.job.snapshot.headSha);
  await f.workspaces.verifyCandidate(f.job);
  // Worktree edits after freezing must never alter the approved commit sent to the remote.
  writeFileSync(join(work, "value.cjs"), "module.exports = 999;\n");
  f.job.status = "approved";
  await f.workspaces.publish(f.job);
  assert.equal(await f.workspaces.remoteHead(f.job), result.sha);
  assert.equal(
    f.git("--git-dir", f.bare, "show", "refs/heads/feature:value.cjs"),
    "module.exports = 2;",
  );
  assert.equal(
    readFileSync(join(work, "value.cjs"), "utf8"),
    "module.exports = 999;\n",
  );
});
test("remote head advancement rejects stale candidate without overwriting new remote work", async (t) => {
  const f = fixture(t);
  await candidate(f);
  writeFileSync(join(f.seed, "new.txt"), "Another commit\n");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "Remote advance");
  f.git("push", f.bare, "HEAD:refs/heads/feature");
  const advanced = f.git("rev-parse", "HEAD");
  await assert.rejects(f.workspaces.publish(f.job), /Remote head moved/);
  assert.equal(await f.workspaces.remoteHead(f.job), advanced);
});
test("modified patch evidence rejects publication", async (t) => {
  const f = fixture(t);
  await candidate(f);
  writeFileSync(
    join(f.workspaces.directory(f.job.id), "candidate.patch"),
    "tampered evidence",
  );
  await assert.rejects(f.workspaces.publish(f.job), /evidence hash changed/);
  assert.equal(await f.workspaces.remoteHead(f.job), f.job.snapshot.headSha);
});
test("workspace mutation after successful test tree cannot become candidate", async (t) => {
  const f = fixture(t);
  const work = await f.workspaces.prepare(f.job);
  writeFileSync(join(work, "value.cjs"), "module.exports = 2;\n");
  const tree = await f.workspaces.fingerprint(f.job);
  execFileSync(process.execPath, ["--test", "value.test.cjs"], {
    cwd: work,
    env: childEnv,
  });
  writeFileSync(join(work, "value.cjs"), "module.exports = 3;\n");
  await assert.rejects(
    f.workspaces.candidate(f.job, tree),
    /changed after verification/,
  );
});
test("symlink and protected credential filename candidates are rejected", async (t) => {
  const f = fixture(t);
  const work = await f.workspaces.prepare(f.job);
  symlinkSync("/etc/passwd", join(work, "outside"));
  await assert.rejects(f.workspaces.fingerprint(f.job), /Symlink candidates/);
  rmSync(join(work, "outside"));
  writeFileSync(join(work, ".env"), "SECRET=fixture\n");
  const tree = await f.workspaces.fingerprint(f.job);
  await assert.rejects(
    f.workspaces.candidate(f.job, tree),
    /protected configuration/,
  );
});
