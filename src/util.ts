import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function redact(text: string): string {
  let result = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(name) &&
      value &&
      value.length > 6
    )
      result = result.split(value).join("[REDACTED]");
  }
  return result
    .replace(/(https:\/\/api\.telegram\.org\/bot)[^/\s]+/g, "$1[REDACTED]")
    .replace(
      /(authorization\s*[:=]\s*)(?:bearer|basic)\s+\S+/gi,
      "$1[REDACTED]",
    );
}
export function safeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}
export async function command(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? safeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const limit = options.maxBytes ?? 2_000_000;
    let stdout = "",
      stderr = "",
      total = 0,
      ended = false,
      killed = false;
    const kill = () => {
      killed = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(kill, options.timeoutMs ?? 120_000);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout.on("data", (b: Buffer) => {
      total += b.length;
      if (total > limit) kill();
      else stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      total += b.length;
      if (total > limit) kill();
      else stderr += b.toString();
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      ended = true;
    };
    child.on("error", (error) => {
      cleanup();
      reject(new Error(redact(error.message)));
    });
    child.on("close", (code) => {
      if (ended) return;
      cleanup();
      if (killed)
        reject(
          new Error("Command aborted, timed out or exceeded output limit"),
        );
      else resolve({ stdout, stderr: redact(stderr), code: code ?? -1 });
    });
  });
}
export function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
