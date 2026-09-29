import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { exampleConfig } from "../src/config.js";
import { acquireDaemonLock, daemonState } from "../src/lock.js";
import { runProcess } from "../src/sandbox.js";
import { Store } from "../src/store.js";
import type { PullRequest } from "../src/types.js";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewloop-cli-"));
  const config = exampleConfig();
  config.runtime.stateDir = path.join(dir, "state");
  config.runtime.sandbox = "unsafe-local";
  const filename = path.join(dir, "reviewloop.json");
  await writeFile(filename, JSON.stringify(config));
  const output: string[] = [];
  const errors: string[] = [];
  const run = (...args: string[]) =>
    runCli([...args, "--config", filename], {
      out: (s) => output.push(s),
      err: (s) => errors.push(s),
    });
  return {
    dir,
    config,
    filename,
    output,
    errors,
    run,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("help requires no config and init never overwrites an existing file", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await runCli(["--help"], {
        out: (s) => f.output.push(s),
        err: (s) => f.errors.push(s),
      }),
      0,
    );
    assert.match(f.output.join(""), /doctor \[--live\]/);
    const target = path.join(f.dir, "new.json");
    assert.equal(
      await runCli(["init", "--config", target], { out() {}, err() {} }),
      0,
    );
    const before = await readFile(target, "utf8");
    assert.equal(
      await runCli(["init", "--config", target], { out() {}, err() {} }),
      1,
    );
    assert.equal(await readFile(target, "utf8"), before);
    assert.match(before, /AWS_BEARER_TOKEN_BEDROCK/);
  } finally {
    await f.cleanup();
  }
});

test("local preferences, pause/resume and status need no credentials and coexist with active daemon lock", async () => {
  const f = await fixture();
  const release = acquireDaemonLock(f.config.runtime.stateDir);
  const fetcher = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    throw new Error("Unexpected network");
  };
  try {
    assert.equal(
      await f.run(
        "preferences",
        "add",
        "Prefer regression tests",
        "--repo",
        "YOUR_OWNER/YOUR_REPO",
      ),
      0,
    );
    assert.equal(await f.run("preferences", "list"), 0);
    assert.match(f.output.join(""), /Prefer regression tests/);
    assert.equal(await f.run("pause"), 0);
    assert.equal(await f.run("status"), 0);
    assert.match(f.output.at(-1)!, /"paused": true/);
    assert.match(f.output.at(-1)!, /"daemon": "active"/);
    assert.equal(await f.run("resume"), 0);
    assert.equal(await f.run("forget", "1"), 0);
    assert.equal(await f.run("jobs"), 0);
    assert.equal(network, 0);
  } finally {
    globalThis.fetch = fetcher;
    release();
    await f.cleanup();
  }
});

