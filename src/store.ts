import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Job, JobStatus, PullRequest } from "./types.js";
import { redact } from "./util.js";
export interface Outbox {
  id: number;
  jobId?: string;
  text: string;
  buttons: boolean;
  status?: JobStatus;
  attempts: number;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, "reviewloop.sqlite"));
    chmodSync(join(directory, "reviewloop.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_pr ON jobs(repo,pr,status);
      CREATE TABLE IF NOT EXISTS observations(repo TEXT, pr INTEGER, fingerprint TEXT NOT NULL, PRIMARY KEY(repo,pr));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, repo TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, job_id TEXT, event TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, dedup TEXT UNIQUE NOT NULL, data TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS telegram_updates(id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS telegram_messages(message_id INTEGER PRIMARY KEY, job_id TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  getSetting(key: string, fallback = ""): string {
    return (
      (
        this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
          { value: string } | undefined
      )?.value ?? fallback
    );
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Job) : undefined;
  }
  jobs(): Job[] {
    return (
      this.db.prepare("SELECT data FROM jobs ORDER BY rowid").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as Job);
  }
  save(job: Job) {
    job.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO jobs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      )
      .run(job.id, job.repo, job.pr, job.status, JSON.stringify(job));
  }
  create(
    snapshot: PullRequest,
    feedback = snapshot.feedback,
    policyHash?: string,
  ): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomBytes(8).toString("hex"),
      repo: snapshot.repo,
      pr: snapshot.number,
      snapshot,
      status: "queued",
      feedback,
      createdAt: now,
      updatedAt: now,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      attempts: 0,
      policyHash,
    };
    this.save(job);
    this.event("job.queued", job.id, {
      repo: job.repo,
      pr: job.pr,
      head: snapshot.headSha,
    });
    return job;
  }
  observed(snapshot: PullRequest): boolean {
    return (
      (
        this.db
          .prepare("SELECT fingerprint FROM observations WHERE repo=? AND pr=?")
          .get(snapshot.repo, snapshot.number) as
          { fingerprint: string } | undefined
      )?.fingerprint === snapshot.fingerprint
    );
  }
  observe(snapshot: PullRequest) {
    this.db
      .prepare(
        "INSERT INTO observations VALUES (?,?,?) ON CONFLICT(repo,pr) DO UPDATE SET fingerprint=excluded.fingerprint",
      )
      .run(snapshot.repo, snapshot.number, snapshot.fingerprint);
  }
  event(
    event: string,
    jobId: string | undefined,
    detail: Record<string, unknown> = {},
  ) {
    this.db
      .prepare("INSERT INTO audit(at,job_id,event,detail) VALUES (?,?,?,?)")
      .run(
        new Date().toISOString(),
        jobId ?? null,
        event,
        redact(JSON.stringify(detail)).slice(0, 20000),
      );
  }
  events(jobId?: string) {
    return jobId
      ? this.db
          .prepare(
            "SELECT * FROM audit WHERE job_id=? ORDER BY id DESC LIMIT 100",
          )
          .all(jobId)
      : this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all();
  }
  remember(text: string, repo?: string): number {
    const clean = redact(text.trim());
    if (!clean || clean.length > 4000)
      throw new Error("Preferences must be 1–4000 characters");
    const result = this.db
      .prepare("INSERT INTO memories(repo,text,created_at) VALUES (?,?,?)")
      .run(repo ?? null, clean, new Date().toISOString());
    this.event("memory.created", undefined, {
      id: Number(result.lastInsertRowid),
      repo: repo ?? "global",
    });
    return Number(result.lastInsertRowid);
  }
  memories(
    repo?: string,
  ): { id: number; repo: string | null; text: string; created_at: string }[] {
    return (
      repo
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE repo IS NULL OR repo=? ORDER BY id",
            )
            .all(repo)
        : this.db.prepare("SELECT * FROM memories ORDER BY id").all()
    ) as {
      id: number;
      repo: string | null;
      text: string;
      created_at: string;
    }[];
  }
  forget(id: number): boolean {
    const deleted =
      this.db.prepare("DELETE FROM memories WHERE id=?").run(id).changes > 0;
    this.event("memory.deleted", undefined, { id, deleted });
    return deleted;
  }
  summaries(repo: string): string[] {
    return this.jobs()
      .filter((j) => j.repo === repo && j.status === "published" && j.summary)
      .slice(-5)
      .map((j) => `PR #${j.pr}: ${j.summary!.slice(0, 2000)}`);
  }
  budget(job: Job) {
    return this.jobs()
      .filter((j) => (j.budgetGroup ?? j.id) === (job.budgetGroup ?? job.id))
      .reduce(
        (t, j) => ({
          inputTokens: t.inputTokens + j.inputTokens,
          outputTokens: t.outputTokens + j.outputTokens,
          costUsd: t.costUsd + j.costUsd,
          attempts: t.attempts + j.attempts,
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: 0, attempts: 0 },
      );
  }
  totalTokens() {
    return this.jobs().reduce(
      (t, j) => ({
        input: t.input + j.inputTokens,
        output: t.output + j.outputTokens,
      }),
      { input: 0, output: 0 },
    );
  }
  totalCost(): number {
    return this.jobs().reduce((sum, j) => sum + j.costUsd, 0);
  }
  enqueue(dedup: string, text: string, job?: Job, buttons = false) {
    const data: Omit<Outbox, "id"> = {
      jobId: job?.id,
      text: redact(text),
      buttons,
      status: job?.status,
      attempts: 0,
    };
    this.db
      .prepare("INSERT OR IGNORE INTO outbox(dedup,data) VALUES (?,?)")
      .run(dedup, JSON.stringify(data));
  }
  outbox(): Outbox[] {
    return (
      this.db
        .prepare(
          "SELECT id,data FROM outbox WHERE delivered=0 ORDER BY id LIMIT 20",
        )
        .all() as { id: number; data: string }[]
    ).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  }
  delivered(id: number) {
    this.db.prepare("UPDATE outbox SET delivered=1 WHERE id=?").run(id);
  }
  failed(item: Outbox, error: string) {
    item.attempts++;
    this.db
      .prepare("UPDATE outbox SET data=? WHERE id=?")
      .run(JSON.stringify(item), item.id);
    this.event("notification.failed", item.jobId, {
      error,
      attempts: item.attempts,
    });
  }
  recordMessage(messageId: number, jobId: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO telegram_messages VALUES (?,?)")
      .run(messageId, jobId);
  }
  messageJob(messageId: number): string | undefined {
    return (
      this.db
        .prepare("SELECT job_id FROM telegram_messages WHERE message_id=?")
        .get(messageId) as { job_id: string } | undefined
    )?.job_id;
  }
  handled(updateId: number): boolean {
    return !!this.db
      .prepare("SELECT id FROM telegram_updates WHERE id=?")
      .get(updateId);
  }
  markHandled(updateId: number) {
    this.db
      .prepare("INSERT OR IGNORE INTO telegram_updates VALUES (?)")
      .run(updateId);
  }
}
