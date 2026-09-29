import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { CheckResult, Config, Sandbox } from "./types.js";

export function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

/** Host process helper: no shell expansion, secret-free env, bounded pipes, group cleanup. */
export async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    limit: number;
    signal?: AbortSignal;
  },
): Promise<{ exitCode: number; output: string; durationMs: number }> {
  options.signal?.throwIfAborted();
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? cleanEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let size = 0;
    const chunks: Buffer[] = [];
    let forced: number | undefined;
    let timer: NodeJS.Timeout;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    const stop = (code: number) => {
      if (forced !== undefined) return;
      forced = code;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 200);
    };
    const abort = () => stop(130);
    timer = setTimeout(() => stop(124), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const capture = (data: Buffer) => {
      const available = Math.max(0, options.limit - size);
      chunks.push(data.subarray(0, available));
      size += data.length;
      if (size > options.limit) stop(125);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const clear = () => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      kill("SIGKILL");
    };
    child.on("error", (error) => {
      clear();
      reject(
        new Error(
          `Cannot start execution runtime (${(error as NodeJS.ErrnoException).code ?? "spawn failed"})`,
        ),
      );
    });
    child.on("close", (code) => {
      clear();
      let output = Buffer.concat(chunks).toString("utf8");
      if (forced !== undefined)
        output = Buffer.from(
          output +
            `\n[execution stopped: ${forced === 124 ? "timeout" : forced === 130 ? "aborted" : "output limit"}]`,
        )
          .subarray(0, options.limit)
          .toString("utf8");
      resolve({
        exitCode: forced ?? code ?? 1,
        output,
        durationMs: Date.now() - start,
      });
    });
  });
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    HOME: homedir(),
    ...(process.env.XDG_RUNTIME_DIR
      ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
      : {}),
  };
}

function prefix(kind: "podman" | "docker"): string[] {
  if (kind === "podman") return ["--remote=false"];
  const rootless = path.join(
    process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
    "docker.sock",
  );
  return [
    "--host",
    `unix://${rootless && existsSync(rootless) ? rootless : "/var/run/docker.sock"}`,
  ];
}

export function containerArgs(
  kind: "podman" | "docker",
  workspace: string,
  image: string,
  command: string,
  cidfile: string,
  mask?: string,
  scope = "fixture",
  timeoutSeconds = 120,
): string[] {
  if (workspace.includes(",") || mask?.includes(","))
    throw new Error("Workspace path cannot contain a mount delimiter");
  const uid = process.getuid?.() || 65534;
  const gid = process.getgid?.() || 65534;
  return [
    ...prefix(kind),
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--cpus=2",
    "--memory=2g",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=256m",
    "--cidfile",
    cidfile,
    "--name",
    `reviewloop-${path.basename(path.dirname(cidfile)).toLowerCase()}`,
    "--label=reviewloop.managed=true",
    `--label=reviewloop.scope=${scope}`,
    ...(kind === "podman" ? [`--timeout=${timeoutSeconds + 5}`] : []),
    ...(kind === "podman" ? ["--userns=keep-id"] : []),
    "--user",
    kind === "docker" ? "0:0" : `${uid}:${gid}`,
    "--workdir=/workspace",
    "--mount",
    `type=bind,src=${workspace},dst=/workspace,rw`,
    ...(mask
      ? ["--mount", `type=bind,src=${mask},dst=/workspace/.git,readonly`]
      : []),
    "--env=HOME=/tmp",
    "--env=LANG=C.UTF-8",
    "--env=PATH=/usr/local/bin:/usr/bin:/bin",
    "--entrypoint=/usr/bin/timeout",
    image,
    "--signal=TERM",
    "--kill-after=5s",
    `${timeoutSeconds}s`,
    "/bin/sh",
    "-c",
    command,
  ];
}

