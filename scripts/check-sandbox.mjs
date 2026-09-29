#!/usr/bin/env node
// Explicit local qualification only. Never invokes a model, GitHub or Telegram.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const help = `ReviewLoop real sandbox qualification
Usage: node scripts/check-sandbox.mjs [--config ./reviewloop.json]
Requires a built project, configured rootless Podman/Docker and a preloaded image.
Uses an isolated temporary scope; no image pulls, model calls or service credentials.
Tests filesystem/environment/network boundaries and a real command deadline.
`;
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(help);
    return;
  }
  let configPath = "./reviewloop.json";
  if (args.length) {
    if (
      args.length !== 2 ||
      args[0] !== "--config" ||
      !args[1] ||
      args[1].startsWith("-")
    )
      throw new Error("Use --help for valid arguments");
    configPath = args[1];
  }
  const { loadConfig } = await import("../dist/config.js");
  const { createSandbox, cleanupManagedContainers } =
    await import("../dist/sandbox.js");
  const config = loadConfig(resolve(configPath));
  if (!["podman", "docker"].includes(config.runtime.sandbox))
    throw new Error(
      "Qualification requires rootless Podman or Docker; unsafe-local is rejected",
    );
  const temporary = await mkdtemp(join(tmpdir(), "reviewloop-qualification-"));
  const sentinelName = `REVIEWLOOP_QUALIFICATION_SECRET_${randomBytes(8).toString("hex").toUpperCase()}`;
  process.env[sentinelName] = randomBytes(24).toString("hex");
  let sandbox;
  let cleanupConfirmed = false;
  let executionStarted = false;
  try {
    const state = join(temporary, "state"),
      workspace = join(temporary, "workspace");
    await mkdir(state, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(join(workspace, ".git"), { mode: 0o700 });
    await writeFile(
      join(workspace, ".git", "controller-secret"),
      "qualification-only\n",
      { mode: 0o600 },
    );
    // A unique state path labels only this qualification's containers, never the daemon's.
    const runtime = { ...config.runtime, stateDir: state };
    sandbox = createSandbox(runtime);
    const issues = await sandbox.doctor();
    if (issues.length) {
      console.error(`Runtime cannot qualify: ${issues.join("; ")}`);
      throw new Error("Runtime qualification blocked");
    }
    const expectedUid =
      runtime.sandbox === "docker" ? 0 : process.getuid?.() || 65534;
    const probe = `set -eu
[ -z "\${${sentinelName}+set}" ] || exit 11
printf 'fixture-ok\\n' > /workspace/qualification-result
[ ! -r /workspace/.git/controller-secret ] || exit 12
for socket in /var/run/docker.sock /run/docker.sock /run/podman/podman.sock /run/user/*/docker.sock /run/user/*/podman/podman.sock; do
  [ ! -S "$socket" ] || exit 13
done
awk '$2 == "/" { n=split($4,a,","); for(i=1;i<=n;i++) if(a[i]=="ro") found=1 } END { exit !found }' /proc/mounts || exit 14
[ -d /sys/class/net ] || exit 15
set -- /sys/class/net/*
[ "$#" -eq 1 ] && [ "\${1##*/}" = lo ] || exit 16
[ "$(id -u)" -eq ${expectedUid} ] || exit 17
awk '$1 == "CapEff:" { seen=1; if($2 !~ /^0+$/) bad=1 } END { exit (!seen || bad) }' /proc/self/status || exit 17
printf 'UID=%s GID=%s\\n' "$(id -u)" "$(id -g)"
printf 'Boundary checks passed\\n'
`;
    executionStarted = true;
    const result = await sandbox.run(workspace, probe, { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      console.error(`Boundary probe failed: exit ${result.exitCode}`);
      throw new Error("Boundary probe failed");
    }
    if (
      (await readFile(join(workspace, "qualification-result"), "utf8")) !==
      "fixture-ok\n"
    )
      throw new Error("Workspace write did not reach the isolated fixture");
    const identity = result.output.match(/UID=\d+ GID=\d+/)?.[0];
    if (!identity) throw new Error("Container identity evidence missing");
    console.log(identity);
    console.log(
      "PASS: parent secret absent; workspace writable; root mount read-only; Git sentinel and host runtime sockets inaccessible; loopback-only network; expected namespace UID and no effective capabilities.",
    );
    const start = Date.now();
    const timed = await sandbox.run(
      workspace,
      "sleep 30; printf unexpected > /workspace/timeout-failed",
      { timeoutMs: 1_000 },
    );
    if (timed.exitCode !== 124 || Date.now() - start > 20_000)
      throw new Error(
        "Deadline qualification failed: expected timeout exit 124 within 20 seconds including cleanup",
      );
    try {
      await readFile(join(workspace, "timeout-failed"));
      throw new Error("Timed command reached its forbidden completion marker");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await cleanupManagedContainers(runtime);
    cleanupConfirmed = true;
    console.log(
      "PASS: real command deadline stopped the fixture and scoped cleanup completed.",
    );
    console.log(
      "Sandbox qualification PASSED for this runtime/image. This does not prove VM isolation or qualify another image/host.",
    );
  } finally {
    delete process.env[sentinelName];
    // run() owns per-command cleanup; this sweep uses only the temporary state scope.
    if (sandbox && executionStarted && !cleanupConfirmed) {
      try {
        await cleanupManagedContainers({
          ...config.runtime,
          stateDir: join(temporary, "state"),
        });
      } catch {
        console.error(
          "Qualification cleanup could not be confirmed; inspect runtime containers labeled for the temporary qualification scope.",
        );
        process.exitCode = 1;
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error(
    "Sandbox qualification FAILED. No live isolation claim is established. Check configured rootless runtime, preloaded image tools and local runtime diagnostics.",
  );
  process.exitCode = 1;
});
