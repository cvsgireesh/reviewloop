import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  bedrockClientOptions,
  createBedrockModel,
  createModel,
} from "../src/model.js";
import type { Config, ModelRequest } from "../src/types.js";

const cfg: Config["model"] = {
  provider: "bedrock",
  modelId: "us.anthropic.claude-sonnet-5",
  region: "us-east-2",
  tokenEnv: "FIXTURE_TOKEN",
  maxOutputTokens: 321,
};
const request: ModelRequest = {
  system: "fixture policy",
  messages: [
    { role: "user", content: [{ type: "text", text: "fixture task" }] },
  ],
  tools: [
    {
      name: "read_file",
      description: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  maxOutputTokens: 999,
};

test("official Bedrock SDK transport preserves tool use/error result, bearer auth, limits and usage", async () => {
  const captured: {
    body: Record<string, any>;
    headers: Record<string, string>;
    signal: unknown;
  }[] = [];
  process.env.FIXTURE_TOKEN = "test-only-token";
  const client = new BedrockRuntimeClient({
    ...bedrockClientOptions(cfg),
    requestHandler: {
      async handle(req, options) {
        captured.push({
          body: JSON.parse(
            typeof req.body === "string"
              ? req.body
              : Buffer.from(
                  (req.body as Uint8Array).buffer,
                  (req.body as Uint8Array).byteOffset,
                  (req.body as Uint8Array).byteLength,
                ).toString("utf8"),
          ),
          headers: req.headers,
          signal: options?.abortSignal,
        });
        return {
          response: {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(
              JSON.stringify({
                output: {
                  message: {
                    role: "assistant",
                    content:
                      captured.length === 1
                        ? [
                            {
                              toolUse: {
                                toolUseId: "one",
                                name: "read_file",
                                input: { path: "x" },
                              },
                            },
                          ]
                        : [{ text: "done" }],
                  },
                },
                usage: { inputTokens: 12, outputTokens: 4 },
                stopReason: captured.length === 1 ? "tool_use" : "end_turn",
                metrics: { latencyMs: 1 },
              }),
            ),
          },
        };
      },
    },
  });
  const signal = new AbortController().signal;
  const model = createBedrockModel(cfg, client);
  const first = await model.complete({ ...request, signal });
  assert.equal(first.inputTokens, 12);
  assert.equal(first.outputTokens, 4);
  assert.equal(first.content[0]!.type, "tool_use");
  await model.complete({
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "one",
            content: "file missing",
            isError: true,
          },
        ],
      },
    ],
  });
  assert.equal(
    captured[0]!.headers.authorization ?? captured[0]!.headers.Authorization,
    "Bearer test-only-token",
  );
  assert.equal(captured[0]!.body.inferenceConfig.maxTokens, 321);
  assert.equal(captured[0]!.signal, signal);
  assert.deepEqual(captured[1]!.body.messages[2].content[0], {
    toolResult: {
      toolUseId: "one",
      content: [{ text: "file missing" }],
      status: "error",
    },
  });
  client.destroy();
  delete process.env.FIXTURE_TOKEN;
});

test("OpenAI-compatible adapter uses explicit endpoint, maps tools, and returns refusal usage", async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received = { url: req.url, body: JSON.parse(text) };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: null, refusal: "cannot" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  try {
    const model = createModel({
      ...cfg,
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    const result = await model.complete(request);
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.body.max_tokens, 321);
    assert.equal(received.body.tools[0].function.name, "read_file");
    assert.equal((result as any).stopReason, "refusal");
    assert.equal(result.inputTokens, 8);
  } finally {
    server.close();
    await once(server, "close");
  }
  assert.throws(
    () =>
      createModel({
        ...cfg,
        provider: "openai-compatible",
        baseUrl: "http://example.com/v1",
      }),
    /HTTPS/,
  );
});
