import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./types.js";
import { sha256 } from "./util.js";
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const positive = z.number().positive().finite();
const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const configSchema = z
  .object({
    github: z
      .object({
        apiUrl: z.url().default("https://api.github.com"),
        tokenEnv: envName.default("GITHUB_TOKEN"),
        username: z.string().min(1),
        repositories: z
          .array(
            z
              .object({
                name: repoName,
                checks: z.array(z.string().min(1)).min(1),
                image: z.string().min(1).optional(),
                protectedPaths: z.array(z.string().min(1)).optional(),
                authors: z.array(z.string().trim().min(1)).min(1).optional(),
                pullRequests: z
                  .array(z.number().int().positive())
                  .min(1)
                  .optional(),
              })
              .strict(),
          )
          .min(1),
        pollSeconds: positive.min(10).default(30),
      })
      .strict(),
    model: z
      .object({
        provider: z.enum(["bedrock", "openai-compatible"]).default("bedrock"),
        modelId: z.string().min(1).default("us.anthropic.claude-sonnet-5"),
        region: z
          .string()
          .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
          .default("us-east-2"),
        tokenEnv: envName.default("AWS_BEARER_TOKEN_BEDROCK"),
        baseUrl: z.url().optional(),
        maxOutputTokens: positive.int().max(64000).default(4096),
        inputPricePerMillion: positive.optional(),
        outputPricePerMillion: positive.optional(),
      })
      .strict(),
    telegram: z
      .object({
        tokenEnv: envName.default("TELEGRAM_BOT_TOKEN"),
        chatId: z.string().regex(/^-?\d+$/),
        userId: z.string().regex(/^\d+$/),
      })
      .strict(),
    runtime: z
      .object({
        stateDir: z.string().min(1).default("~/.local/state/reviewloop"),
        sandbox: z.enum(["podman", "docker", "unsafe-local"]).default("podman"),
        image: z.string().min(1).default("localhost/reviewloop-worker:0.2.0"),
        maxJobMinutes: positive.max(180).default(30),
        maxSteps: positive.int().max(200).default(24),
        maxContextBytes: positive.int().min(8000).max(1000000).default(96000),
        maxRepairAttempts: positive.int().max(10).default(3),
        maxToolOutputBytes: positive.int().max(1_000_000).default(24000),
        maxInputTokens: positive.int().default(300000),
        maxOutputTokens: positive.int().default(24000),
        maxTotalInputTokens: positive.int().default(1500000),
        maxTotalOutputTokens: positive.int().default(120000),
        maxCostUsd: positive.optional(),
        maxTotalCostUsd: positive.optional(),
        approvalHours: positive.max(168).default(24),
        maxChangedFiles: positive.int().default(30),
        maxPatchBytes: positive.int().default(500000),
      })
      .strict(),
  })
  .strict();
export function loadConfig(path: string): Config {
  const data = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  data.runtime.stateDir = resolve(
    data.runtime.stateDir.replace(/^~(?=\/|$)/, homedir()),
  );
  for (const url of [data.github.apiUrl, data.model.baseUrl].filter(
    Boolean,
  ) as string[]) {
    const u = new URL(url);
    if (u.username || u.password || u.search || u.hash)
      throw new Error(
        "Endpoint URLs cannot contain credentials, queries or fragments",
      );
    if (
      u.protocol !== "https:" &&
      !(
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
        u.protocol === "http:"
      )
    )
      throw new Error("Remote endpoints require HTTPS");
  }
  if (data.model.provider === "openai-compatible" && !data.model.baseUrl)
    throw new Error("openai-compatible requires model.baseUrl");
  if (
    (data.runtime.maxCostUsd || data.runtime.maxTotalCostUsd) &&
    (!data.model.inputPricePerMillion || !data.model.outputPricePerMillion)
  )
    throw new Error(
      "Dollar caps require owner-supplied current input/output prices. No prices are guessed.",
    );
  const names = data.github.repositories.map((r) => r.name.toLowerCase());
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate repositories");
  if (
    !data.github.repositories.every((r) =>
      r.checks.every((c) => !c.includes("\0")),
    )
  )
    throw new Error("Invalid check command");
  return data;
}
export const policyHash = (config: Config) => sha256(JSON.stringify(config));
export function exampleConfig(): Config {
  return {
    github: {
      apiUrl: "https://api.github.com",
      tokenEnv: "GITHUB_TOKEN",
      username: "YOUR_GITHUB_LOGIN",
      repositories: [{ name: "YOUR_OWNER/YOUR_REPO", checks: ["npm test"] }],
      pollSeconds: 30,
    },
    model: {
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-5",
      region: "us-east-2",
      tokenEnv: "AWS_BEARER_TOKEN_BEDROCK",
      maxOutputTokens: 4096,
    },
    telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", chatId: "0", userId: "0" },
    runtime: {
      stateDir: "~/.local/state/reviewloop",
      sandbox: "podman",
      image: "localhost/reviewloop-worker:0.2.0",
      maxJobMinutes: 30,
      maxSteps: 24,
      maxContextBytes: 96000,
      maxRepairAttempts: 3,
      maxToolOutputBytes: 24000,
      maxInputTokens: 300000,
      maxOutputTokens: 24000,
      maxTotalInputTokens: 1500000,
      maxTotalOutputTokens: 120000,
      approvalHours: 24,
      maxChangedFiles: 30,
      maxPatchBytes: 500000,
    },
  };
}
