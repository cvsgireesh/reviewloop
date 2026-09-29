import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  symlink,
  link,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionJournal,
  validateHistory,
  workspaceDigest,
} from "../src/session.js";
import type { Message } from "../src/types.js";
const history: Message[] = [
  { role: "user", content: [{ type: "text", text: "Fix" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "one",
        name: "write_file",
        input: { path: "value", content: "done" },
      },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "one", content: "done" }],
  },
];
test("journal roundtrip is private, missing safe, scope and ignored workspace changes invalidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reviewloop-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work"),
    file = join(root, "state", "session.json");
  await mkdir(work);
  await writeFile(join(work, ".gitignore"), "ignored\n");
  await writeFile(join(work, "ignored"), "one");
  const journal = new SessionJournal(file, work, "scope");
  assert.equal(await journal.load(), undefined);
  await journal.save(history);
  assert.deepEqual(await journal.load(), history);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await assert.rejects(new SessionJournal(file, work, "other").load(), /scope/);
  await writeFile(join(work, "ignored"), "two");
  await assert.rejects(journal.load(), /Workspace changed/);
  await journal.discard();
  assert.equal(await journal.load(), undefined);
});
test("journal rejects link checkpoints and unsafe workspace entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reviewloop-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  await mkdir(work);
  await writeFile(join(work, "value"), "ok");
  const target = join(root, "target");
  await writeFile(target, "{}");
  await symlink(target, join(root, "symbol"));
  await link(target, join(root, "hard"));
  for (const file of ["symbol", "hard"])
    await assert.rejects(
      new SessionJournal(join(root, file), work, "scope").load(),
      /Unsafe/,
    );
  await symlink(target, join(work, "linked"));
  await assert.rejects(workspaceDigest(work), /Unsafe/);
  await rm(join(work, "linked"));
  await link(target, join(work, "hard"));
  await assert.rejects(workspaceDigest(work), /hard link/);
  await rm(join(work, "hard"));
  await mkdir(join(work, ".git"));
  await assert.rejects(workspaceDigest(work), /Unsafe/);
});
test("only complete tool rounds are valid and invalid save cannot replace prior checkpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reviewloop-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  await mkdir(work);
  const file = join(root, "session.json");
  const journal = new SessionJournal(file, work, "scope");
  await journal.save(history);
  const prior = await readFile(file, "utf8");
  for (const bad of [
    history.slice(0, 2),
    [history[2]],
    [
      ...history.slice(0, 2),
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "wrong", content: "x" }],
      },
    ],
  ]) {
    assert.throws(() => validateHistory(bad));
    await assert.rejects(journal.save(bad as Message[]));
  }
  assert.equal(await readFile(file, "utf8"), prior);
});
