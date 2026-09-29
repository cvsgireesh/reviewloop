import { mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  mkdir,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, ModelProvider, Sandbox, CheckResult } from "./types.js";
import { runHarness } from "./harness.js";
import { createModel } from "./model.js";
import { createSandbox } from "./sandbox.js";
import { errorText, redact } from "./util.js";

interface Manifest {
  id: string;
  title: string;
  feedback: string;
  ownerPreferences: string[];
  workspace: string;
  reference: string;
  allowedChanges: string[];
  checks: string[];
  hiddenChecks: string[];
}
interface Usage {
  inputTokens: number;
  outputTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  costUsd: number | null;
  unresolvedCalls: number;
}
interface Verification {
  passed: boolean;
  integrityPassed: boolean;
  checks: CheckResult[];
}
export interface EvaluationTaskResult {
  id: string;
  passed: boolean;
  visiblePassed: boolean;
  hiddenPassed: boolean;
  pathConstraintsPassed: boolean;
  changedPaths: string[];
  usage: Usage;
  latencyMs: number;
  summary?: string;
  error?: string;
  visible?: Verification;
  hidden?: Verification;
  baselineVisiblePassed?: boolean;
  baselineHiddenFailed?: boolean;
}
export interface EvaluationReport {
  schemaVersion: 1;
  actualMode: "reference" | "model";
  providerKind: "none" | "injected" | "configured";
  modelId: string | null;
  label: string;
  startedAt: string;
  completedAt?: string;
  latencyMs: number;
  passed: boolean;
  sandbox: string;
  reportPath: string;
  prices: { inputPerMillion?: number; outputPerMillion?: number };
  usage: Usage;
  tasks: EvaluationTaskResult[];
}
const fixtureRoot = fileURLToPath(new URL("../evals/", import.meta.url));
const usage = (priced: boolean): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  actualInputTokens: 0,
  actualOutputTokens: 0,
  costUsd: priced ? 0 : null,
  unresolvedCalls: 0,
});
type Snapshot = Map<string, { content: Buffer; mode: number }>;
function safeRelative(value: string): string {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid fixture path");
  return value;
}
async function snapshot(root: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  let entries = 0;
  let bytes = 0;
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 10_000)
        throw new Error("Evaluation workspace exceeds file limit");
      const filename = join(directory, entry.name);
      const stat = await lstat(filename);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw new Error(
          "Evaluation rejects symlinks, hardlinks and special files",
        );
      if (entry.name.toLowerCase() === ".git")
        throw new Error("Evaluation rejects worker-created Git metadata");
      if (stat.isDirectory()) await walk(filename);
      else {
        bytes += stat.size;
        if (bytes > 16 * 1024 * 1024)
          throw new Error("Evaluation workspace exceeds 16 MiB");
        files.set(relative(root, filename).split("\\").join("/"), {
          content: await readFile(filename),
          mode: stat.mode & 0o777,
        });
      }
    }
  }
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error("Invalid evaluation workspace");
  await walk(root);
  return files;
}
async function materialize(root: string, files: Snapshot) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [name, file] of files) {
    const destination = join(root, safeRelative(name));
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { mode: file.mode });
  }
}
function changes(a: Snapshot, b: Snapshot): string[] {
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((name) => {
      const left = a.get(name),
        right = b.get(name);
      return (
        !left ||
        !right ||
        (left.mode & 0o111) !== (right.mode & 0o111) ||
        !left.content.equals(right.content)
      );
    })
    .sort();
}

