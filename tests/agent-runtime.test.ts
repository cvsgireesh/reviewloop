import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  boundedContext,
  fromPi,
  runHarness,
  validateHistory,
} from "../src/harness.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Config,
  HarnessInput,
  Message,
  ModelReply,
  ModelRequest,
  Sandbox,
} from "../src/types.js";
const response = (content: ModelReply["content"]): ModelReply => ({
  content,
  inputTokens: 20,
  outputTokens: 5,
});
const tool = (id: string, name: string, input: Record<string, unknown>) =>
  response([{ type: "tool_use", id, name, input }]);
const done = () =>
  response([
    { type: "text", text: "Candidate prepared; independent checks required." },
  ]);
const sandbox: Sandbox = {
  async run(_workspace, _command, options) {
    return {
      command: "fixture",
      output: String(options?.image),
      exitCode: 0,
      durationMs: 1,
    };
  },
  async doctor() {
    return [];
  },
};
async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), "reviewloop-pi-"));
  const config = {
    model: {
      provider: "bedrock",
      modelId: "fixture",
      region: "us-east-2",
      tokenEnv: "UNUSED",
      maxOutputTokens: 1000,
    },
    runtime: {
      stateDir: "/unused",
      sandbox: "unsafe-local",
      image: "default",
      maxJobMinutes: 1,
      maxSteps: 12,
      maxRepairAttempts: 1,
      maxToolOutputBytes: 8192,
      maxInputTokens: 2000000,
      maxOutputTokens: 8000,
      maxContextBytes: 96000,
      approvalHours: 1,
      maxChangedFiles: 10,
      maxPatchBytes: 65536,
    },
  } as Config;
  const input: HarnessInput = {
    workspace,
    config,
    task: "Fix relevant feedback",
    preferences: ["Preserve current style"],
    priorSummaries: [],
    beforeCall() {},
    onUsage() {},
    onEvent() {},
  };
  return {
    input,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

test("Pi persists complete rounds before next provider call and resumes without replaying tools", async () => {
  const { input, cleanup } = await fixture();
  const saved: Message[][] = [];
  let n = 0;
  input.checkpoint = async (messages) => {
    validateHistory(messages);
    saved.push(structuredClone(messages));
  };
  input.commandImage = "repository-image";
  try {
    await runHarness(
      input,
      {
        async complete(request) {
          if (n++ === 0)
            return tool("write", "write_file", {
              path: "once.txt",
              content: "original",
            });
          assert.ok(
            saved.some((round) =>
              JSON.stringify(round).includes("Workspace file written"),
            ),
          );
          assert.equal(
            request.messages.at(-1)?.content[0]?.type,
            "tool_result",
          );
          return done();
        },
      },
      sandbox,
    );
    const history = saved.at(-1)!;
    assert.equal(history.at(-1)?.role, "assistant");
    await writeFile(path.join(input.workspace, "once.txt"), "do-not-replay");
    input.history = history;
    input.task = "Follow-up review";
    await runHarness(
      input,
      {
        async complete(request) {
          assert.match(JSON.stringify(request.messages), /Follow-up review/);
          assert.match(
            JSON.stringify(request.messages),
            /Preserve current style/,
          );
          return done();
        },
      },
      sandbox,
    );
    assert.equal(
      await readFile(path.join(input.workspace, "once.txt"), "utf8"),
      "do-not-replay",
    );
  } finally {
    await cleanup();
  }
});

test("incomplete checkpoint and checkpoint write failure stop before inference", async () => {
  const { input, cleanup } = await fixture();
  let calls = 0;
  const model = {
    async complete() {
      calls++;
      return done();
    },
  };
  try {
    input.history = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "pending", name: "write_file", input: {} },
        ],
      },
    ];
    await assert.rejects(
      runHarness(input, model, sandbox),
      /unfinished tool calls|Incomplete session tool round/,
    );
    input.history = [];
    input.checkpoint = async () => {
      throw new Error("checkpoint disk full");
    };
    await assert.rejects(
      runHarness(input, model, sandbox),
      /checkpoint disk full/,
    );
    assert.equal(calls, 0);
  } finally {
    await cleanup();
  }
});

