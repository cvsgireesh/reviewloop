import {
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  lstat,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute, matchesGlob } from "node:path";
import type { Config, Job } from "./types.js";
import { command, safeEnv, sha256 } from "./util.js";
export interface Candidate {
  sha: string;
  patchHash: string;
  stat: string;
  files: string[];
}
export class GitWorkspaces {
  constructor(
    readonly config: Config,
    private remoteOverride?: (repo: string) => string,
  ) {}
  directory(id: string) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid job ID");
    return join(this.config.runtime.stateDir, "jobs", id);
  }
  workspace(id: string) {
    return join(this.directory(id), "work");
  }
  private remote(repo: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
    if (this.remoteOverride) return this.remoteOverride(repo);
    const api = new URL(this.config.github.apiUrl);
    const origin =
      api.hostname === "api.github.com" ? "https://github.com" : api.origin;
    return `${origin}/${repo}.git`;
  }
  private env(auth = false): NodeJS.ProcessEnv {
    const env = safeEnv();
    if (auth) {
      const token = process.env[this.config.github.tokenEnv];
      if (token) {
        const api = new URL(this.config.github.apiUrl);
        const origin =
          api.hostname === "api.github.com" ? "https://github.com" : api.origin;
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
        env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      }
    }
    return env;
  }
  private async git(
    id: string,
    args: string[],
    auth = false,
    timeoutMs = 120000,
  ) {
    const result = await command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        `protocol.file.allow=${this.remoteOverride ? "always" : "never"}`,
        "--git-dir",
        join(this.directory(id), "source", ".git"),
        "--work-tree",
        this.workspace(id),
        ...args,
      ],
      {
        env: this.env(auth),
        timeoutMs,
        maxBytes: Math.max(this.config.runtime.maxPatchBytes * 3, 2_000_000),
      },
    );
    if (result.code !== 0)
      throw new Error(`Git ${args[0]} failed: ${result.stderr.slice(0, 2000)}`);
    return result.stdout.trimEnd();
  }
  async prepare(job: Job) {
    if (!/^[a-f0-9]{40,64}$/.test(job.snapshot.headSha))
      throw new Error("Invalid head SHA");
    const dir = this.directory(job.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await rm(join(dir, "work"), { recursive: true, force: true });
    await rm(join(dir, "source"), { recursive: true, force: true });
    await mkdir(join(dir, "work"), { mode: 0o700 });
    await mkdir(join(dir, "source"), { mode: 0o700 });
    const init = await command("git", ["init", "--quiet", join(dir, "source")]);
    if (init.code !== 0) throw new Error("Git init failed");
    // Fetch the exact fork/head repository SHA. Credentials never enter the mounted work directory.
    await this.git(
      job.id,
      [
        "fetch",
        "--no-tags",
        "--depth=1",
        this.remote(job.snapshot.headRepo),
        job.snapshot.headSha,
      ],
      true,
    );
    const fetched = await this.git(job.id, ["rev-parse", "FETCH_HEAD"]);
    if (fetched !== job.snapshot.headSha)
      throw new Error("Fetched head does not match frozen PR");
    await this.git(job.id, ["update-ref", "HEAD", fetched]);
    await this.git(job.id, ["read-tree", "HEAD"]);
    const tree = await this.git(job.id, ["ls-tree", "-rz", "HEAD"]);
    for (const entry of tree.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t");
      if (!path) throw new Error("Invalid Git tree entry");
      if (metadata?.startsWith("120000") || metadata?.startsWith("160000"))
        throw new Error(
          "MVP cannot safely materialize symlinks or submodules; use a prepared repository without them",
        );
      if (
        isAbsolute(path) ||
        path.split("/").some((p) => p === ".." || p === ".git")
      )
        throw new Error("Unsafe repository path");
    }
    await this.git(job.id, [
      "checkout-index",
      "--all",
      `--prefix=${this.workspace(job.id)}/`,
    ]);
    await writeFile(
      join(dir, "snapshot.json"),
      JSON.stringify(job.snapshot, null, 2),
      { mode: 0o600 },
    );
    return this.workspace(job.id);
  }
  private async inspectTree(root: string, path = root): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const p = join(path, entry.name);
      const rel = relative(root, p);
      if (entry.isSymbolicLink())
        throw new Error(`Symlink candidates are not allowed: ${rel}`);
      if (entry.name === ".git")
        throw new Error("Agent attempted to create Git metadata");
      if (entry.isDirectory()) await this.inspectTree(root, p);
      else if (!entry.isFile())
        throw new Error(`Special file not allowed: ${rel}`);
    }
  }
  async fingerprint(job: Job, workspace = this.workspace(job.id)) {
    await this.inspectTree(workspace);
    await this.git(job.id, [
      `--work-tree=${workspace}`,
      "add",
      "--all",
      "--",
      ".",
    ]);
    return await this.git(job.id, ["write-tree"]);
  }
  async verificationWorkspace(job: Job, tree: string) {
    const path = join(this.directory(job.id), "verification");
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { mode: 0o700 });
    await this.git(job.id, ["read-tree", tree]);
    await this.git(job.id, ["checkout-index", "--all", `--prefix=${path}/`]);
    return path;
  }
  async treeChanged(job: Job, tree: string) {
    return tree !== (await this.git(job.id, ["rev-parse", "HEAD^{tree}"]));
  }
  async assertVerificationPolicy(job: Job) {
    const files = (
      await this.git(job.id, [
        "diff",
        "--cached",
        "--diff-filter=MDTR",
        "--name-only",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const extra =
      this.config.github.repositories.find((r) => r.name === job.repo)
        ?.protectedPaths ?? [];
    const protectedFile = (f: string) =>
      /(^|\/)(package\.json|pyproject\.toml|pytest\.ini|tox\.ini|setup\.cfg|Makefile|justfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|conftest\.py)$/.test(
        f,
      ) ||
      /(^|\/)(tests?|__tests__|specs?|\.github)\//.test(f) ||
      /(^|\/)(test_[^/]*|tests?\.[^/]+|specs?\.[^/]+)$|[._](test|spec)\.[^/]+$/.test(
        f,
      ) ||
      extra.some((pattern) => matchesGlob(f, pattern));
    const changed = files.filter(protectedFile);
    if (changed.length)
      throw new Error(
        `Verification policy blocks editing existing test definitions or protected paths: ${changed.join(", ")}. Configure an external trusted check before handling these changes manually.`,
      );
  }
  async candidate(job: Job, verifiedTree: string): Promise<Candidate> {
    const tree = await this.fingerprint(job);
    if (tree !== verifiedTree)
      throw new Error(
        "Workspace changed after verification; candidate rejected",
      );
    await this.assertVerificationPolicy(job);
    const original = await this.git(job.id, ["rev-parse", "HEAD^{tree}"]);
    if (tree === original) throw new Error("No code changes produced");
    const files = (
      await this.git(job.id, ["diff", "--cached", "--name-only", "-z"])
    )
      .split("\0")
      .filter(Boolean);
    if (files.length > this.config.runtime.maxChangedFiles)
      throw new Error("Changed-file limit exceeded");
    if (
      files.some((f) =>
        /(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials|reviewloop\.json)$/.test(
          f,
        ),
      )
    )
      throw new Error(
        "Candidate includes a protected configuration/credential filename",
      );
    const patch = await this.git(job.id, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
    ]);
    if (Buffer.byteLength(patch) > this.config.runtime.maxPatchBytes)
      throw new Error("Patch size limit exceeded");
    await this.git(job.id, [
      "-c",
      "user.name=ReviewLoop",
      "-c",
      "user.email=reviewloop@localhost",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      `fix: address review feedback for PR #${job.pr}`,
    ]);
    const sha = await this.git(job.id, ["rev-parse", "HEAD"]);
    const patchHash = sha256(patch);
    await writeFile(join(this.directory(job.id), "candidate.patch"), patch, {
      mode: 0o600,
    });
    const stat = await this.git(job.id, [
      "show",
      "--stat",
      "--oneline",
      "HEAD",
    ]);
    await writeFile(
      join(this.directory(job.id), "candidate.json"),
      JSON.stringify({ sha, patchHash, files, verifiedTree }, null, 2),
      { mode: 0o600 },
    );
    return { sha, patchHash, stat, files };
  }
  async verifyCandidate(job: Job) {
    if (!job.candidateSha || !job.patchHash)
      throw new Error("Missing frozen candidate");
    const sha = await this.git(job.id, ["rev-parse", "HEAD"]);
    if (sha !== job.candidateSha) throw new Error("Candidate commit changed");
    const patch = await readFile(
      join(this.directory(job.id), "candidate.patch"),
    );
    const actual = await this.git(job.id, [
      "diff",
      `${job.snapshot.headSha}..${job.candidateSha}`,
      "--binary",
      "--no-ext-diff",
    ]);
    if (sha256(patch) !== job.patchHash || sha256(actual) !== job.patchHash)
      throw new Error("Candidate evidence hash changed");
    await this.git(job.id, [
      "merge-base",
      "--is-ancestor",
      job.snapshot.headSha,
      job.candidateSha,
    ]);
  }
  async remoteHead(job: Job): Promise<string> {
    const branch = job.snapshot.headRef;
    const check = await command("git", [
      "check-ref-format",
      `refs/heads/${branch}`,
    ]);
    if (check.code !== 0 || branch.startsWith("-"))
      throw new Error("Invalid source branch");
    const text = await this.git(
      job.id,
      ["ls-remote", this.remote(job.snapshot.headRepo), `refs/heads/${branch}`],
      true,
    );
    return text.split(/\s+/)[0] ?? "";
  }
  async publish(job: Job, guard: () => void = () => {}) {
    await this.verifyCandidate(job);
    if ((await this.remoteHead(job)) !== job.snapshot.headSha)
      throw new Error("Remote head moved; approval is stale");
    const ref = `refs/heads/${job.snapshot.headRef}`;
    guard();
    await this.git(
      job.id,
      [
        "push",
        "--porcelain",
        `--force-with-lease=${ref}:${job.snapshot.headSha}`,
        this.remote(job.snapshot.headRepo),
        `${job.candidateSha}:${ref}`,
      ],
      true,
    );
    if ((await this.remoteHead(job)) !== job.candidateSha)
      throw new Error(
        "Push outcome uncertain; remote head does not match candidate",
      );
  }
}
