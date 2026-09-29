import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHarness } from "../src/harness.js";
import { createSandbox } from "../src/sandbox.js";
import type {
  Config,
  HarnessInput,
  ModelProvider,
  ModelRequest,
  ModelReply,
} from "../src/types.js";

const configuration = (): Config =>
  ({
    model: {
      provider: "bedrock",
      modelId: "fixture",
      region: "us-east-2",
      tokenEnv: "FIXTURE_UNUSED",
      maxOutputTokens: 1000,
    },
    runtime: {
      stateDir: "/unused",
      sandbox: "unsafe-local",
      image: "fixture",
      maxJobMinutes: 1,
      maxSteps: 8,
      maxRepairAttempts: 1,
      maxToolOutputBytes: 8192,
      maxInputTokens: 100000,
      maxOutputTokens: 8000,
      approvalHours: 1,
      maxChangedFiles: 10,
      maxPatchBytes: 65536,
    },
  }) as Config;
const reply = (content: ModelReply["content"]): ModelReply => ({
  content,
  inputTokens: 30,
  outputTokens: 10,
});

test("real bounded loop loads skill, edits a fixture, executes a check, and reports usage before final summary", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reviewloop-harness-"));
  const requests: ModelRequest[] = [];
  const events: string[] = [];
  const cfg = configuration();
  let n = 0;
  const model: ModelProvider = {
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      events.push("model");
      return [
        reply([
          {
            type: "tool_use",
            id: "skill",
            name: "read_skill",
            input: { name: "review-feedback" },
          },
        ]),
        reply([
          {
            type: "tool_use",
            id: "edit",
            name: "write_file",
            input: { path: "answer.txt", content: "verified fixture" },
          },
        ]),
        reply([
          {
            type: "tool_use",
            id: "cmd",
            name: "run_command",
            input: {
              command:
                'test "$(cat answer.txt)" = "verified fixture" && printf check-passed',
            },
          },
        ]),
        reply([
          {
            type: "text",
            text: "Changed answer.txt. Fixture command passed; independent checks still required.",
          },
        ]),
      ][n++]!;
    },
  };
  try {
    const input: HarnessInput = {
      workspace,
      config: cfg,
      task: "Fix fixture",
      preferences: ["Be concise"],
      priorSummaries: [],
      beforeCall() {
        events.push("reserve");
      },
      onUsage() {
        events.push("usage");
      },
      onEvent(event) {
        events.push(event);
      },
    };
    const result = await runHarness(
      input,
      model,
      createSandbox(cfg.runtime, true),
    );
    assert.equal(
      await readFile(path.join(workspace, "answer.txt"), "utf8"),
      "verified fixture",
    );
    assert.equal(result.steps, 4);
    assert.match(result.summary, /independent checks/);
    assert.match(JSON.stringify(requests[3]!.messages), /check-passed/);
    assert.equal(events.filter((e) => e === "usage").length, 4);
    for (let i = 0; i < events.length; i++)
      if (events[i] === "model") assert.equal(events[i - 1], "model_call");
    assert.equal(events.indexOf("reserve") < events.indexOf("model"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("traversal, .git, symlink files and symlink ancestors are rejected as tool errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reviewloop-paths-"));
  const workspace = path.join(dir, "work");
  await mkdir(workspace);
  await writeFile(path.join(dir, "secret"), "outside");
  await symlink(path.join(dir, "secret"), path.join(workspace, "link"));
  await symlink(dir, path.join(workspace, "parent"));
  const cfg = configuration();
  let n = 0;
  let results = "";
  const calls = [
    ["read_file", { path: "../secret" }],
    ["read_file", { path: "link" }],
    ["write_file", { path: "parent/secret", content: "bad" }],
    ["write_file", { path: ".git/config", content: "bad" }],
    ["read_file", { path: "/etc/passwd" }],
    ["read_file", { path: "x", unexpected: "bad" }],
  ] as const;
  const model: ModelProvider = {
    async complete(request) {
      if (n++ === 0)
        return reply(
          calls.map(([name, input], i) => ({
            type: "tool_use",
            id: `t${i}`,
            name,
            input,
          })),
        );
      results = JSON.stringify(request.messages.at(-1));
      return reply([{ type: "text", text: "Blocked unsafe paths." }]);
    },
  };
  try {
    await runHarness(
      {
        workspace,
        task: "fixture",
        preferences: [],
        priorSummaries: [],
        config: cfg,
        beforeCall() {},
        onUsage() {},
        onEvent() {},
      },
      model,
      createSandbox(cfg.runtime, true),
    );
    assert.equal((results.match(/"isError":true/g) || []).length, 6);
    assert.equal(await readFile(path.join(dir, "secret"), "utf8"), "outside");
    assert.equal(results.includes("outside"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("step budget stops repeated tool work and reservation failure prevents a model call", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reviewloop-budget-"));
  const cfg = configuration();
  cfg.runtime.maxSteps = 1;
  let count = 0;
  const model: ModelProvider = {
    async complete() {
      count++;
      return reply([
        { type: "tool_use", id: "list", name: "list_files", input: {} },
      ]);
    },
  };
  const input: HarnessInput = {
    workspace,
    task: "fixture",
    preferences: [],
    priorSummaries: [],
    config: cfg,
    beforeCall() {},
    onUsage() {},
    onEvent() {},
  };
  try {
    await assert.rejects(
      runHarness(input, model, createSandbox(cfg.runtime, true)),
      /step budget/,
    );
    assert.equal(count, 1);
    input.beforeCall = () => {
      throw new Error("cost bound");
    };
    await assert.rejects(
      runHarness(input, model, createSandbox(cfg.runtime, true)),
      /cost bound/,
    );
    assert.equal(count, 1);
    cfg.runtime.maxInputTokens = 1;
    await assert.rejects(
      runHarness(input, model, createSandbox(cfg.runtime, true)),
      /token\/context budget/,
    );
    assert.equal(count, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("refusal and empty final output are not accepted, but refusal usage is recorded", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reviewloop-refusal-"));
  const cfg = configuration();
  let usage = 0;
  const input: HarnessInput = {
    workspace,
    task: "fixture",
    preferences: [],
    priorSummaries: [],
    config: cfg,
    beforeCall() {},
    onUsage() {
      usage++;
    },
    onEvent() {},
  };
  try {
    await assert.rejects(
      runHarness(
        input,
        {
          async complete() {
            return { ...reply([]), stopReason: "refusal" };
          },
        },
        createSandbox(cfg.runtime, true),
      ),
      /complete candidate/,
    );
    assert.equal(usage, 1);
    await assert.rejects(
      runHarness(
        input,
        {
          async complete() {
            return reply([]);
          },
        },
        createSandbox(cfg.runtime, true),
      ),
      /without a candidate summary/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
