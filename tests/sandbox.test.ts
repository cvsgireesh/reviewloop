import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  cleanEnvironment,
  containerArgs,
  createSandbox,
  runProcess,
} from "../src/sandbox.js";
import type { Config } from "../src/types.js";

test("runtime arguments isolate network/privileges and keep shell syntax a single container argument", () => {
  const command = "echo x; cat /etc/passwd";
  const args = containerArgs(
    "podman",
    "/fixture/work",
    "local/image@sha256:abc",
    command,
    "/tmp/cid",
    "/tmp/mask",
  );
  for (const required of [
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pull=never",
    "--userns=keep-id",
  ])
    assert.ok(args.includes(required));
  assert.equal(args.at(-1), command);
  assert.ok(
    args.includes("type=bind,src=/tmp/mask,dst=/workspace/.git,readonly"),
  );
  assert.equal(
    args.some((s) => s.includes("docker.sock") || s.includes("podman.sock")),
    false,
  );
  process.env.REVIEWLOOP_FIXTURE_SECRET = "never-pass";
  assert.equal(cleanEnvironment().REVIEWLOOP_FIXTURE_SECRET, undefined);
  delete process.env.REVIEWLOOP_FIXTURE_SECRET;
});

test("unsafe-local requires explicit opt-in; real fixture process has no inherited secret", async () => {
  const cfg = {
    sandbox: "unsafe-local",
    maxJobMinutes: 1,
    maxToolOutputBytes: 4096,
  } as Config["runtime"];
  assert.throws(() => createSandbox(cfg), /fixture-test authorization/);
  const workspace = await mkdtemp(path.join(tmpdir(), "reviewloop-sandbox-"));
  process.env.REVIEWLOOP_FIXTURE_SECRET = "hidden";
  try {
    const result = await createSandbox(cfg, true).run(
      workspace,
      'test -z "$REVIEWLOOP_FIXTURE_SECRET" && printf isolated-env',
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /UNISOLATED fixture mode/);
    assert.match(result.output, /isolated-env/);
  } finally {
    delete process.env.REVIEWLOOP_FIXTURE_SECRET;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("timeout, abort and output ceilings terminate processes promptly", async () => {
  const timed = await runProcess("/bin/sh", ["-c", "sleep 30"], {
    timeoutMs: 50,
    limit: 1024,
  });
  assert.equal(timed.exitCode, 124);
  assert.ok(timed.durationMs < 2000);
  const big = await runProcess(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'],
    { timeoutMs: 2000, limit: 256 },
  );
  assert.equal(big.exitCode, 125);
  assert.ok(Buffer.byteLength(big.output) <= 256);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const aborted = await runProcess("/bin/sh", ["-c", "sleep 30"], {
    timeoutMs: 10000,
    limit: 256,
    signal: controller.signal,
  });
  assert.equal(aborted.exitCode, 130);
});

test("container timeout removes the cidfile-recorded container with no inherited credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewloop-runtime-"));
  const oldPath = process.env.PATH;
  const log = path.join(dir, "calls.jsonl");
  const executable = path.join(dir, "podman");
  const workspace = path.join(dir, "work");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const source = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,secret:process.env.REVIEWLOOP_FIXTURE_SECRET})+'\\n');if(a.includes('info'))process.stdout.write(JSON.stringify({host:{security:{rootless:true}}}));if(a.includes('run')){fs.writeFileSync(a[a.indexOf('--cidfile')+1],'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');setInterval(()=>{},1000);}`;
  await writeFile(executable, source);
  await chmod(executable, 0o700);
  process.env.PATH = dir + ":" + oldPath;
  process.env.REVIEWLOOP_FIXTURE_SECRET = "must-not-cross";
  try {
    const cfg = {
      stateDir: dir,
      sandbox: "podman",
      image: "fixture-image",
      maxJobMinutes: 1,
      maxToolOutputBytes: 4096,
    } as Config["runtime"];
    const result = await createSandbox(cfg).run(workspace, "sleep 30", {
      timeoutMs: 750,
    });
    assert.equal(result.exitCode, 124, result.output);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.ok(
      calls.some(
        (c) =>
          c.args.includes("rm") &&
          c.args.includes("--force") &&
          c.args.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      ),
    );
    assert.ok(calls.every((c) => c.secret === undefined));
  } finally {
    process.env.PATH = oldPath;
    delete process.env.REVIEWLOOP_FIXTURE_SECRET;
    await rm(dir, { recursive: true, force: true });
  }
});
