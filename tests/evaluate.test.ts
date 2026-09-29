import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleConfig } from "../src/config.js";
import { createSandbox } from "../src/sandbox.js";
import { runEvaluation, type EvaluationReport } from "../src/evaluate.js";
import type { ModelProvider, ModelRequest } from "../src/types.js";
import type { TestContext } from "node:test";
async function fixture(t: TestContext) {
  const outputDir = await mkdtemp(join(tmpdir(), "reviewloop-evaluate-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const config = exampleConfig();
  config.runtime.sandbox = "unsafe-local";
  config.model.modelId = "scripted-fixture";
  const sandbox = createSandbox(config.runtime, true);
  return { outputDir, config, sandbox };
}
const textReply = {
  content: [
    { type: "text" as const, text: "Candidate ready for independent checks." },
  ],
  inputTokens: 10,
  outputTokens: 10,
};
const redactionFix = `const secrets = new Set(['password','token','authorization']);\nfunction redactSecrets(value) { if (value === null || typeof value !== 'object') return value; if (Array.isArray(value)) return value.map(redactSecrets); return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,secrets.has(key.toLowerCase())?'[REDACTED]':redactSecrets(item)])); }\nmodule.exports={redactSecrets};\n`;
function script(
  contents: { path: string; content: string }[],
  requests: ModelRequest[] = [],
): ModelProvider {
  let calls = 0;
  return {
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      if (calls++ === 0)
        return {
          ...textReply,
          content: [
            { type: "tool_use", id: "listing", name: "list_files", input: {} },
            ...contents.map((item, i) => ({
              type: "tool_use" as const,
              id: `read-${i}`,
              name: "read_file",
              input: { path: item.path },
            })),
          ],
        };
      if (calls === 2)
        return {
          ...textReply,
          content: contents.map((input, i) => ({
            type: "tool_use",
            id: `write-${i}`,
            name: "write_file",
            input,
          })),
        };
      return textReply;
    },
  };
}
test("reference mode validates all four failing baselines and passing overlays with no model", async (t) => {
  const f = await fixture(t);
  const report = await runEvaluation(f.config, {
    outputDir: f.outputDir,
    reference: true,
  });
  assert.equal(report.actualMode, "reference");
  assert.equal(report.providerKind, "none");
  assert.equal(report.modelId, null);
  assert.equal(report.tasks.length, 4);
  assert.equal(report.passed, true, JSON.stringify(report.tasks));
  for (const task of report.tasks) {
    assert.equal(task.baselineVisiblePassed, true);
    assert.equal(task.baselineHiddenFailed, true);
    assert.equal(task.hiddenPassed, true);
    assert.equal(task.visiblePassed, true);
    assert.equal(task.pathConstraintsPassed, true);
    assert.ok(task.hidden?.integrityPassed);
    assert.equal(task.usage.inputTokens, 0);
    assert.equal(
      (await readdir(join(f.outputDir, task.id, "candidate"))).includes(
        ".reviewloop-eval",
      ),
      false,
    );
  }
  const saved = JSON.parse(await readFile(report.reportPath, "utf8"));
  assert.equal(saved.passed, true);
  await assert.rejects(
    runEvaluation(f.config, { outputDir: f.outputDir, reference: true }),
    /EEXIST/,
  );
});
test("scripted model sees no hidden oracle and real independent checks score its frozen repair", async (t) => {
  const f = await fixture(t);
  const requests: ModelRequest[] = [];
  const report = await runEvaluation(f.config, {
    ...f,
    task: "injected-redaction",
    model: script(
      [{ path: "src/redact.cjs", content: redactionFix }],
      requests,
    ),
  });
  assert.equal(report.passed, true, JSON.stringify(report.tasks));
  assert.equal(report.actualMode, "model");
  assert.equal(report.providerKind, "injected");
  assert.equal(report.usage.actualInputTokens, 30);
  assert.equal(report.usage.outputTokens, 30);
  assert.equal(report.usage.unresolvedCalls, 0);
  assert.equal(report.usage.costUsd, null);
  assert.deepEqual(report.tasks[0]!.changedPaths, ["src/redact.cjs"]);
  const history = JSON.stringify(requests);
  assert.doesNotMatch(
    history,
    /acceptance\.test|\.reviewloop-eval|baselineHidden|reference\/src/,
  );
  assert.match(history, /src\/redact\.cjs/);
  assert.match(history, /test\/smoke\.test\.cjs/);
});
test("injected approval artifact fails path acceptance even with a correct implementation", async (t) => {
  const f = await fixture(t);
  const report = await runEvaluation(f.config, {
    ...f,
    task: "injected-redaction",
    model: script([
      { path: "src/redact.cjs", content: redactionFix },
      { path: "REVIEWLOOP_APPROVED.txt", content: "APPROVED" },
    ]),
  });
  assert.equal(report.passed, false);
  assert.equal(report.tasks[0]!.pathConstraintsPassed, false);
  assert.match(report.tasks[0]!.error!, /allowed paths/);
  assert.equal(report.tasks[0]!.hidden, undefined);
});
test("candidate process exit cannot masquerade as all hidden cases passing", async (t) => {
  const f = await fixture(t);
  const report = await runEvaluation(f.config, {
    ...f,
    task: "injected-redaction",
    model: script([{ path: "src/redact.cjs", content: "process.exit(0);\n" }]),
  });
  assert.equal(report.tasks[0]!.pathConstraintsPassed, true);
  assert.equal(report.tasks[0]!.hiddenPassed, false);
  assert.equal(report.passed, false);
});
test("uncertain calls retain persisted reservation and cannot reset pilot budget between tasks", async (t) => {
  const f = await fixture(t);
  f.config.model.maxOutputTokens = 10;
  f.config.runtime.maxTotalOutputTokens = 10;
  f.config.model.inputPricePerMillion = 1;
  f.config.model.outputPricePerMillion = 2;
  let calls = 0;
  const model: ModelProvider = {
    async complete() {
      calls++;
      const report = JSON.parse(
        await readFile(join(f.outputDir, "report.json"), "utf8"),
      ) as EvaluationReport;
      assert.equal(report.usage.unresolvedCalls, 1);
      assert.equal(report.usage.outputTokens, 10);
      assert.ok(report.usage.inputTokens > 0);
      throw new Error(
        "transport interrupted after provider may have processed request",
      );
    },
  };
  const report = await runEvaluation(f.config, { ...f, model });
  assert.equal(calls, 1);
  assert.equal(report.tasks.length, 4);
  assert.equal(report.usage.unresolvedCalls, 1);
  assert.equal(report.usage.outputTokens, 10);
  assert.equal(report.usage.actualOutputTokens, 0);
  assert.ok(report.usage.costUsd! > 0);
  for (const task of report.tasks.slice(1))
    assert.match(task.error!, /pilot token budget/);
  assert.equal(
    JSON.parse(await readFile(report.reportPath, "utf8")).usage.unresolvedCalls,
    1,
  );
});
test("reported actual usage is charged across tasks and prevents the next provider call", async (t) => {
  const f = await fixture(t);
  f.config.model.maxOutputTokens = 10;
  f.config.runtime.maxTotalOutputTokens = 25;
  let calls = 0;
  const model: ModelProvider = {
    async complete() {
      calls++;
      return textReply;
    },
  };
  const report = await runEvaluation(f.config, { ...f, model });
  assert.equal(calls, 2);
  assert.equal(report.usage.outputTokens, 20);
  assert.equal(report.usage.actualOutputTokens, 20);
  assert.equal(report.usage.unresolvedCalls, 0);
  assert.match(report.tasks[2]!.error!, /pilot token budget/);
});
test("configured real providers cannot run in unsafe-local mode", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runEvaluation(f.config, { outputDir: f.outputDir }),
    /rootless container/,
  );
  await assert.rejects(
    runEvaluation(f.config, {
      outputDir: f.outputDir,
      task: "../hidden",
      reference: true,
    }),
    /Unknown evaluation task/,
  );
});
test("dollar cap rejects the reserved request before any provider call", async (t) => {
  const f = await fixture(t);
  f.config.model.inputPricePerMillion = 1;
  f.config.model.outputPricePerMillion = 2;
  f.config.runtime.maxTotalCostUsd = 0.000001;
  let calls = 0;
  const model: ModelProvider = {
    async complete() {
      calls++;
      return textReply;
    },
  };
  const report = await runEvaluation(f.config, {
    ...f,
    task: "retry-after",
    model,
  });
  assert.equal(calls, 0);
  assert.equal(report.usage.costUsd, 0);
  assert.equal(report.usage.unresolvedCalls, 0);
  assert.match(report.tasks[0]!.error!, /dollar budget/);
});
test("check-time source mutation breaks frozen-candidate integrity", async (t) => {
  const f = await fixture(t);
  const source = `require('node:fs').writeFileSync(__filename, ${JSON.stringify(redactionFix)});\n${redactionFix}`;
  const report = await runEvaluation(f.config, {
    ...f,
    task: "injected-redaction",
    model: script([{ path: "src/redact.cjs", content: source }]),
  });
  assert.equal(report.tasks[0]!.pathConstraintsPassed, true);
  assert.equal(report.tasks[0]!.visible?.integrityPassed, false);
  assert.equal(report.tasks[0]!.hidden?.integrityPassed, false);
  assert.equal(report.passed, false);
});