export function createSandbox(
  config: Config["runtime"],
  allowUnsafeLocal = false,
): Sandbox {
  if (config.sandbox === "unsafe-local" && !allowUnsafeLocal)
    throw new Error(
      "unsafe-local is unisolated and requires explicit fixture-test authorization",
    );
  if (!["podman", "docker", "unsafe-local"].includes(config.sandbox))
    throw new Error("Unknown sandbox");
  return {
    async doctor() {
      if (config.sandbox === "unsafe-local")
        return ["UNISOLATED fixture-only unsafe-local execution selected"];
      const issues: string[] = [];
      try {
        const info = await runProcess(
          config.sandbox,
          [...prefix(config.sandbox), "info", "--format=json"],
          { env: runtimeEnvironment(), timeoutMs: 10_000, limit: 65_536 },
        );
        if (info.exitCode !== 0)
          issues.push("Container runtime is unavailable");
        else if (!rootlessInfo(config.sandbox, JSON.parse(info.output)))
          issues.push(`${config.sandbox} must run rootless`);
        const image = await runProcess(
          config.sandbox,
          [...prefix(config.sandbox), "image", "inspect", config.image],
          { env: runtimeEnvironment(), timeoutMs: 10_000, limit: 131_072 },
        );
        if (image.exitCode !== 0)
          issues.push(
            "Configured image is not preloaded; automatic pulls are disabled",
          );
      } catch {
        issues.push(
          "Cannot inspect runtime/image; install and configure it explicitly",
        );
      }
      return issues;
    },
    async run(workspace, command, options = {}) {
      if (!command || command.length > 65_536)
        throw new Error("Invalid command size");
      options.signal?.throwIfAborted();
      if ((await lstat(workspace)).isSymbolicLink())
        throw new Error("Workspace cannot be a symlink");
      const root = await realpath(workspace);
      const timeoutMs = Math.min(
        options.timeoutMs ?? 120_000,
        config.maxJobMinutes * 60_000,
      );
      if (config.sandbox === "unsafe-local") {
        const result = await runProcess("/bin/sh", ["-c", command], {
          cwd: root,
          timeoutMs,
          limit: config.maxToolOutputBytes,
          signal: options.signal,
          env: { ...cleanEnvironment(), HOME: root },
        });
        return {
          command,
          ...result,
          output: `[UNISOLATED fixture mode]\n${result.output}`.slice(
            0,
            config.maxToolOutputBytes,
          ),
        };
      }
      const info = await runProcess(
        config.sandbox,
        [...prefix(config.sandbox), "info", "--format=json"],
        {
          env: runtimeEnvironment(),
          timeoutMs: 10_000,
          limit: 65_536,
          signal: options.signal,
        },
      );
      if (
        info.exitCode !== 0 ||
        !rootlessInfo(config.sandbox, JSON.parse(info.output))
      )
        throw new Error(`Rootless ${config.sandbox} is required for execution`);
      const dir = await mkdtemp(path.join(tmpdir(), "reviewloop-container-"));
      const cidfile = path.join(dir, "cid");
      const mask = path.join(dir, "git-mask");
      try {
        let gitFile = false;
        let gitPresent = false;
        try {
          const entry = await lstat(path.join(root, ".git"));
          if (entry.isSymbolicLink())
            throw new Error(".git symlink is forbidden");
          gitFile = entry.isFile();
          gitPresent = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (gitFile) await writeFile(mask, "", { mode: 0o000 });
        else await mkdir(mask, { mode: 0o000 });
        const args = containerArgs(
          config.sandbox,
          root,
          options.image ?? config.image,
          command,
          cidfile,
          gitPresent ? mask : undefined,
          scopeId(config.stateDir),
          Math.max(1, Math.ceil(timeoutMs / 1000)),
        );
        const result = await runProcess(config.sandbox, args, {
          env: runtimeEnvironment(),
          timeoutMs,
          limit: config.maxToolOutputBytes,
          signal: options.signal,
        });
        return { command, ...result };
      } finally {
        // Kill by recorded container ID even when the CLI was killed on timeout/abort.
        let cleanupError: Error | undefined;
        try {
          let id: string | undefined;
          try {
            id = (await readFile(cidfile, "utf8")).trim();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (id && !/^[a-f0-9]{12,64}$/.test(id))
            throw new Error("Invalid runtime container identifier");
          id ??= `reviewloop-${path.basename(dir).toLowerCase()}`;
          if (id) {
            if (!/^(?:[a-f0-9]{12,64}|reviewloop-[a-z0-9-]+)$/.test(id))
              throw new Error("Invalid runtime container identifier");
            const removed = await runProcess(
              config.sandbox,
              [...prefix(config.sandbox), "rm", "--force", id],
              { env: runtimeEnvironment(), timeoutMs: 10_000, limit: 2048 },
            );
            if (removed.exitCode !== 0) {
              const remaining = await runProcess(
                config.sandbox,
                [
                  ...prefix(config.sandbox),
                  "ps",
                  "--all",
                  "--no-trunc",
                  "--format",
                  "{{.ID}}",
                  "--filter",
                  `${id.startsWith("reviewloop-") ? "name" : "id"}=${id}`,
                ],
                { env: runtimeEnvironment(), timeoutMs: 10_000, limit: 2048 },
              );
              if (remaining.exitCode !== 0 || remaining.output.trim())
                throw new Error(
                  "Container cleanup could not be confirmed; operator intervention required",
                );
            }
          }
        } catch {
          cleanupError = new Error(
            "Container cleanup could not be confirmed; operator intervention required",
          );
        }
        await rm(dir, { recursive: true, force: true });
        if (cleanupError) throw cleanupError;
      }
    },
  };
}

function rootlessInfo(
  kind: "podman" | "docker",
  value: Record<string, any>,
): boolean {
  return kind === "podman"
    ? value.host?.security?.rootless === true
    : Array.isArray(value.SecurityOptions) &&
        value.SecurityOptions.some(
          (entry: unknown) =>
            typeof entry === "string" &&
            entry.split(",").includes("name=rootless"),
        );
}

function scopeId(stateDir: string): string {
  return createHash("sha256")
    .update(path.resolve(stateDir))
    .digest("hex")
    .slice(0, 24);
}

/** Run only after acquiring the state-directory writer lock, before crash recovery. */
export async function cleanupManagedContainers(
  config: Config["runtime"],
): Promise<number> {
  if (config.sandbox === "unsafe-local") return 0;
  const listed = await runProcess(
    config.sandbox,
    [
      ...prefix(config.sandbox),
      "ps",
      "--all",
      "--no-trunc",
      "--format",
      "{{.ID}}",
      "--filter",
      `label=reviewloop.scope=${scopeId(config.stateDir)}`,
    ],
    { env: runtimeEnvironment(), timeoutMs: 10_000, limit: 65_536 },
  );
  if (listed.exitCode !== 0)
    throw new Error("Cannot reconcile existing ReviewLoop containers");
  const ids = listed.output.trim().split(/\s+/).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw new Error("Runtime returned invalid container identifiers");
  for (const id of ids) {
    const result = await runProcess(
      config.sandbox,
      [...prefix(config.sandbox), "rm", "--force", id],
      { env: runtimeEnvironment(), timeoutMs: 10_000, limit: 2048 },
    );
    if (result.exitCode !== 0)
      throw new Error("Cannot remove a stale ReviewLoop container");
  }
  return ids.length;
}
