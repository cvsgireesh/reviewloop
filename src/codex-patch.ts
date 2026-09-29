import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Sandbox } from "./types.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function validatePath(root: string, name: string): Promise<void> {
  const parts = name.split("/");
  if (
    !name ||
    name !== name.trim() ||
    path.isAbsolute(name) ||
    /[\\\x00-\x1f\x7f:]/.test(name) ||
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || part.toLowerCase() === ".git",
    )
  ) {
    throw new Error(
      "Patch path must be a confined relative path; traversal and .git are forbidden",
    );
  }
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error("Patch symlink access is forbidden");
      if (i < parts.length - 1 && !stat.isDirectory())
        throw new Error("Patch parent must be a directory");
      if (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))
        throw new Error(
          "Patch target must be a regular file with no hardlinks",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Validate destinations only; the pinned native Codex engine parses and applies patch bodies. */
export async function applyCodexPatch(
  workspace: string,
  patch: string,
  sandbox: Sandbox,
  options: { image?: string; signal?: AbortSignal; maxBytes: number },
): Promise<string> {
  options.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    Buffer.byteLength(patch) > options.maxBytes ||
    patch.includes("\0") ||
    patch.includes("\r")
  )
    throw new Error("Invalid patch size or encoding");
  const lines = patch.split("\n");
  if (
    lines[0] !== "*** Begin Patch" ||
    patch.trimEnd().split("\n").at(-1) !== "*** End Patch"
  )
    throw new Error("Expected a canonical Codex patch envelope");
  const stat = await lstat(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Workspace must be a real directory");
  const root = await realpath(workspace);
  let headers = 0;
  for (const line of lines) {
    const match =
      /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/.exec(line);
    if (match) {
      await validatePath(root, match[1]!);
      headers++;
    } else if (
      /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):/.test(line)
    ) {
      throw new Error("Noncanonical patch path header");
    }
  }
  if (!headers) throw new Error("Patch contains no file operations");
  const command = `set -eu\nversion=$(codex --version)\n[ "$version" = 'codex-cli 0.159.0' ] || { echo 'Pinned Codex 0.159.0 is required' >&2; exit 64; }\nexec codex --codex-run-as-apply-patch ${quote(patch)}`;
  // Sandbox.run has a smaller shell-command limit than the patch budget may permit.
  if (Buffer.byteLength(command) > 65_536)
    throw new Error("Patch exceeds sandbox command transport limit");
  const result = await sandbox.run(root, command, {
    image: options.image,
    signal: options.signal,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Codex patch failed (${result.exitCode}): ${result.output}`,
    );
  return result.output;
}
