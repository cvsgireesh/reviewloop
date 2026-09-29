import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyCodexPatch } from "../src/codex-patch.js";
import { createSandbox } from "../src/sandbox.js";
import type { Config, Sandbox } from "../src/types.js";

const add = (name: string) =>
  `*** Begin Patch\n*** Add File: ${name}\n+hello\n*** End Patch`;
const fixture = () => mkdtemp(path.join(tmpdir(), "reviewloop-codex-"));
const options = { maxBytes: 40_000 };

test("patch destination guards reject escapes and links before any execution", async () => {
  const dir = await fixture();
  let calls = 0;
  const sandbox: Sandbox = {
    doctor: async () => [],
    run: async () => {
      calls++;
      throw new Error("Unexpected execution");
    },
  };
  try {
    await writeFile(path.join(dir, "file"), "old\n");
    await symlink(tmpdir(), path.join(dir, "linked"));
    await link(path.join(dir, "file"), path.join(dir, "hard"));
    for (const name of [
      "../escape",
      "/tmp/escape",
      "a/../../escape",
      ".git/config",
      "a/.GIT/config",
      "a\\b",
      "a//b",
      "./a",
      "linked/file",
      "hard",
      "C:/a",
      "trailing ",
    ]) {
      await assert.rejects(applyCodexPatch(dir, add(name), sandbox, options));
      await assert.rejects(
        applyCodexPatch(
          dir,
          `*** Begin Patch\n*** Update File: safe\n*** Move to: ${name}\n@@\n-old\n+new\n*** End Patch`,
          sandbox,
          options,
        ),
      );
    }
    await assert.rejects(
      applyCodexPatch(dir, add("safe"), sandbox, { maxBytes: 1 }),
    );
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("version mismatch refuses execution before patch invocation", async () => {
  const dir = await fixture();
  const prior = process.env.PATH;
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "codex"),
      '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 0.1.0"; else touch invoked; fi\n',
    );
    await chmod(path.join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${prior}`;
    const sandbox = createSandbox(
      {
        sandbox: "unsafe-local",
        maxJobMinutes: 1,
        maxToolOutputBytes: 4096,
      } as Config["runtime"],
      true,
    );
    await assert.rejects(
      applyCodexPatch(dir, add("new"), sandbox, options),
      /Pinned Codex/,
    );
    await assert.rejects(readFile(path.join(dir, "invoked")));
  } finally {
    process.env.PATH = prior;
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "official native Codex applies a real multifile patch with literal shell syntax",
  { skip: !process.env.REVIEWLOOP_CODEX_TEST_BIN },
  async () => {
    const dir = await fixture();
    const prior = process.env.PATH;
    try {
      process.env.PATH = `${process.env.REVIEWLOOP_CODEX_TEST_BIN}:${prior}`;
      await writeFile(path.join(dir, "old.txt"), "old\n");
      await writeFile(path.join(dir, "delete.txt"), "bye\n");
      const patch =
        "*** Begin Patch\n*** Add File: nested/new.txt\n+literal ' $(touch escaped) `touch escaped2`\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch";
      const sandbox = createSandbox(
        {
          sandbox: "unsafe-local",
          maxJobMinutes: 1,
          maxToolOutputBytes: 4096,
        } as Config["runtime"],
        true,
      );
      await applyCodexPatch(dir, patch, sandbox, options);
      assert.equal(
        await readFile(path.join(dir, "nested/new.txt"), "utf8"),
        "literal ' $(touch escaped) `touch escaped2`\n",
      );
      assert.equal(
        await readFile(path.join(dir, "moved.txt"), "utf8"),
        "new\n",
      );
      for (const file of ["old.txt", "delete.txt", "escaped", "escaped2"])
        await assert.rejects(readFile(path.join(dir, file)));
    } finally {
      process.env.PATH = prior;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
