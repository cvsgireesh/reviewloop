import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HarnessInput, Sandbox } from "./types.js";
import { readSkill, tools } from "./skills.js";
import { applyCodexPatch } from "./codex-patch.js";

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const clipped = (text: string, limit: number) =>
  Buffer.byteLength(text) <= limit
    ? text
    : Buffer.from(text)
        .subarray(0, Math.max(0, limit - 32))
        .toString("utf8") + "\n[output truncated]";
async function safePath(
  root: string,
  name: string,
  createParents = false,
): Promise<string> {
  if (
    !name ||
    path.isAbsolute(name) ||
    name.includes("\\") ||
    name.includes("\0")
  )
    throw new Error("Path must be relative to workspace");
  const parts = name.split("/");
  if (
    parts.some(
      (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
    )
  )
    throw new Error("Traversal and .git paths are forbidden");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (i < parts.length - 1 && createParents) {
        await mkdir(current);
        info = await lstat(current);
      } else if (i < parts.length - 1)
        throw new Error("Parent directory does not exist");
    }
    if (info?.isSymbolicLink()) throw new Error("Symlink access is forbidden");
    if (info && i < parts.length - 1 && !info.isDirectory())
      throw new Error("Parent must be a directory");
    if (info && i === parts.length - 1 && (!info.isFile() || info.nlink > 1))
      throw new Error("Path must be a regular file");
  }
  return current;
}

export async function readBounded(
  root: string,
  name: string,
  limit: number,
): Promise<string> {
  const filename = await safePath(root, name);
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1)
      throw new Error("Path must be a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return clipped(buffer.subarray(0, bytesRead).toString("utf8"), limit);
  } finally {
    await handle.close();
  }
}

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  let visited = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 10_000)
        throw new Error("Workspace listing exceeds 10000 entries");
      if (
        [".git", "node_modules", ".venv", "__pycache__"].includes(
          entry.name.toLowerCase(),
        ) ||
        entry.isSymbolicLink()
      )
        continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  await walk("");
  return result;
}

function validate(
  name: string,
  value: Record<string, unknown>,
): Record<string, any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid tool arguments");
  const properties = tool.inputSchema.properties as Record<
    string,
    { type: string }
  >;
  for (const key of Object.keys(value)) {
    const spec = properties[key];
    if (
      !spec ||
      (spec.type === "integer"
        ? !Number.isSafeInteger(value[key]) || Number(value[key]) < 1
        : typeof value[key] !== spec.type)
    )
      throw new Error("Unexpected or invalid tool argument");
  }
  for (const key of tool.inputSchema.required as string[])
    if (!(key in value)) throw new Error("Missing required tool argument");
  return value;
}

export function createWorkspaceTools(
  root: string,
  input: HarnessInput,
  sandbox: Sandbox,
  signal: AbortSignal,
) {
  const limit = input.config.runtime.maxToolOutputBytes;
  const fileLimit = Math.min(input.config.runtime.maxPatchBytes, 1024 * 1024);
  const seen = new Map<string, string>();
  async function readFull(name: string, max = 8 * 1024 * 1024) {
    const filename = await safePath(root, name);
    const handle = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("Path must be a regular file");
      if (stat.size > max) throw new Error("File exceeds scan/edit size bound");
      const buffer = Buffer.alloc(Math.min(stat.size, max) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > max) throw new Error("File exceeds scan/edit size bound");
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  async function write(name: string, content: string, expected?: string) {
    if (Buffer.byteLength(content) > fileLimit)
      throw new Error("Write exceeds configured file size limit");
    const filename = await safePath(root, name, true);
    let old: string | undefined;
    try {
      old = await readFull(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (old !== undefined && (expected ?? seen.get(name)) !== digest(old))
      throw new Error(
        "Read the current file before replacing it; file is unread or changed since read",
      );
    const handle = await open(
      filename,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (old === undefined ? constants.O_CREAT | constants.O_EXCL : 0),
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("Path must be a regular file");
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    seen.set(name, digest(content));
    return "Workspace file written; independent verification is still required.";
  }
  return async function execute(
    name: string,
    raw: Record<string, unknown>,
  ): Promise<string> {
    signal.throwIfAborted();
    const args = validate(name, raw);
    if (name === "read_skill") return readSkill(args.name);
    if (name === "list_files") {
      const entries = await files(root);
      const start = (args.offset ?? 1) - 1;
      const selected = entries.slice(
        start,
        start + Math.min(args.limit ?? 200, 1000),
      );
      return clipped(
        selected.join("\n") +
          `\n[files ${start + 1}-${start + selected.length} of ${entries.length}; next offset ${start + selected.length + 1}]`,
        limit,
      );
    }
    if (name === "read_file") {
      const text = await readFull(args.path);
      seen.set(args.path, digest(text));
      const lines = text.split("\n");
      const start = (args.start_line ?? 1) - 1;
      const page = lines.slice(
        start,
        start + Math.min(args.line_count ?? 150, 1000),
      );
      return clipped(
        page.map((line, i) => `${start + i + 1}: ${line}`).join("\n") +
          `\n[lines ${start + 1}-${start + page.length} of ${lines.length}]`,
        limit,
      );
    }
    if (name === "write_file") return write(args.path, args.content);
    if (name === "edit_file") {
      if (!args.old_text) throw new Error("old_text must be nonempty");
      const old = await readFull(args.path);
      const index = old.indexOf(args.old_text);
      if (index < 0 || old.indexOf(args.old_text, index + 1) >= 0)
        throw new Error("old_text must match exactly once");
      return write(
        args.path,
        old.slice(0, index) +
          args.new_text +
          old.slice(index + args.old_text.length),
        digest(old),
      );
    }
    if (name === "search") {
      if (!args.query || args.query.length > 1024)
        throw new Error("Search requires a literal query of 1–1024 characters");
      const matches: string[] = [];
      let bytes = 0;
      let scanned = 0;
      const skipped: string[] = [];
      for (const filename of await files(root)) {
        signal.throwIfAborted();
        let text: string;
        try {
          text = await readFull(filename);
        } catch {
          skipped.push(filename);
          continue;
        }
        scanned += Buffer.byteLength(text);
        if (scanned > 32 * 1024 * 1024) {
          skipped.push("remaining files: total scan byte limit");
          break;
        }
        if (text.includes("\0")) {
          skipped.push(filename);
          continue;
        }
        for (const [i, line] of text.split("\n").entries())
          if (line.includes(args.query)) {
            const match = `${filename}:${i + 1}:${line}`;
            matches.push(match);
            bytes += Buffer.byteLength(match);
            if (bytes >= limit - 100)
              return (
                clipped(matches.join("\n"), limit - 80) +
                "\n[search output limit reached; scan incomplete]"
              );
          }
      }
      return clipped(
        (matches.join("\n") || "No literal matches in scanned text.") +
          (skipped.length
            ? `\n[scan incomplete; skipped ${skipped.length}: ${skipped.slice(0, 10).join(", ")}]`
            : "\n[scan complete]"),
        limit,
      );
    }
    if (name === "apply_patch")
      return applyCodexPatch(root, args.patch, sandbox, {
        image: input.commandImage,
        signal,
        maxBytes: input.config.runtime.maxPatchBytes,
      });
    if (name === "run_command") {
      if (!args.command || args.command.length > 8192)
        throw new Error("Command must be 1–8192 characters");
      return JSON.stringify(
        await sandbox.run(root, args.command, {
          signal,
          image: input.commandImage,
        }),
      );
    }
    throw new Error("Unknown tool");
  };
}