test("offline doctor neither resolves credentials nor calls APIs, and never prints token values", async () => {
  const f = await fixture();
  const fetcher = globalThis.fetch;
  let network = 0;
  const old = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "secret-fixture-value";
  globalThis.fetch = async () => {
    network++;
    throw new Error("Unexpected network");
  };
  try {
    assert.equal(await f.run("doctor", "--allow-unsafe-local"), 1);
    assert.equal(network, 0);
    assert.match(f.output.join(""), /OFFLINE/);
    assert.match(f.output.join(""), /set \(value hidden\)/);
    assert.equal(f.output.join("").includes("secret-fixture-value"), false);
    assert.equal(f.output.join("").includes("inference performed"), true);
  } finally {
    globalThis.fetch = fetcher;
    if (old === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = old;
    await f.cleanup();
  }
});

test("retry is local, preserves group budgets, and cannot race an active daemon", async () => {
  const f = await fixture();
  let store = new Store(f.config.runtime.stateDir);
  const snapshot = {
    repo: "YOUR_OWNER/YOUR_REPO",
    number: 1,
    title: "fixture",
    url: "https://example.test",
    author: "owner",
    authorId: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    headRef: "fixture",
    headRepo: "YOUR_OWNER/YOUR_REPO",
    state: "open",
    feedback: "fix",
    fingerprint: "f",
  } satisfies PullRequest;
  const job = store.create(snapshot);
  job.status = "blocked";
  job.attempts = 1;
  job.inputTokens = 123;
  job.costUsd = 0.1;
  store.save(job);
  store.close();
  try {
    const release = acquireDaemonLock(f.config.runtime.stateDir);
    assert.equal(await f.run("retry", job.id), 1);
    release();
    assert.equal(await f.run("retry", job.id), 0);
    store = new Store(f.config.runtime.stateDir);
    const saved = store.get(job.id)!;
    assert.equal(saved.status, "queued");
    assert.equal(saved.inputTokens, 123);
    assert.equal(saved.attempts, 1);
    assert.equal(saved.costUsd, 0.1);
    store.close();
  } finally {
    await f.cleanup();
  }
});

test("exclusive lock blocks a second process, recovers proven-dead PID and refuses PID identity mismatch", async () => {
  const f = await fixture();
  let release = acquireDaemonLock(f.config.runtime.stateDir);
  try {
    const module = fileURLToPath(new URL("../src/lock.ts", import.meta.url));
    const script = `import {acquireDaemonLock} from ${JSON.stringify(module)};try{const release=acquireDaemonLock(${JSON.stringify(f.config.runtime.stateDir)});release();console.log('incorrectly acquired');process.exitCode=1;}catch{console.log('blocked');}`;
    const result = await runProcess(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeoutMs: 5000, limit: 4096 },
    );
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /blocked/);
    release();
    const lock = path.join(f.config.runtime.stateDir, "daemon.lock");
    await mkdir(lock);
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: hostname(),
        identity: "dead",
        nonce: "dead",
        createdAt: "fixture",
      }),
    );
    assert.equal(daemonState(f.config.runtime.stateDir), "stale");
    release = acquireDaemonLock(f.config.runtime.stateDir);
    release();
    await mkdir(lock);
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        identity: "not-this-process",
        nonce: "reused",
        createdAt: "fixture",
      }),
    );
    assert.throws(
      () => acquireDaemonLock(f.config.runtime.stateDir),
      /may be active/,
    );
  } finally {
    await f.cleanup();
  }
});

test("npm-style symlink entry executes the CLI main rather than silently skipping it", async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.dir, "reviewloop");
    await symlink(
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      bin,
    );
    const result = await runProcess(
      process.execPath,
      ["--import", "tsx", bin, "--help"],
      { timeoutMs: 5000, limit: 10000 },
    );
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /Usage: reviewloop COMMAND/);
  } finally {
    await f.cleanup();
  }
});

test("evaluation CLI requires an explicit mode and refuses unsafe model execution before dispatch", async () => {
  const f = await fixture();
  const fetcher = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    throw new Error("Unexpected network");
  };
  try {
    const output = path.join(f.dir, "evaluation");
    assert.equal(await f.run("evaluate", "--output", output), 1);
    assert.match(f.errors.at(-1)!, /Choose exactly one/);
    assert.equal(
      await f.run(
        "evaluate",
        "--output",
        output,
        "--reference",
        "--allow-model-calls",
      ),
      1,
    );
    assert.equal(
      await f.run("evaluate", "--output", output, "--allow-model-calls"),
      1,
    );
    assert.match(f.errors.at(-1)!, /requires a rootless/);
    assert.equal(await f.run("status", "--allow-model-calls"), 1);
    assert.equal(network, 0);
  } finally {
    globalThis.fetch = fetcher;
    await f.cleanup();
  }
});

test("evaluation CLI runs one reference fixture without credentials and labels it as non-model evidence", async () => {
  const f = await fixture();
  const fetcher = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => {
    network++;
    throw new Error("Unexpected network");
  };
  try {
    const output = path.join(f.dir, "evaluation");
    assert.equal(
      await f.run(
        "evaluate",
        "--reference",
        "--task",
        "retry-after",
        "--output",
        output,
      ),
      0,
      f.errors.join("\n"),
    );
    const report = JSON.parse(
      await readFile(path.join(output, "report.json"), "utf8"),
    );
    assert.equal(report.actualMode, "reference");
    assert.equal(report.providerKind, "none");
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].passed, true);
    assert.match(f.output.at(-1)!, /not model evaluation/);
    assert.equal(network, 0);
    assert.equal(
      await f.run(
        "evaluate",
        "--reference",
        "--task",
        "retry-after",
        "--output",
        output,
      ),
      1,
    );
  } finally {
    globalThis.fetch = fetcher;
    await f.cleanup();
  }
});
