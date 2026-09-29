import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ToolUseBlock,
  type ToolInputSchema,
  type BedrockRuntimeClientConfig,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  Config,
  Content,
  Message,
  ModelProvider,
  ModelReply,
  ModelRequest,
} from "./types.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("Model returned missing or invalid token usage");
  return Number(value);
};

/** Injectable SDK client permits transport-level tests without paid inference. */
export function bedrockClientOptions(
  config: Config["model"],
): BedrockRuntimeClientConfig {
  return {
    region: config.region,
    maxAttempts: 1,
    ...(process.env[config.tokenEnv]
      ? {
          authSchemePreference: ["httpBearerAuth"],
          token: async () => {
            const token = process.env[config.tokenEnv];
            if (!token) throw new Error("Configured Bedrock token is missing");
            return { token };
          },
        }
      : { authSchemePreference: ["sigv4"] }),
  };
}

export function createBedrockModel(
  config: Config["model"],
  client = new BedrockRuntimeClient(bedrockClientOptions(config)),
): ModelProvider {
  return {
    async complete(request) {
      const input: ConverseCommandInput = {
        modelId: config.modelId,
        system: [{ text: request.system }],
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content.map((block) => {
            if (block.type === "text") return { text: block.text };
            if (block.type === "tool_use")
              return {
                toolUse: {
                  toolUseId: block.id,
                  name: block.name,
                  input: block.input as ToolUseBlock["input"],
                },
              };
            return {
              toolResult: {
                toolUseId: block.toolUseId,
                content: [{ text: block.content }],
                status: block.isError
                  ? ("error" as const)
                  : ("success" as const),
              },
            };
          }),
        })),
        inferenceConfig: {
          maxTokens: Math.min(request.maxOutputTokens, config.maxOutputTokens),
        },
        ...(request.tools.length
          ? {
              toolConfig: {
                tools: request.tools.map((tool) => ({
                  toolSpec: {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: {
                      json: tool.inputSchema as NonNullable<
                        ToolInputSchema["json"]
                      >,
                    },
                  },
                })),
              },
            }
          : {}),
      };
      const result = await client
        .send(new ConverseCommand(input), { abortSignal: request.signal })
        .catch((error: unknown) => {
          if (request.signal?.aborted)
            throw new Error("Bedrock request aborted");
          const name =
            error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.name)
              ? error.name
              : "ProviderError";
          throw new Error(
            `Bedrock request failed (${name}); provider response body omitted`,
          );
        });
      const usage = {
        inputTokens: count(result.usage?.inputTokens),
        outputTokens: count(result.usage?.outputTokens),
      };
      const content: Content[] = [];
      for (const block of result.output?.message?.content ?? []) {
        if (typeof block.text === "string")
          content.push({ type: "text", text: block.text });
        else if (block.toolUse) {
          if (
            !block.toolUse.toolUseId ||
            !block.toolUse.name ||
            !object(block.toolUse.input)
          )
            return {
              ...usage,
              content: [],
              stopReason: "malformed_model_output",
            };
          content.push({
            type: "tool_use",
            id: block.toolUse.toolUseId,
            name: block.toolUse.name,
            input: block.toolUse.input,
          });
        }
      }
      return { content, ...usage, stopReason: result.stopReason };
    },
  };
}

function openaiMessages(system: string, messages: Message[]): unknown[] {
  const result: unknown[] = [{ role: "system", content: system }];
  for (const message of messages) {
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const calls = message.content.filter((b) => b.type === "tool_use");
    if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((b) => ({
                id: b.id,
                type: "function",
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              })),
            }
          : {}),
      });
    } else {
      for (const block of message.content) {
        if (block.type === "tool_result")
          result.push({
            role: "tool",
            tool_call_id: block.toolUseId,
            content: JSON.stringify({
              result: block.content,
              isError: !!block.isError,
            }),
          });
        else if (block.type === "text")
          result.push({ role: "user", content: block.text });
        else throw new Error("Invalid tool use in user message");
      }
    }
  }
  return result;
}

export function createModel(config: Config["model"]): ModelProvider {
  if (config.provider === "bedrock") return createBedrockModel(config);
  if (config.provider !== "openai-compatible" || !config.baseUrl)
    throw new Error("Explicit model provider/base URL required");
  const base = new URL(config.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" && !(local && base.protocol === "http:"))
  )
    throw new Error(
      "Model base URL must use HTTPS (loopback HTTP is for local tests)",
    );
  const endpoint = new URL(
    base.toString().replace(/\/$/, "") + "/chat/completions",
  );
  return {
    async complete(request): Promise<ModelReply> {
      const token = process.env[config.tokenEnv];
      if (!token && !local)
        throw new Error("Configured model credential is missing");
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelId,
          messages: openaiMessages(request.system, request.messages),
          max_tokens: Math.min(request.maxOutputTokens, config.maxOutputTokens),
          stream: false,
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                  },
                })),
              }
            : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Model request failed with HTTP ${response.status}`);
      }
      // Bound untrusted provider output before JSON parsing; never print response bodies.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty model response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4 * 1024 * 1024)
            throw new Error("Model response exceeded size limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("Malformed model JSON response; response body omitted");
      }
      const usage = {
        inputTokens: count(value.usage?.prompt_tokens),
        outputTokens: count(value.usage?.completion_tokens),
      };
      const choice = value.choices?.[0];
      const message = choice?.message;
      if (!object(message))
        return { ...usage, content: [], stopReason: "malformed_model_output" };
      const content: Content[] = [];
      if (typeof message.content === "string")
        content.push({ type: "text", text: message.content });
      if (Array.isArray(message.tool_calls))
        for (const call of message.tool_calls) {
          if (
            !object(call) ||
            typeof call.id !== "string" ||
            !object(call.function) ||
            typeof call.function.name !== "string" ||
            typeof call.function.arguments !== "string"
          )
            return {
              ...usage,
              content: [],
              stopReason: "malformed_model_output",
            };
          let args;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            return {
              ...usage,
              content: [],
              stopReason: "malformed_model_output",
            };
          }
          if (!object(args))
            return {
              ...usage,
              content: [],
              stopReason: "malformed_model_output",
            };
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: args,
          });
        }
      return {
        content,
        ...usage,
        stopReason: message.refusal ? "refusal" : choice.finish_reason,
      };
    },
  };
}