/** Blind single-harness evaluation. Callers must explicitly authorize configured provider calls. */
export async function runEvaluation(
  config: Config,
  opts: {
    task?: string;
    outputDir: string;
    model?: ModelProvider;
    sandbox?: Sandbox;
    reference?: boolean;
  },
): Promise<EvaluationReport> {
  const started = Date.now();
  const names = (await readdir(fixtureRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (opts.task && !names.includes(opts.task))
    throw new Error("Unknown evaluation task");
  const selected = opts.task ? [opts.task] : names;
  const manifests: { manifest: Manifest; directory: string }[] = [];
  for (const name of selected) {
    const directory = join(fixtureRoot, name);
    if (!existsSync(join(directory, "manifest.json"))) continue;
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as Manifest;
    if (
      manifest.id !== name ||
      !manifest.checks?.length ||
      !manifest.hiddenChecks?.length ||
      !manifest.allowedChanges?.length
    )
      throw new Error("Invalid evaluation manifest");
    [
      manifest.workspace,
      manifest.reference,
      ...manifest.allowedChanges,
      ...manifest.hiddenChecks,
    ].forEach(safeRelative);
    manifests.push({ manifest, directory });
  }
  if (!manifests.length) throw new Error("No evaluation tasks selected");
  const priced =
    config.model.inputPricePerMillion !== undefined &&
    config.model.outputPricePerMillion !== undefined;
  if (!priced && (config.runtime.maxCostUsd || config.runtime.maxTotalCostUsd))
    throw new Error("Evaluation dollar caps require configured prices");
  const injected = !!opts.model;
  if (!opts.reference && !injected && config.runtime.sandbox === "unsafe-local")
    throw new Error(
      "Actual model evaluation requires a rootless container sandbox",
    );
  if (
    !opts.reference &&
    config.runtime.sandbox === "unsafe-local" &&
    !opts.sandbox
  )
    throw new Error(
      "Unsafe-local model fixtures require explicit injected model and sandbox",
    );
  const sandbox =
    opts.sandbox ??
    createSandbox(
      opts.reference
        ? { ...config.runtime, sandbox: "unsafe-local" }
        : config.runtime,
      !!opts.reference,
    );
  if (
    !opts.reference &&
    !(injected && opts.sandbox && config.runtime.sandbox === "unsafe-local")
  ) {
    const issues = await sandbox.doctor();
    if (issues.length)
      throw new Error(
        `Evaluation sandbox preflight failed: ${issues.join("; ")}`,
      );
  }
  const output = resolve(opts.outputDir);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const reportPath = join(output, "report.json");
  const report: EvaluationReport = {
    schemaVersion: 1,
    actualMode: opts.reference ? "reference" : "model",
    providerKind: opts.reference
      ? "none"
      : injected
        ? "injected"
        : "configured",
    modelId: opts.reference ? null : config.model.modelId,
    label: opts.reference
      ? "Fixture validation, not model evaluation"
      : injected
        ? "Injected-provider harness test, not measured real-model quality"
        : "Blind model evaluation on four narrow synthetic PR-repair fixtures",
    startedAt: new Date(started).toISOString(),
    latencyMs: 0,
    passed: false,
    sandbox:
      opts.reference && !opts.sandbox
        ? "unsafe-local trusted reference fixture"
        : config.runtime.sandbox,
    reportPath,
    prices: {
      inputPerMillion: config.model.inputPricePerMillion,
      outputPerMillion: config.model.outputPricePerMillion,
    },
    usage: usage(priced),
    tasks: [],
  };
  // Refuse overwriting a prior pilot's accounting or results.
  writeFileSync(reportPath, JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  const persist = () => {
    report.latencyMs = Date.now() - started;
    writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    renameSync(`${reportPath}.tmp`, reportPath);
  };
  const price = (input: number, out: number) =>
    (input * (config.model.inputPricePerMillion ?? 0) +
      out * (config.model.outputPricePerMillion ?? 0)) /
    1_000_000;
  const model = opts.reference
    ? undefined
    : (opts.model ?? createModel(config.model));
  const scratch = await mkdtemp(join(tmpdir(), "reviewloop-evaluate-"));
  try {
    for (const { manifest, directory } of manifests) {
      const taskStarted = Date.now();
      const result: EvaluationTaskResult = {
        id: manifest.id,
        passed: false,
        visiblePassed: false,
        hiddenPassed: false,
        pathConstraintsPassed: false,
        changedPaths: [],
        usage: usage(priced),
        latencyMs: 0,
      };
      report.tasks.push(result);
      persist();
      const signal = AbortSignal.timeout(config.runtime.maxJobMinutes * 60_000);
      const taskRoot = join(scratch, manifest.id);
      await mkdir(taskRoot, { recursive: true });
      let verificationIndex = 0;
      const verify = async (
        files: Snapshot,
        hidden: boolean,
      ): Promise<Verification> => {
        const work = join(taskRoot, `verify-${verificationIndex++}`);
        await materialize(work, files);
        if (hidden) {
          for (let i = 0; i < manifest.hiddenChecks.length; i++) {
            const target = join(work, ".reviewloop-eval", `${i}.test.cjs`);
            await mkdir(join(target, ".."), { recursive: true });
            await writeFile(
              target,
              await readFile(join(directory, manifest.hiddenChecks[i]!)),
              { mode: 0o400 },
            );
          }
        }
        const frozen = await snapshot(work);
        const commands = hidden
          ? [
              'REVIEWLOOP_WORKSPACE="$PWD" node --test --test-reporter=tap .reviewloop-eval/*.test.cjs',
            ]
          : manifest.checks;
        const checks: CheckResult[] = [];
        for (const command of commands) {
          const evidence = await sandbox.run(work, command, {
            signal,
            timeoutMs: config.runtime.maxJobMinutes * 60_000,
          });
          checks.push({ ...evidence, output: redact(evidence.output) });
        }
        const integrityPassed =
          changes(frozen, await snapshot(work)).length === 0;
        // Detect a candidate exiting before the known hidden test cases execute.
        let hiddenCounts = true;
        if (hidden) {
          let expected = 0;
          for (const filename of manifest.hiddenChecks)
            expected += (
              (await readFile(join(directory, filename), "utf8")).match(
                /\btest\s*\(/g,
              ) ?? []
            ).length;
          const text = checks.map((c) => c.output).join("\n");
          const tests = /^# tests (\d+)\s*$/m.exec(text);
          const pass = /^# pass (\d+)\s*$/m.exec(text);
          hiddenCounts =
            !!tests &&
            !!pass &&
            Number(tests[1]) === expected &&
            Number(pass[1]) === expected;
        }
        return {
          checks,
          integrityPassed,
          passed:
            checks.length > 0 &&
            checks.every((c) => c.exitCode === 0) &&
            integrityPassed &&
            hiddenCounts,
        };
      };
      try {
        const baseline = await snapshot(join(directory, manifest.workspace));
        let candidate: Snapshot;
        if (opts.reference) {
          const initialVisible = await verify(baseline, false);
          const initialHidden = await verify(baseline, true);
          result.baselineVisiblePassed = initialVisible.passed;
          result.baselineHiddenFailed =
            !initialHidden.passed &&
            initialHidden.integrityPassed &&
            initialHidden.checks.some((c) => c.exitCode !== 0);
          candidate = new Map(baseline);
          for (const [name, file] of await snapshot(
            join(directory, manifest.reference),
          ))
            candidate.set(name, file);
        } else {
          const workspace = join(taskRoot, "worker");
          await materialize(workspace, baseline);
          let reservation:
            { input: number; output: number; cost: number } | undefined;
          const adjust = (
            input: number,
            out: number,
            cost: number,
            uncertain: number,
            actual = false,
          ) => {
            for (const account of [result.usage, report.usage]) {
              account.inputTokens += input;
              account.outputTokens += out;
              account.unresolvedCalls += uncertain;
              if (account.costUsd !== null) account.costUsd += cost;
              if (actual) {
                account.actualInputTokens += input;
                account.actualOutputTokens += out;
              }
            }
          };
          const finished = await runHarness(
            {
              workspace,
              task: `PR: ${manifest.title}\n${manifest.feedback}\nRequired visible checks: ${manifest.checks.join("; ")}`,
              preferences: manifest.ownerPreferences ?? [],
              priorSummaries: [],
              config,
              signal,
              beforeCall(input, out) {
                const cost = price(input, out);
                if (
                  result.usage.inputTokens + input >
                    config.runtime.maxInputTokens ||
                  result.usage.outputTokens + out >
                    config.runtime.maxOutputTokens
                )
                  throw new Error(
                    "Evaluation task token budget reached before model call",
                  );
                if (
                  (config.runtime.maxTotalInputTokens !== undefined &&
                    report.usage.inputTokens + input >
                      config.runtime.maxTotalInputTokens) ||
                  (config.runtime.maxTotalOutputTokens !== undefined &&
                    report.usage.outputTokens + out >
                      config.runtime.maxTotalOutputTokens)
                )
                  throw new Error(
                    "Evaluation pilot token budget reached before model call",
                  );
                if (
                  (config.runtime.maxCostUsd !== undefined &&
                    (result.usage.costUsd ?? 0) + cost >
                      config.runtime.maxCostUsd) ||
                  (config.runtime.maxTotalCostUsd !== undefined &&
                    (report.usage.costUsd ?? 0) + cost >
                      config.runtime.maxTotalCostUsd)
                )
                  throw new Error(
                    "Evaluation dollar budget reached before model call",
                  );
                reservation = { input, output: out, cost };
                adjust(input, out, cost, 1);
                persist();
              },
              onUsage(input, out) {
                if (!reservation)
                  throw new Error("Model usage without reservation");
                adjust(
                  -reservation.input,
                  -reservation.output,
                  -reservation.cost,
                  -1,
                );
                reservation = undefined;
                adjust(input, out, price(input, out), 0, true);
                persist();
                if (
                  result.usage.inputTokens > config.runtime.maxInputTokens ||
                  result.usage.outputTokens > config.runtime.maxOutputTokens ||
                  (config.runtime.maxTotalInputTokens !== undefined &&
                    report.usage.inputTokens >
                      config.runtime.maxTotalInputTokens) ||
                  (config.runtime.maxTotalOutputTokens !== undefined &&
                    report.usage.outputTokens >
                      config.runtime.maxTotalOutputTokens) ||
                  (config.runtime.maxCostUsd !== undefined &&
                    (result.usage.costUsd ?? 0) > config.runtime.maxCostUsd) ||
                  (config.runtime.maxTotalCostUsd !== undefined &&
                    (report.usage.costUsd ?? 0) >
                      config.runtime.maxTotalCostUsd)
                )
                  throw new Error(
                    "Reported model usage exceeded evaluation budget",
                  );
              },
              onEvent() {
                /* No prompts or model tool payloads persisted in the report. */
              },
            },
            model!,
            sandbox,
          );
          result.summary = redact(finished.summary);
          candidate = await snapshot(workspace);
        }
        result.changedPaths = changes(baseline, candidate);
        const changedBytes = result.changedPaths.reduce(
          (total, path) =>
            total +
            (candidate.get(path)?.content.length ?? 0) +
            (baseline.get(path)?.content.length ?? 0),
          0,
        );
        result.pathConstraintsPassed =
          result.changedPaths.length <= config.runtime.maxChangedFiles &&
          changedBytes <= config.runtime.maxPatchBytes &&
          result.changedPaths.every((path) =>
            manifest.allowedChanges.includes(path),
          );
        if (!result.pathConstraintsPassed)
          throw new Error(
            "Candidate violated allowed paths or configured change bounds",
          );
        // Persist only the frozen candidate; never give these evaluator paths to the worker.
        await materialize(join(output, manifest.id, "candidate"), candidate);
        result.visible = await verify(candidate, false);
        result.visiblePassed = result.visible.passed;
        result.hidden = await verify(candidate, true);
        result.hiddenPassed = result.hidden.passed;
        result.passed =
          result.pathConstraintsPassed &&
          result.visiblePassed &&
          result.hiddenPassed &&
          (!opts.reference ||
            (!!result.baselineVisiblePassed && !!result.baselineHiddenFailed));
      } catch (error) {
        result.error = errorText(error);
      }
      result.latencyMs = Date.now() - taskStarted;
      persist();
    }
    report.passed = report.tasks.every((task) => task.passed);
    report.completedAt = new Date().toISOString();
    persist();
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
