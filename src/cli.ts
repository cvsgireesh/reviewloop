#!/usr/bin/env node
import { writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exampleConfig, loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Controller } from "./controller.js";
import { Github } from "./github.js";
import {
  createSandbox,
  cleanupManagedContainers,
  runProcess,
} from "./sandbox.js";
import { acquireDaemonLock, daemonState } from "./lock.js";
import { errorText, redact } from "./util.js";
import type { Config } from "./types.js";

const HELP = `ReviewLoop — Agents handle your PR feedback. You approve every push.

Usage: reviewloop COMMAND [arguments] [--config ./reviewloop.json]

  init                         Write a secret-free example config; never overwrite
  doctor [--live]              Offline checks; --live checks identity/getMe only
  run [--once]                Run supervisor; --once performs one bounded cycle
  status | jobs               Inspect local state without API credentials
  show JOB_ID                 Show stored candidate/evidence/error
  events [JOB_ID]             Show recent local audit records
  preferences list            List durable owner preferences
  preferences add TEXT [--repo OWNER/REPO]
  forget MEMORY_ID            Delete a durable preference
  pause | resume              Persist the local service pause setting
  retry JOB_ID                Retry a blocked job with remaining budgets, offline only

Options:
  --config PATH               Config location (default ./reviewloop.json)
  --allow-unsafe-local        Explicit UNISOLATED trusted-fixture mode only
  --help                      Show this help

doctor never calls the model, sends Telegram messages or pulls images.
run requires configured credentials; no automatic merge or approval bypass.
`;