test("targeted edit is unique, writes require a current read, search reaches late file contents, and command receives repo image", async () => {
  const { input, cleanup } = await fixture();
  const requests: ModelRequest[] = [];
  let n = 0;
  input.commandImage = "repository-image";
  await writeFile(
    path.join(input.workspace, "code.txt"),
    "old\n" + "x\n".repeat(20000) + "late-needle\n",
  );
  const replies = [
    tool("unread", "write_file", { path: "code.txt", content: "blind" }),
    tool("search", "search", { query: "late-needle" }),
    tool("read", "read_file", {
      path: "code.txt",
      start_line: 20002,
      line_count: 1,
    }),
    tool("edit", "edit_file", {
      path: "code.txt",
      old_text: "old\n",
      new_text: "new\n",
    }),
    tool("ambiguous", "edit_file", {
      path: "code.txt",
      old_text: "x\n",
      new_text: "bad",
    }),
    tool("command", "run_command", { command: "true" }),
    done(),
  ];
  try {
    await runHarness(
      input,
      {
        async complete(request) {
          requests.push(structuredClone({ ...request, signal: undefined }));
          return replies[n++]!;
        },
      },
      sandbox,
    );
    assert.match(
      JSON.stringify(requests[1]!.messages.at(-1)),
      /unread or changed/,
    );
    assert.match(
      JSON.stringify(requests[2]!.messages.at(-1)),
      /code.txt:20002:late-needle/,
    );
    assert.match(
      JSON.stringify(requests[3]!.messages.at(-1)),
      /20002: late-needle/,
    );
    assert.match(
      JSON.stringify(requests[5]!.messages.at(-1)),
      /match exactly once/,
    );
    assert.match(
      JSON.stringify(requests[6]!.messages.at(-1)),
      /repository-image/,
    );
    assert.ok(
      (
        await readFile(path.join(input.workspace, "code.txt"), "utf8")
      ).startsWith("new\n"),
    );
  } finally {
    await cleanup();
  }
});

test("context pruning keeps paired calls/results and full task while leaving checkpoint untouched", () => {
  const history: AgentMessage[] = [
    { role: "system", content: "Immutable system policy", timestamp: 1 },
    { role: "user", content: "Owner task and preferences", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "1",
          name: "read_file",
          arguments: { path: "a" },
        },
      ],
      timestamp: 1,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "1",
      toolName: "read_file",
      content: [{ type: "text", text: "A".repeat(10000) }],
      isError: false,
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "2",
          name: "read_file",
          arguments: { path: "b" },
        },
      ],
      timestamp: 1,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "2",
      toolName: "read_file",
      content: [{ type: "text", text: "Latest evidence" }],
      isError: false,
      timestamp: 1,
    },
  ];
  const compact = boundedContext(history, 2000);
  validateHistory(fromPi(compact));
  assert.match(JSON.stringify(compact), /Owner task and preferences/);
  assert.match(JSON.stringify(compact), /Older tool output omitted/);
  assert.match(JSON.stringify(compact), /Latest evidence/);
  assert.match(JSON.stringify(history), /A{10000}/);
  assert.throws(() => boundedContext(history, 10), /context cannot fit/);
});

test("abort after provider settlement accounts usage but runs no tools or final checkpoint", async () => {
  const { input, cleanup } = await fixture();
  const controller = new AbortController();
  input.signal = controller.signal;
  let usage = 0;
  const saved: Message[][] = [];
  input.onUsage = () => {
    usage++;
  };
  input.checkpoint = async (messages) => {
    saved.push(messages);
  };
  try {
    await assert.rejects(
      runHarness(
        input,
        {
          async complete() {
            controller.abort();
            return tool("edit", "write_file", {
              path: "forbidden.txt",
              content: "bad",
            });
          },
        },
        sandbox,
      ),
      /abort/i,
    );
    assert.equal(usage, 1);
    assert.equal(saved.length, 1);
    await assert.rejects(
      readFile(path.join(input.workspace, "forbidden.txt")),
      /ENOENT/,
    );
  } finally {
    await cleanup();
  }
});

test("malformed duplicate calls fail with usage accounted, and unknown tools return error to model", async () => {
  const { input, cleanup } = await fixture();
  let usage = 0;
  input.onUsage = () => {
    usage++;
  };
  try {
    await assert.rejects(
      runHarness(
        input,
        {
          async complete() {
            return response([
              { type: "tool_use", id: "dup", name: "list_files", input: {} },
              { type: "tool_use", id: "dup", name: "list_files", input: {} },
            ]);
          },
        },
        sandbox,
      ),
      /Invalid or excessive/,
    );
    assert.equal(usage, 1);
    let n = 0;
    await runHarness(
      input,
      {
        async complete(request) {
          if (!n++) return tool("unknown", "host_shell", { command: "bad" });
          assert.match(
            JSON.stringify(request.messages.at(-1)),
            /"isError":true/,
          );
          return done();
        },
      },
      sandbox,
    );
  } finally {
    await cleanup();
  }
});
