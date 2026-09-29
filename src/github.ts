import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { Config, PullRequest, RepositoryConfig } from "./types.js";

type Client = Pick<Octokit, "request" | "paginate">;
type Feedback = {
  kind: string;
  id: number;
  authorId: number | null;
  author: string;
  body: string;
  updatedAt: string | null;
  state?: string;
  path?: string;
  line?: number | null;
  commitId?: string | null;
};

/** Read-only discovery. API failures invalidate the whole snapshot; never interpret them as no feedback. */
export class Github {
  private client: Client;
  constructor(
    private config: Config["github"],
    client?: Client,
  ) {
    const token = process.env[config.tokenEnv];
    if (!client && !token)
      throw new Error(
        `Missing GitHub token environment variable ${config.tokenEnv}`,
      );
    this.client =
      client ??
      new Octokit({
        auth: token,
        baseUrl: config.apiUrl,
        request: { timeout: 30_000 },
      });
  }
  async identity(): Promise<{ login: string; id: number }> {
    const { data } = await this.client.request("GET /user");
    if (data.login.toLowerCase() !== this.config.username.toLowerCase())
      throw new Error(
        "Authenticated GitHub identity does not match configured username",
      );
    const id = Number(data.id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error("GitHub identity ID is not a safe positive integer");
    return { login: data.login, id };
  }
  private async repository(repo: string) {
    if (
      !this.config.repositories.some(
        (r) => r.name.toLowerCase() === repo.toLowerCase(),
      )
    )
      throw new Error(`Repository is not configured: ${repo}`);
    const [owner, name, extra] = repo.split("/");
    if (!owner || !name || extra) throw new Error("Invalid repository name");
    const { data } = await this.client.request("GET /repos/{owner}/{repo}", {
      owner,
      repo: name,
    });
    if (!data.permissions?.admin && !data.permissions?.maintain)
      throw new Error(
        `Admin or maintain repository permission required: ${repo}`,
      );
    return { owner, repo: name };
  }
  private included(
    scope: RepositoryConfig,
    number: number,
    user: { id: number | bigint; login?: string } | null | undefined,
    identityId: number,
  ): boolean {
    if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0)
      return false;
    if (scope.pullRequests && !scope.pullRequests.includes(number))
      return false;
    return scope.authors
      ? !!user?.login &&
          scope.authors.some(
            (login) => login.toLowerCase() === user.login!.toLowerCase(),
          )
      : Number(user.id) === identityId;
  }
  async listPullRequests(): Promise<PullRequest[]> {
    const identity = await this.identity();
    const snapshots: PullRequest[] = [];
    for (const configured of this.config.repositories) {
      const params = await this.repository(configured.name);
      const prs = await this.client.paginate(
        "GET /repos/{owner}/{repo}/pulls",
        { ...params, state: "open", per_page: 100 },
      );
      for (const pr of prs)
        if (this.included(configured, pr.number, pr.user, identity.id))
          snapshots.push(
            await this.snapshot(configured.name, pr.number, params, identity),
          );
    }
    return snapshots;
  }
  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const identity = await this.identity();
    return this.snapshot(repo, number, await this.repository(repo), identity);
  }
  private async snapshot(
    repo: string,
    number: number,
    params: { owner: string; repo: string },
    identity: { id: number; login: string },
  ): Promise<PullRequest> {
    const readHead = () =>
      this.client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...params,
        pull_number: number,
      });
    const { data: pr } = await readHead();
    const scope = this.config.repositories.find(
      (r) => r.name.toLowerCase() === repo.toLowerCase(),
    );
    if (!scope || !this.included(scope, number, pr.user, identity.id))
      throw new Error(
        `PR excluded by configured author or PR-number scope: ${repo}#${number}`,
      );
    const [comments, inline, reviews] = await Promise.all([
      this.client.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...params, issue_number: number, per_page: 100 },
      ),
      this.client.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        { ...params, pull_number: number, per_page: 100 },
      ),
      this.client.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { ...params, pull_number: number, per_page: 100 },
      ),
    ]);
    const feedback: Feedback[] = [];
    const ownMarker = (authorId: number | null, body: string) =>
      authorId === identity.id && /<!--\s*reviewloop:/i.test(body);
    for (const c of comments)
      if (c.body?.trim() && !ownMarker(c.user?.id ?? null, c.body))
        feedback.push({
          kind: "comment",
          id: c.id,
          authorId: c.user?.id ?? null,
          author: c.user?.login ?? "[deleted]",
          body: c.body,
          updatedAt: c.updated_at,
        });
    for (const c of inline)
      if (c.body?.trim() && !ownMarker(c.user?.id ?? null, c.body))
        feedback.push({
          kind: "inline",
          id: c.id,
          authorId: c.user?.id ?? null,
          author: c.user?.login ?? "[deleted]",
          body: c.body,
          updatedAt: c.updated_at,
          path: c.path,
          line: c.line ?? c.original_line,
          commitId: c.commit_id,
        });
    for (const r of reviews)
      if (
        r.submitted_at &&
        !ownMarker(r.user?.id ?? null, r.body ?? "") &&
        (r.body?.trim() ||
          r.state === "APPROVED" ||
          r.state === "CHANGES_REQUESTED" ||
          r.state === "DISMISSED")
      )
        feedback.push({
          kind: "review",
          id: r.id,
          authorId: r.user?.id ?? null,
          author: r.user?.login ?? "[deleted]",
          body: r.body ?? "",
          updatedAt: r.submitted_at,
          state: r.state,
          commitId: r.commit_id,
        });
    feedback.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
    const { data: after } = await readHead();
    if (
      pr.head.sha !== after.head.sha ||
      pr.base.sha !== after.base.sha ||
      pr.state !== after.state ||
      pr.merged !== after.merged
    )
      throw new Error(`PR changed during snapshot: ${repo}#${number}`);
    const serialized = JSON.stringify(feedback);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          head: pr.head.sha,
          base: pr.base.sha,
          state: pr.merged ? "closed" : pr.state,
          feedback,
        }),
      )
      .digest("hex");
    const bounded =
      serialized.length > 200_000
        ? `${serialized.slice(0, 200_000)}\n[FEEDBACK TRUNCATED at 200000 characters; fingerprint covers complete feedback]`
        : serialized;
    return {
      repo,
      number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
      authorId: Number(pr.user.id),
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headRepo: pr.head.repo?.full_name ?? "",
      state: pr.merged ? "closed" : pr.state,
      feedback: feedback.length ? bounded : "",
      fingerprint,
    };
  }
}