interface IO {
  out(text: string): void;
  err(text: string): void;
}
function argumentsFor(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (["--config", "--repo"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (flags.has(arg)) throw new Error(`Duplicate ${arg}`);
      flags.set(arg, value);
    } else if (
      ["--help", "--live", "--once", "--allow-unsafe-local"].includes(arg)
    ) {
      if (flags.has(arg)) throw new Error(`Duplicate ${arg}`);
      flags.set(arg, true);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  return {
    positional,
    flags,
    configPath: resolve(String(flags.get("--config") ?? "./reviewloop.json")),
  };
}

function placeholders(config: Config): string[] {
  const issues: string[] = [];
  if (
    config.github.username === "YOUR_GITHUB_LOGIN" ||
    config.github.repositories.some((r) => /YOUR_OWNER|YOUR_REPO/.test(r.name))
  )
    issues.push("Replace GitHub identity/repository placeholders");
  if (config.telegram.chatId === "0" || config.telegram.userId === "0")
    issues.push("Configure the authorized Telegram chat and user IDs");
  return issues;
}

async function doctor(
  config: Config,
  live: boolean,
  unsafe: boolean,
  io: IO,
): Promise<number> {
  const issues = placeholders(config);
  io.out(
    `Node ${process.version}; platform ${process.platform}; diagnostics ${live ? "explicit read-only live identity checks" : "OFFLINE"}`,
  );
  if (Number(process.versions.node.split(".")[0]) < 24)
    issues.push("Node.js 24 or newer is required");
  for (const name of [config.github.tokenEnv, config.telegram.tokenEnv]) {
    const present = !!process.env[name];
    io.out(`${name}: ${present ? "set (value hidden)" : "missing"}`);
    if (!present) issues.push(`${name} is required to run`);
  }
  if (process.env[config.model.tokenEnv])
    io.out(`${config.model.tokenEnv}: set (value hidden)`);
  else if (config.model.provider === "bedrock")
    io.out(
      `${config.model.tokenEnv}: absent; AWS SDK credential chain would be used (not resolved or tested)`,
    );
  else if (
    config.model.baseUrl &&
    ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(config.model.baseUrl).hostname,
    )
  )
    io.out(
      "Local model endpoint configured without a token; inference not tested",
    );
  else
    issues.push(`${config.model.tokenEnv} is required for the model provider`);
  io.out(
    `Model: ${config.model.provider} / ${config.model.modelId}; region ${config.model.region}; no inference performed`,
  );
  io.out(
    "Budget: token/time/step limits configured; dollar enforcement requires supplied prices and dollar caps.",
  );
  try {
    const git = await runProcess("git", ["--version"], {
      timeoutMs: 5000,
      limit: 1024,
    });
    if (git.exitCode === 0) io.out(git.output.trim());
    else issues.push("Git is unavailable");
  } catch {
    issues.push("Git is unavailable");
  }
  try {
    for (const image of new Set([
      config.runtime.image,
      ...config.github.repositories
        .map((r) => r.image)
        .filter((x): x is string => !!x),
    ])) {
      const sandbox = createSandbox({ ...config.runtime, image }, unsafe);
      issues.push(
        ...(await sandbox.doctor()).map((issue) => `${image}: ${issue}`),
      );
    }
  } catch (error) {
    issues.push(errorText(error));
  }
  if (live) {
    try {
      const who = await new Github(config.github).identity();
      io.out(
        `GitHub identity verified: ${who.login} (id ${who.id}); repository/push permissions not yet verified`,
      );
    } catch (error) {
      issues.push(`GitHub identity check failed: ${errorText(error)}`);
    }
    try {
      const token = process.env[config.telegram.tokenEnv];
      if (!token) throw new Error("Configured Telegram token is missing");
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getMe`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = (await response.json()) as {
        ok?: boolean;
        result?: { is_bot?: boolean };
      };
      if (!result.ok || !result.result?.is_bot)
        throw new Error("Telegram did not return a valid bot identity");
      io.out(
        "Telegram bot identity verified; no message sent; recipient/approval flow not tested",
      );
    } catch (error) {
      issues.push(`Telegram identity check failed: ${errorText(error)}`);
    }
  }
  for (const issue of issues) io.out(`Needs attention: ${issue}`);
  io.out(
    issues.length
      ? "Doctor found issues; this is not a ready/live-service claim."
      : "Checks passed within this diagnostic scope; model and end-to-end PR flow remain untested.",
  );
  return issues.length ? 1 : 0;
}

export async function runCli(
  argv: string[],
  io: IO = { out: (s) => console.log(s), err: (s) => console.error(s) },
): Promise<number> {
  process.umask(0o077);
  const safeIO: IO = {
    out: (s) => io.out(redact(s)),
    err: (s) => io.err(redact(s)),
  };
  try {
    const { positional, flags, configPath } = argumentsFor(argv);
    const command = positional[0];
    if (!command || command === "help" || flags.has("--help")) {
      safeIO.out(HELP);
      return 0;
    }
    const allowed = [
      "init",
      "doctor",
      "run",
      "status",
      "jobs",
      "show",
      "events",
      "preferences",
      "forget",
      "pause",
      "resume",
      "retry",
    ];
    if (!allowed.includes(command))
      throw new Error("Unknown command; use reviewloop --help");
    if (flags.has("--live") && command !== "doctor")
      throw new Error("--live is only valid for doctor");
    if (flags.has("--once") && command !== "run")
      throw new Error("--once is only valid for run");
    if (
      flags.has("--repo") &&
      !(command === "preferences" && positional[1] === "add")
    )
      throw new Error("--repo is only valid for preferences add");
    if (command === "init") {
      if (positional.length !== 1)
        throw new Error("Usage: reviewloop init [--config PATH]");
      writeFileSync(
        configPath,
        JSON.stringify(exampleConfig(), null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      safeIO.out(
        `Created ${configPath}. Replace placeholders and set credentials in the service environment; no secrets written.`,
      );
      return 0;
    }
    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(
          "Configuration is not valid JSON; input content omitted",
        );
      throw error;
    }
    const unsafe = flags.has("--allow-unsafe-local");
    if (command === "doctor") {
      if (positional.length !== 1)
        throw new Error("Usage: reviewloop doctor [--live]");
      return doctor(config, flags.has("--live"), unsafe, safeIO);
    }
    if (command === "run") {
      if (positional.length !== 1)
        throw new Error("Usage: reviewloop run [--once]");
      const missing = placeholders(config);
      if (missing.length) throw new Error(missing.join("; "));
      if (
        !process.env[config.github.tokenEnv] ||
        !process.env[config.telegram.tokenEnv]
      )
        throw new Error(
          "GitHub and Telegram credentials must be set before running",
        );
      const release = acquireDaemonLock(config.runtime.stateDir);
      let store: Store | undefined;
      let controller: Controller | undefined;
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const sandbox = createSandbox(config.runtime, unsafe);
        const issues = await sandbox.doctor();
        for (const image of new Set(
          config.github.repositories
            .map((r) => r.image)
            .filter((x): x is string => !!x && x !== config.runtime.image),
        ))
          issues.push(
            ...(await createSandbox(
              { ...config.runtime, image },
              unsafe,
            ).doctor()),
          );
        const blockers = issues.filter(
          (s) =>
            !(
              unsafe &&
              config.runtime.sandbox === "unsafe-local" &&
              s.startsWith("UNISOLATED")
            ),
        );
        if (blockers.length) throw new Error(blockers.join("; "));
        const reaped = await cleanupManagedContainers(config.runtime);
        store = new Store(config.runtime.stateDir);
        store.event("service.started", undefined, {
          once: flags.has("--once"),
          reaped,
          isolated: config.runtime.sandbox !== "unsafe-local",
        });
        controller = new Controller(config, {
          store,
          sandbox,
          allowUnsafeLocal: unsafe,
        });
        safeIO.out(
          config.runtime.sandbox === "unsafe-local"
            ? "UNISOLATED fixture mode; not suitable for untrusted repositories."
            : "ReviewLoop starting; every push still requires owner approval.",
        );
        await controller.run(abort.signal, flags.has("--once"));
        return 0;
      } finally {
        try {
          await controller?.stop();
        } finally {
          try {
            store?.close();
          } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
            release();
          }
        }
      }
    }
    const release =
      command === "retry"
        ? acquireDaemonLock(config.runtime.stateDir)
        : undefined;
    let store: Store | undefined;
    try {
      store = new Store(config.runtime.stateDir);
      const db = store;
      const rest = positional.slice(1);
      if (command === "status") {
        if (rest.length) throw new Error("Usage: reviewloop status");
        const jobs = db.jobs();
        safeIO.out(
          JSON.stringify(
            {
              paused: db.getSetting("paused") === "true",
              daemon: daemonState(config.runtime.stateDir),
              jobs: jobs.length,
              awaitingApproval: jobs.filter(
                (j) => j.status === "awaiting_approval",
              ).length,
              blocked: jobs.filter((j) => j.status === "blocked").length,
              pendingNotifications: db.outbox().length,
              lastSync: db.getSetting("lastSync", "never"),
              estimatedCostUsd: db.totalCost(),
              pricesConfigured: !!config.model.inputPricePerMillion,
            },
            null,
            2,
          ),
        );
      } else if (command === "jobs") {
        if (rest.length) throw new Error("Usage: reviewloop jobs");
        safeIO.out(
          JSON.stringify(
            db.jobs().map(({ id, repo, pr, status, updatedAt }) => ({
              id,
              repo,
              pr,
              status,
              updatedAt,
            })),
            null,
            2,
          ),
        );
      } else if (command === "show") {
        if (rest.length !== 1) throw new Error("Usage: reviewloop show JOB_ID");
        const job = db.get(rest[0]!);
        if (!job) throw new Error("Unknown job");
        safeIO.out(JSON.stringify(job, null, 2));
      } else if (command === "events") {
        if (rest.length > 1)
          throw new Error("Usage: reviewloop events [JOB_ID]");
        safeIO.out(JSON.stringify(db.events(rest[0]), null, 2));
      } else if (command === "preferences") {
        if (rest[0] === "list" && rest.length === 1)
          safeIO.out(JSON.stringify(db.memories(), null, 2));
        else if (rest[0] === "add" && rest.length > 1) {
          const selected = flags.get("--repo");
          const repo = selected
            ? config.github.repositories.find(
                (r) => r.name.toLowerCase() === String(selected).toLowerCase(),
              )?.name
            : undefined;
          if (selected && !repo)
            throw new Error("Preference repository is not configured");
          const id = db.transaction(() =>
            db.remember(rest.slice(1).join(" "), repo),
          );
          safeIO.out(
            `Preference ${id} saved; preferences cannot override policy or approve pushes.`,
          );
        } else
          throw new Error(
            "Usage: reviewloop preferences list | add TEXT [--repo OWNER/REPO]",
          );
      } else if (command === "forget") {
        const id = Number(rest[0]);
        if (rest.length !== 1 || !Number.isSafeInteger(id) || id < 1)
          throw new Error("Usage: reviewloop forget MEMORY_ID");
        if (!db.transaction(() => db.forget(id)))
          throw new Error("Preference not found");
        safeIO.out(`Preference ${id} forgotten.`);
      } else if (command === "pause" || command === "resume") {
        if (rest.length) throw new Error(`Usage: reviewloop ${command}`);
        db.transaction(() => {
          db.setSetting("paused", String(command === "pause"));
          db.event(`local.${command}`, undefined);
        });
        safeIO.out(
          command === "pause"
            ? "Pause persisted; no new work or publishing should start."
            : "Resume persisted.",
        );
      } else if (command === "retry") {
        if (rest.length !== 1)
          throw new Error("Usage: reviewloop retry JOB_ID");
        db.transaction(() => {
          const job = db.get(rest[0]!);
          if (!job || job.status !== "blocked")
            throw new Error("Only a blocked job can be retried");
          if (job.candidateSha)
            throw new Error(
              "Blocked publication requires remote reconciliation; cannot retry blindly",
            );
          const used = db.budget(job);
          if (
            used.attempts >= config.runtime.maxRepairAttempts ||
            used.inputTokens >= config.runtime.maxInputTokens ||
            used.outputTokens >= config.runtime.maxOutputTokens ||
            (config.runtime.maxCostUsd !== undefined &&
              used.costUsd >= config.runtime.maxCostUsd)
          )
            throw new Error("Job-group budget exhausted");
          job.status = "queued";
          job.error = undefined;
          job.approvalNonce = undefined;
          db.save(job);
          db.event("local.retry", job.id);
        });
        safeIO.out(
          "Queued with existing usage and attempt budgets. Start the supervisor to execute.",
        );
      }
      return 0;
    } finally {
      store?.close();
      release?.();
    }
  } catch (error) {
    safeIO.err(`ReviewLoop: ${errorText(error)}`);
    return 1;
  }
}

let isEntry = false;
try {
  isEntry =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url));
} catch {}
if (isEntry) process.exitCode = await runCli(process.argv.slice(2));
