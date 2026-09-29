import test from "node:test";
import assert from "node:assert/strict";
import { Github } from "../src/github.js";
import { configSchema, exampleConfig } from "../src/config.js";
import type { RepositoryConfig } from "../src/types.js";
const config = {
  apiUrl: "https://api.github.com",
  tokenEnv: "UNUSED",
  username: "owner",
  repositories: [{ name: "owner/repo", checks: [] }],
  pollSeconds: 60,
};
function fixture(scope: Partial<RepositoryConfig> = {}) {
  const pr = {
    number: 1,
    title: "Fix",
    html_url: "https://github.com/owner/repo/pull/1",
    user: { login: "owner", id: 42 },
    head: { sha: "head", ref: "feature", repo: { full_name: "owner/repo" } },
    base: { sha: "base" },
    state: "open",
    merged: false,
  };
  const data = {
    comments: [] as any[],
    inline: [] as any[],
    reviews: [] as any[],
    permissions: { admin: true, maintain: false },
    login: "owner",
    failed: false,
  };
  const client = {
    request: async (route: string) => {
      if (route === "GET /user") return { data: { login: data.login, id: 42 } };
      if (route.endsWith("/pulls/{pull_number}"))
        return { data: structuredClone(pr) };
      return { data: { permissions: data.permissions } };
    },
    paginate: async (route: string) => {
      if (data.failed) throw new Error("rate limited or partial page failure");
      if (route.endsWith("/pulls"))
        return [pr, { ...pr, number: 2, user: { id: 99 } }];
      if (route.endsWith("/reviews")) return data.reviews;
      if (route.includes("/issues/")) return data.comments;
      return data.inline;
    },
  };
  return {
    api: new Github(
      { ...config, repositories: [{ ...config.repositories[0]!, ...scope }] },
      client as any,
    ),
    pr,
    data,
  };
}
test("empty feedback does not trigger initial work and own immutable identity filters PR list", async () => {
  const { api } = fixture();
  const prs = await api.listPullRequests();
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.feedback, "");
});
test("full semantic feedback is deterministic and changes with edit, review state, head or base", async () => {
  const { api, data, pr } = fixture();
  data.comments = [
    {
      id: 2,
      body: "two",
      updated_at: "now",
      user: { id: 5, login: "bot[bot]" },
    },
    { id: 1, body: "one", updated_at: "then", user: { id: 6, login: "human" } },
  ];
  data.reviews = [
    {
      id: 3,
      body: "",
      state: "CHANGES_REQUESTED",
      submitted_at: "today",
      commit_id: "head",
      user: { id: 7, login: "reviewer" },
    },
  ];
  const first = await api.getPullRequest("owner/repo", 1);
  assert.match(first.feedback, /bot\[bot\]/);
  data.comments.reverse();
  assert.equal(
    (await api.getPullRequest("owner/repo", 1)).fingerprint,
    first.fingerprint,
  );
  data.comments[0].body = "edited";
  const edited = await api.getPullRequest("owner/repo", 1);
  assert.notEqual(edited.fingerprint, first.fingerprint);
  data.reviews[0].state = "DISMISSED";
  const dismissed = await api.getPullRequest("owner/repo", 1);
  assert.notEqual(dismissed.fingerprint, edited.fingerprint);
  pr.base.sha = "new-base";
  assert.notEqual(
    (await api.getPullRequest("owner/repo", 1)).fingerprint,
    dismissed.fingerprint,
  );
  pr.merged = true;
  assert.equal((await api.getPullRequest("owner/repo", 1)).state, "closed");
});
test("identity, scope, repository control and page failures fail closed", async () => {
  const { api, data } = fixture();
  await assert.rejects(
    api.getPullRequest("elsewhere/repo", 1),
    /not configured/,
  );
  data.login = "wrong";
  await assert.rejects(api.identity(), /identity/);
  data.login = "owner";
  data.permissions.admin = false;
  await assert.rejects(api.listPullRequests(), /Admin or maintain/);
  data.permissions.maintain = true;
  data.failed = true;
  await assert.rejects(api.listPullRequests(), /partial page/);
});
test("only authenticated own ReviewLoop markers are excluded, not other bots or users", async () => {
  const { api, data } = fixture();
  data.comments = [42, 77].map((id) => ({
    id,
    body: "<!-- reviewloop: marker --> hello",
    updated_at: "now",
    user: { id, login: String(id) },
  }));
  const snapshot = await api.getPullRequest("owner/repo", 1);
  const feedback = JSON.parse(snapshot.feedback);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].id, 77);
});
test("default author scope uses immutable identity even when the login matches", async () => {
  const { api, pr } = fixture();
  pr.user.id = 77;
  assert.deepEqual(await api.listPullRequests(), []);
  await assert.rejects(api.getPullRequest("owner/repo", 1), /excluded/);
});
test("explicit author scope allows selected collaborators case-insensitively without bypassing controller identity", async () => {
  const { api, pr, data } = fixture({ authors: ["COLLABORATOR"] });
  pr.user = { id: 77, login: "collaborator" };
  const prs = await api.listPullRequests();
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.authorId, 77);
  assert.equal(
    (await api.getPullRequest("owner/repo", 1)).author,
    "collaborator",
  );
  pr.user.login = "outsider";
  assert.deepEqual(await api.listPullRequests(), []);
  await assert.rejects(api.getPullRequest("owner/repo", 1), /excluded/);
  data.login = "collaborator";
  await assert.rejects(api.listPullRequests(), /identity/);
});
test("PR number scope restricts both discovery and direct snapshots and combines with author scope", async () => {
  const excluded = fixture({ pullRequests: [2] });
  assert.deepEqual(await excluded.api.listPullRequests(), []);
  await assert.rejects(
    excluded.api.getPullRequest("owner/repo", 1),
    /excluded/,
  );
  const allowed = fixture({ authors: ["collaborator"], pullRequests: [1] });
  allowed.pr.user = { id: 77, login: "collaborator" };
  assert.equal((await allowed.api.listPullRequests()).length, 1);
  assert.equal((await allowed.api.getPullRequest("owner/repo", 1)).number, 1);
  await assert.rejects(allowed.api.getPullRequest("owner/repo", 2), /excluded/);
});
test("scope configuration accepts optional nonempty authors and positive PR numbers only", () => {
  const value = exampleConfig();
  const repo = value.github.repositories[0]!;
  assert.equal(configSchema.safeParse(value).success, true);
  repo.authors = ["owner", "collaborator"];
  repo.pullRequests = [1, 23];
  assert.equal(configSchema.safeParse(value).success, true);
  repo.authors = [];
  assert.equal(configSchema.safeParse(value).success, false);
  repo.authors = ["   "];
  assert.equal(configSchema.safeParse(value).success, false);
  repo.authors = ["owner"];
  for (const numbers of [[], [0], [-1], [1.5]]) {
    repo.pullRequests = numbers;
    assert.equal(configSchema.safeParse(value).success, false);
  }
});
