import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Config,
  Decision,
  Job,
  ModelProvider,
  PullRequest,
  Sandbox,
  Message,
} from "./types.js";
import { Store } from "./store.js";
import { SessionJournal } from "./session.js";
import { Github } from "./github.js";
import { Telegram } from "./telegram.js";
import { GitWorkspaces } from "./git.js";
import { runHarness } from "./harness.js";
import { createModel } from "./model.js";
import { createSandbox } from "./sandbox.js";
import { policyHash } from "./config.js";
import { errorText, redact, sha256 } from "./util.js";
type GithubPort = Pick<
  Github,
  "identity" | "listPullRequests" | "getPullRequest"
>;
type TelegramPort = Pick<Telegram, "send" | "notify" | "poll">;
const unfinished = new Set([
  "queued",
  "running",
  "verifying",
  "awaiting_approval",
  "approved",
]);
export class Controller {
  readonly store: Store;
  readonly github: GithubPort;
  readonly telegram: TelegramPort;
  readonly git: GitWorkspaces;
  readonly model: ModelProvider;
  readonly sandbox: Sandbox;
  private active?: {
    id: string;
    abort: AbortController;
    promise: Promise<void>;
  };
  constructor(
    readonly config: Config,
    deps: {
      store?: Store;
      github?: GithubPort;
      telegram?: TelegramPort;
      git?: GitWorkspaces;
      model?: ModelProvider;
      sandbox?: Sandbox;
      allowUnsafeLocal?: boolean;
    } = {},
  ) {
    this.store = deps.store ?? new Store(config.runtime.stateDir);
    this.github = deps.github ?? new Github(config.github);
    this.telegram = deps.telegram ?? new Telegram(config.telegram);
    this.git = deps.git ?? new GitWorkspaces(config);
    this.model = deps.model ?? createModel(config.model);
    this.sandbox =
      deps.sandbox ??
      createSandbox(config.runtime, deps.allowUnsafeLocal ?? false);
  }
  paused() {
    return this.store.getSetting("paused") === "true";
  }
  summary() {
    const jobs = this.store.jobs();
    return `ReviewLoop ${this.paused() ? "PAUSED" : "active"}\n${jobs.length} jobs; ${jobs.filter((j) => j.status === "awaiting_approval").length} awaiting approval; ${jobs.filter((j) => j.status === "blocked").length} blocked\nEstimated model spend: $${this.store.totalCost().toFixed(4)}${this.config.model.inputPricePerMillion ? "" : " (prices not configured; token accounting only)"}\nLast successful GitHub sync: ${this.store.getSetting("lastSync", "never")}`;
  }
  private journal(job: Job) {
    return new SessionJournal(
      join(this.git.directory(job.id), "agent-session.json"),
      this.git.workspace(job.id),
      sha256(
        JSON.stringify({
          job: job.id,
          head: job.snapshot.headSha,
          policy: policyHash(this.config),
        }),
      ),
    );
  }
  async recover() {
    for (const job of this.store.jobs()) {
      if (["running", "verifying"].includes(job.status)) {
        try {
          if (
            this.store.budget(job).attempts <
              this.config.runtime.maxRepairAttempts &&
            (await this.journal(job).load())
          ) {
            job.status = "queued";
            job.error = undefined;
            this.store.save(job);
            this.store.event("session.recovered", job.id);
            continue;
          }
        } catch (error) {
          this.store.event("session.recovery_rejected", job.id, {
            error: errorText(error),
          });
        }

        job.status = "blocked";
        job.error =
          "Service restarted during execution; saved partial work. Use retry to start clean with remaining budget.";
        this.store.save(job);
        this.notifyJob(job);
      }
      if (job.status === "publishing") {
        try {
          const head = await this.git.remoteHead(job);
          job.status = head === job.candidateSha ? "published" : "blocked";
          job.error =
            job.status === "blocked"
              ? "Interrupted publication: inspect remote before an explicit retry."
              : undefined;
          this.store.save(job);
          this.store.event("publication.recovered", job.id, {
            head,
            status: job.status,
          });
          this.notifyJob(job);
        } catch (e) {
          job.status = "blocked";
          job.error = `Cannot reconcile interrupted publication: ${errorText(e)}`;
          this.store.save(job);
          this.notifyJob(job);
        }
      }
      if (
        job.status === "awaiting_approval" &&
        Date.parse(job.approvalExpiresAt ?? "") <= Date.now()
      ) {
        job.status = "stale";
        job.error = "Approval expired";
        this.store.save(job);
        this.notifyJob(job);
      }
    }
  }
  async sync() {
    const snapshots = await this.github.listPullRequests();
    const available = new Set(snapshots.map((p) => `${p.repo}#${p.number}`));
    this.store.transaction(() => {
      for (const job of this.store.jobs())
        if (
          unfinished.has(job.status) &&
          !available.has(`${job.repo}#${job.pr}`)
        )
          this.stale(job, "PR closed, excluded or no longer eligible");
      for (const snapshot of snapshots) {
        if (this.store.observed(snapshot)) continue;
        for (const job of this.store.jobs())
          if (
            job.repo === snapshot.repo &&
            job.pr === snapshot.number &&
            unfinished.has(job.status)
          )
            this.stale(job, "PR head, base or feedback changed");
        this.store.observe(snapshot);
        // Our own approved push causes a reconciliation refresh, not a repeat repair.
        const ownPush = this.store
          .jobs()
          .find(
            (j) =>
              j.repo === snapshot.repo &&
              j.pr === snapshot.number &&
              j.status === "published" &&
              j.candidateSha === snapshot.headSha &&
              j.snapshot.feedback === snapshot.feedback,
          );
        if (snapshot.feedback.trim() && !ownPush)
          this.store.create(
            snapshot,
            snapshot.feedback,
            policyHash(this.config),
          );
      }
      this.store.setSetting("lastSync", new Date().toISOString());
    });
  }
  private stale(job: Job, reason: string) {
    job.status = "stale";
    job.error = reason;
    job.approvalNonce = undefined;
    this.store.save(job);
    this.store.event("job.stale", job.id, { reason });
    if (this.active?.id === job.id) this.active.abort.abort();
    this.notifyJob(job);
  }
  private notifyJob(job: Job) {
    const tests =
      job.evidence
        ?.map((t) => `${t.exitCode === 0 ? "PASS" : "FAIL"} ${t.command}`)
        .join("\n") || "Checks not completed";
    const text = [
      `PR #${job.pr} · ${job.repo} · ${job.status}`,
      job.snapshot.url,
      `Job: ${job.id}`,
      `Trigger: ${job.feedback.slice(0, 700)}`,
      job.summary ? `Agent summary: ${job.summary.slice(0, 1400)}` : "",
      tests,
      job.error ? `Issue: ${job.error}` : "",
      job.candidateSha ? `Candidate: ${job.candidateSha}` : "",
      `Usage: ${job.inputTokens} input / ${job.outputTokens} output tokens`,
      job.status === "awaiting_approval"
        ? "Next: approve this exact candidate, reject, or reply with revisions. Nothing pushed. Remote CI has not run."
        : job.status === "published"
          ? "Approved candidate pushed. Monitoring continues; merge remains manual."
          : job.status === "blocked"
            ? job.candidateSha
              ? "Next: inspect evidence and the remote branch before retrying; publication may need reconciliation."
              : "Next: inspect evidence, then revise or retry; no push occurred."
            : "",
    ]
      .filter(Boolean)
      .join("\n");
    this.store.enqueue(
      `${job.id}:${job.status}:${job.attempts}:${job.updatedAt}`,
      text,
      job,
      job.status === "awaiting_approval",
    );
  }
  async flushNotifications() {
    for (const item of this.store.outbox()) {
      const job = item.jobId ? this.store.get(item.jobId) : undefined;
      if (item.jobId && (!job || job.status !== item.status)) {
        this.store.delivered(item.id);
        continue;
      }
      try {
        const receipt = job
          ? await this.telegram.send(job, item.text, item.buttons)
          : await this.telegram.notify(item.text);
        this.store.transaction(() => {
          this.store.delivered(item.id);
          if (job) {
            for (const messageId of receipt.messageIds ?? [receipt.messageId])
              this.store.recordMessage(messageId, job.id);
            const latest = this.store.get(job.id);
            if (latest) {
              latest.telegramMessageId = receipt.messageId;
              this.store.save(latest);
            }
          }
          this.store.event("notification.sent", job?.id, {
            messageId: receipt.messageId,
          });
        });
      } catch (e) {
        this.store.failed(item, errorText(e));
        break;
      }
    }
  }
  decide(decision: Decision): string {
    if (this.store.handled(decision.updateId) && decision.updateId >= 0)
      return "Already processed";
    return this.store.transaction(() => {
      const result = this.applyDecision(decision);
      if (decision.updateId >= 0) this.store.markHandled(decision.updateId);
      this.store.event(`owner.${decision.action}`, decision.jobId, { result });
      return result;
    });
  }
  private applyDecision(d: Decision): string {
    if (d.action === "status") return this.summary();
    if (d.action === "pause") {
      this.store.setSetting("paused", "true");
      this.active?.abort.abort();
      return "Paused. No new work or pushes will start.";
    }
    if (d.action === "resume") {
      this.store.setSetting("paused", "false");
      return "Resumed.";
    }
    if (d.action === "remember") {
      const id = this.store.remember(d.text ?? "");
      return `Preference ${id} saved. Preferences cannot override policy or approve pushes.`;
    }
    if (d.action === "forget") {
      const id = Number(d.text);
      if (!Number.isSafeInteger(id) || id < 1)
        throw new Error("Use /forget with a numeric memory ID");
      return this.store.forget(id)
        ? `Preference ${id} forgotten.`
        : "Preference not found.";
    }
    const jobId =
      d.jobId ?? (d.messageId ? this.store.messageJob(d.messageId) : undefined);
    const job = jobId ? this.store.get(jobId) : undefined;
    if (!job)
      throw new Error(
        "Unknown job. Reply to a ReviewLoop notification or use /revise JOB_ID feedback.",
      );
    if (d.messageId && this.store.messageJob(d.messageId) !== job.id)
      throw new Error("Message does not belong to this job");
    if (d.action === "revise") {
      if (!d.text?.trim()) throw new Error("Revision feedback is empty");
      if (["published", "publishing", "rejected", "stale"].includes(job.status))
        throw new Error(
          "This job is no longer revisable; wait for a current PR notification",
        );
      if (this.active?.id === job.id) this.active.abort.abort();
      job.status = "stale";
      job.approvalNonce = undefined;
      this.store.save(job);
      const next = this.store.create(
        job.snapshot,
        `${job.feedback}\n\nOwner revision request:\n${d.text.slice(0, 10000)}`,
        policyHash(this.config),
      );
      // Revisions inherit spending, attempts and context ceilings so chat replies cannot reset a runaway job.
      next.budgetGroup = job.budgetGroup ?? job.id;
      next.previousJobId = job.id;
      this.store.save(next);
      return `Revision queued as ${next.id}. A new approval will be required after testing.`;
    }
    if (job.status !== "awaiting_approval")
      throw new Error(`Job is ${job.status}, not awaiting approval`);
    if (!job.approvalNonce || d.nonce !== job.approvalNonce)
      throw new Error("Invalid or expired approval token");
    if (Date.parse(job.approvalExpiresAt ?? "") <= Date.now())
      throw new Error("Approval expired");
    if (job.policyHash !== policyHash(this.config))
      throw new Error("Configuration changed; rerun before approving");
    if (d.action === "approve") {
      if (this.paused()) throw new Error("ReviewLoop is paused");
      if (
        !job.candidateSha ||
        !job.patchHash ||
        !job.evidence?.length ||
        job.evidence.some((e) => e.exitCode !== 0)
      )
        throw new Error("Candidate has no valid verification evidence");
      job.status = "approved";
      this.store.save(job);
      return "Approval recorded for the exact tested candidate. Publisher will recheck the PR before pushing.";
    }
    job.status = "rejected";
    job.approvalNonce = undefined;
    this.store.save(job);
    this.notifyJob(job);
    return "Rejected. Nothing will be pushed.";
  }
  retry(id: string): string {
    const job = this.store.get(id);
    if (!job || job.status !== "blocked")
      throw new Error("Only a blocked job can be retried");
    if (job.candidateSha)
      throw new Error(
        "Blocked publication requires remote reconciliation; do not blindly retry",
      );
    if (
      this.store.budget(job).attempts >= this.config.runtime.maxRepairAttempts
    )
      throw new Error(
        "Repair attempt limit exhausted. Review limits explicitly before retrying.",
      );
    job.status = "queued";
    job.error = undefined;
    this.store.save(job);
    return "Queued with existing usage and attempt limits.";
  }
  async receive(signal?: AbortSignal) {
    const { decisions, nextOffset } = await this.telegram.poll(
      Number(this.store.getSetting("telegramOffset", "0")),
      signal,
    );
    for (const d of decisions) {
      try {
        const result = this.decide(d);
        this.store.enqueue(`response:${d.updateId}`, result);
      } catch (e) {
        this.store.transaction(() => {
          this.store.markHandled(d.updateId);
          this.store.enqueue(
            `response:${d.updateId}`,
            `Could not apply request: ${errorText(e)}`,
          );
          this.store.event("decision.rejected", d.jobId, {
            error: errorText(e),
          });
        });
      }
    }
    this.store.setSetting("telegramOffset", String(nextOffset));
  }
  async processJob(id: string, signal?: AbortSignal) {
    let job = this.store.get(id);
    if (!job || job.status !== "queued" || this.paused()) return;
    const repo = this.config.github.repositories.find(
      (r) => r.name === job!.repo,
    );
    if (!repo) throw new Error("Repository is not configured");
    const abort = new AbortController();
    const parentAbort = () => abort.abort();
    signal?.addEventListener("abort", parentAbort, { once: true });
    if (signal?.aborted) abort.abort();
    const timeout = setTimeout(
      () => abort.abort(),
      this.config.runtime.maxJobMinutes * 60000,
    );
    let reservation:
      { input: number; output: number; cost: number } | undefined;
    const current = () => {
      const latest = this.store.get(id);
      if (
        !latest ||
        !["running", "verifying"].includes(latest.status) ||
        abort.signal.aborted ||
        this.paused()
      )
        throw new Error("Job stopped or superseded");
      return latest;
    };
    try {
      job.status = "running";
      job.policyHash = policyHash(this.config);
      this.store.save(job);
      const latest = await this.github.getPullRequest(job.repo, job.pr);
      if (
        latest.state !== "open" ||
        latest.fingerprint !== job.snapshot.fingerprint
      )
        throw new Error("PR changed before execution");
      const journal = this.journal(job);
      let history: Message[] | undefined;
      try {
        history = await journal.load();
      } catch (error) {
        this.store.event("session.discarded", id, { error: errorText(error) });
        await journal.discard();
      }
      const workspace = history
        ? this.git.workspace(id)
        : await this.git.prepare(job);
      if (history)
        this.store.event("session.resumed", id, { messages: history.length });
      else if (job.previousJobId) {
        const previous = this.store.get(job.previousJobId);
        if (
          previous?.candidateSha &&
          previous.patchHash &&
          previous.snapshot.headSha === job.snapshot.headSha &&
          previous.policyHash === policyHash(this.config)
        ) {
          await this.git.inheritCandidate(job, previous);
          this.store.event("candidate.inherited", id, {
            previous: previous.id,
            sha: previous.candidateSha,
          });
        }
      }
      const failedVerification = (evidence: Job["evidence"]) =>
        evidence?.some((e) => e.exitCode !== 0)
          ? `Previous verification failed. Correct the implementation, do not weaken tests:\n${evidence
              .filter((e) => e.exitCode !== 0)
              .map((e) => `${e.command}\n${e.output}`)
              .join("\n")
              .slice(0, 20000)}`
          : "";
      let repair = failedVerification(job.evidence);
      for (
        ;
        this.store.budget(job).attempts < this.config.runtime.maxRepairAttempts;
      ) {
        job = current();
        job.attempts++;
        job.status = "running";
        this.store.save(job);
        const result = await runHarness(
          {
            workspace,
            history,
            commandImage: repo.image,
            checkpoint: async (messages) => {
              current();
              await journal.save(messages);
              current();
              history = structuredClone(messages);
              this.store.event("session.checkpoint", id, {
                messages: messages.length,
              });
            },
            task: `PR ${job.snapshot.title}\n${job.feedback}\n${repair}\nRequired verification commands (controller will run independently): ${repo.checks.join("; ")}`,
            preferences: this.store.memories(job.repo).map((m) => m.text),
            priorSummaries: this.store.summaries(job.repo),
            config: this.config,
            signal: abort.signal,
            beforeCall: (input, output) => {
              const j = current();
              const used = this.store.budget(j);
              const total = this.store.totalTokens();
              if (
                total.input + input >
                  (this.config.runtime.maxTotalInputTokens ?? 1500000) ||
                total.output + output >
                  (this.config.runtime.maxTotalOutputTokens ?? 120000)
              )
                throw new Error("Pilot token budget would be exceeded");
              if (
                used.inputTokens + input > this.config.runtime.maxInputTokens ||
                used.outputTokens + output > this.config.runtime.maxOutputTokens
              )
                throw new Error("Token budget reached before model call");
              const cost = this.cost(input, output);
              if (
                this.config.runtime.maxCostUsd &&
                used.costUsd + cost > this.config.runtime.maxCostUsd
              )
                throw new Error("Job dollar budget would be exceeded");
              if (
                this.config.runtime.maxTotalCostUsd &&
                this.store.totalCost() + cost >
                  this.config.runtime.maxTotalCostUsd
              )
                throw new Error("Pilot dollar budget would be exceeded");
              reservation = { input, output, cost };
              j.inputTokens += input;
              j.outputTokens += output;
              j.costUsd += cost;
              this.store.save(j);
              this.store.event("model.reserved", id, { input, output, cost });
            },
            onUsage: (input, output) => {
              const j = this.store.get(id)!;
              j.inputTokens += input - (reservation?.input ?? 0);
              j.outputTokens += output - (reservation?.output ?? 0);
              j.costUsd += this.cost(input, output) - (reservation?.cost ?? 0);
              reservation = undefined;
              this.store.save(j);
              this.store.event("model.usage", id, {
                input,
                output,
                costUsd: j.costUsd,
              });
            },
            onEvent: (event, detail) => this.store.event(event, id, detail),
          },
          this.model,
          this.sandbox,
        );
        job = current();
        job.summary = redact(result.summary);
        job.status = "verifying";
        this.store.save(job);
        const tree = await this.git.fingerprint(job);
        if (!(await this.git.treeChanged(job, tree))) {
          job.status = "no_change";
          job.summary = `No code change needed or produced. ${job.summary}`;
          this.store.save(job);
          this.notifyJob(job);
          return;
        }
        await this.git.assertVerificationPolicy(job);
        const verification = await this.git.verificationWorkspace(job, tree);
        current();
        job.evidence = [];
        for (const check of repo.checks) {
          current();
          const evidence = await this.sandbox.run(verification, check, {
            image: repo.image,
            signal: abort.signal,
            timeoutMs: this.config.runtime.maxJobMinutes * 60000,
          });
          evidence.output = redact(evidence.output);
          job.evidence.push(evidence);
          this.store.event("verification.check", id, {
            command: check,
            exitCode: evidence.exitCode,
            durationMs: evidence.durationMs,
          });
        }
        current();
        if (tree !== (await this.git.fingerprint(job, verification)))
          throw new Error(
            "Verification commands changed tracked files; cannot attest to the tested artifact",
          );
        await writeFile(
          join(this.git.directory(id), "evidence.json"),
          JSON.stringify(job.evidence, null, 2),
          { mode: 0o600 },
        );
        current();
        if (job.evidence.some((e) => e.exitCode !== 0)) {
          repair = failedVerification(job.evidence);
          this.store.save(job);
          continue;
        }
        const frozen = await this.git.candidate(job, tree);
        current();
        const refreshed = await this.github.getPullRequest(job.repo, job.pr);
        if (
          refreshed.fingerprint !== job.snapshot.fingerprint ||
          refreshed.state !== "open"
        )
          throw new Error("PR changed during verification");
        const stillCurrent = current();
        job.inputTokens = stillCurrent.inputTokens;
        job.outputTokens = stillCurrent.outputTokens;
        job.telegramMessageId = stillCurrent.telegramMessageId;
        job.candidateSha = frozen.sha;
        job.patchHash = frozen.patchHash;
        job.summary += `\n${frozen.stat}`;
        job.status = "awaiting_approval";
        job.approvalNonce = randomBytes(8).toString("hex");
        job.approvalExpiresAt = new Date(
          Date.now() + this.config.runtime.approvalHours * 3600000,
        ).toISOString();
        this.store.save(job);
        this.store.event("candidate.ready", id, {
          sha: frozen.sha,
          patchHash: frozen.patchHash,
          files: frozen.files,
        });
        this.notifyJob(job);
        return;
      }
      throw new Error("Fix-and-test attempt limit reached");
    } catch (e) {
      job = this.store.get(id);
      if (job && !["stale", "rejected"].includes(job.status)) {
        job.status = "blocked";
        job.error = errorText(e);
        this.store.save(job);
        this.store.event("job.blocked", id, { error: job.error });
        this.notifyJob(job);
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", parentAbort);
    }
  }
  private cost(input: number, output: number) {
    return (
      (input * (this.config.model.inputPricePerMillion ?? 0) +
        output * (this.config.model.outputPricePerMillion ?? 0)) /
      1_000_000
    );
  }
  async publishApproved(signal?: AbortSignal) {
    if (this.paused() || signal?.aborted) return;
    for (const job of this.store
      .jobs()
      .filter((j) => j.status === "approved")) {
      try {
        if (
          job.policyHash !== policyHash(this.config) ||
          Date.parse(job.approvalExpiresAt ?? "") <= Date.now()
        )
          throw new Error("Approval expired or policy changed");
        const latest = await this.github.getPullRequest(job.repo, job.pr);
        if (
          latest.fingerprint !== job.snapshot.fingerprint ||
          latest.state !== "open"
        ) {
          this.stale(job, "PR changed after approval");
          continue;
        }
        if (this.paused()) return;
        await this.git.verifyCandidate(job);
        if (
          this.paused() ||
          signal?.aborted ||
          this.store.get(job.id)?.status !== "approved"
        )
          throw new Error("Approval revoked or service paused");
        job.status = "publishing";
        this.store.save(job);
        this.store.event("publication.started", job.id, {
          sha: job.candidateSha,
        });
        await this.git.publish(job, () => {
          if (
            this.paused() ||
            signal?.aborted ||
            this.store.get(job.id)?.status !== "publishing"
          )
            throw new Error("Publication canceled before dispatch");
        });
        job.status = "published";
        job.approvalNonce = undefined;
        this.store.save(job);
        this.store.event("publication.completed", job.id, {
          sha: job.candidateSha,
        });
        this.notifyJob(job);
      } catch (e) {
        const latestState = this.store.get(job.id);
        if (latestState && ["stale", "rejected"].includes(latestState.status))
          continue;
        job.status = "blocked";
        job.error = `Publication stopped: ${errorText(e)}`;
        this.store.save(job);
        this.store.event("publication.failed", job.id, { error: job.error });
        this.notifyJob(job);
      }
    }
  }
  startQueued() {
    if (this.active || this.paused()) return;
    const job = this.store.jobs().find((j) => j.status === "queued");
    if (!job) return;
    const abort = new AbortController();
    const promise = this.processJob(job.id, abort.signal)
      .catch((e) =>
        this.store.event("worker.error", job.id, { error: errorText(e) }),
      )
      .finally(() => {
        this.active = undefined;
      });
    this.active = { id: job.id, abort, promise };
  }
  async stop() {
    this.active?.abort.abort();
    await this.active?.promise;
  }
  async run(signal: AbortSignal, once = false) {
    if (signal.aborted) return;
    await this.github.identity();
    if (signal.aborted) return;
    await this.recover();
    let lastSync = 0;
    do {
      if (signal.aborted) break;
      if (this.paused()) this.active?.abort.abort();
      if (Date.now() - lastSync > this.config.github.pollSeconds * 1000) {
        try {
          await this.sync();
          lastSync = Date.now();
        } catch (e) {
          this.store.event("github.sync_failed", undefined, {
            error: errorText(e),
          });
          lastSync = Date.now();
        }
      }
      // Never publish/run based on indefinitely stale repository discovery.
      const fresh =
        Date.now() -
          Date.parse(this.store.getSetting("lastSync", "1970-01-01")) <
        Math.max(120000, this.config.github.pollSeconds * 3000);
      if (fresh && !signal.aborted) {
        await this.publishApproved(signal);
        if (!signal.aborted) this.startQueued();
      }
      await this.flushNotifications();
      if (once) {
        await this.active?.promise;
        await this.flushNotifications();
        break;
      }
      try {
        await this.receive(signal);
      } catch (e) {
        if (signal.aborted) break;
        this.store.event("telegram.poll_failed", undefined, {
          error: errorText(e),
        });
        await new Promise((r) => setTimeout(r, 3000));
      }
    } while (!signal.aborted);
    await this.stop();
  }
}
