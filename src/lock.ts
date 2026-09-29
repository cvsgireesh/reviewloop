import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface Owner {
  pid: number;
  host: string;
  identity: string;
  nonce: string;
  createdAt: string;
}
const names = (directory: string) => ({
  lock: join(directory, "daemon.lock"),
  recovery: join(directory, "daemon.lock.recovery"),
});

function identity(pid: number): string {
  if (process.platform === "linux") {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!fields[19]) throw new Error("Cannot identify process start");
    return `${boot}:${fields[19]}`;
  }
  const started = execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    { encoding: "utf8", timeout: 2000, env: { PATH: "/usr/bin:/bin" } },
  ).trim();
  if (!started) throw new Error("Cannot identify process start");
  return started;
}

function owner(directory: string): Owner {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid writer lock; inspect it manually");
  const value = JSON.parse(
    readFileSync(join(directory, "owner.json"), "utf8"),
  ) as Owner;
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.nonce !== "string" ||
    typeof value.identity !== "string" ||
    typeof value.host !== "string"
  )
    throw new Error("Invalid writer lock; inspect it manually");
  return value;
}

export function daemonState(
  directory: string,
): "absent" | "active" | "stale" | "unknown" {
  const { lock } = names(directory);
  if (!existsSync(lock)) return "absent";
  try {
    const held = owner(lock);
    if (held.host !== hostname()) return "unknown";
    try {
      process.kill(held.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "stale"
        : "unknown";
    }
    return identity(held.pid) === held.identity ? "active" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Exclusive run/retry lock. Never delete a live, foreign-host, partial or PID-reused lock. */
export function acquireDaemonLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { lock, recovery } = names(directory);
  if (existsSync(recovery))
    throw new Error(
      "Writer-lock recovery is in progress or needs manual inspection",
    );
  let held: Owner;
  const claim = () => {
    mkdirSync(lock, { mode: 0o700 });
    try {
      held = {
        pid: process.pid,
        host: hostname(),
        identity: identity(process.pid),
        nonce: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(join(lock, "owner.json"), JSON.stringify(held), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
  };
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (daemonState(directory) !== "stale")
      throw new Error(
        "Another daemon/writer may be active; stop it or inspect the lock before retrying",
      );
    try {
      mkdirSync(recovery, { mode: 0o700 });
    } catch {
      throw new Error("Another writer is recovering the stale lock");
    }
    try {
      if (daemonState(directory) !== "stale")
        throw new Error("Writer lock changed; refusing recovery");
      rmSync(lock, { recursive: true });
      claim();
    } finally {
      rmSync(recovery, { recursive: true, force: true });
    }
  }
  const nonce = held!.nonce;
  return () => {
    if (existsSync(lock) && owner(lock).nonce === nonce)
      rmSync(lock, { recursive: true });
  };
}
