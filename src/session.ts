import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Message } from "./types.js";

const MAX_SESSION_BYTES = 8_000_000;
export async function workspaceDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0,
    bytes = 0;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Session workspace must be a real directory");
  async function walk(directory: string): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name),
        name = relative(root, path),
        stat = await lstat(path);
      if (++count > 10000)
        throw new Error("Session workspace exceeds 10000 entries");
      if (stat.isSymbolicLink() || entry.name.toLowerCase() === ".git")
        throw new Error("Unsafe session workspace entry");
      hash.update(
        JSON.stringify([
          name,
          stat.mode & 0o777,
          stat.isDirectory() ? "directory" : "file",
        ]),
      );
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error(
          "Session workspace contains a special file or hard link",
        );
      bytes += stat.size;
      if (bytes > 128_000_000)
        throw new Error("Session workspace exceeds 128MB");
      hash.update(String(stat.size));
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    }
  }
  await walk(root);
  return hash.digest("hex");
}

/** Only complete assistant/tool-result rounds may be resumed. No tool replay. */
export function validateHistory(value: unknown): asserts value is Message[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("Invalid session messages");
  let pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of value) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      !Array.isArray(message.content) ||
      !message.content.length
    )
      throw new Error("Invalid session message");
    const results = new Set<string>();
    const calls = new Set<string>();
    for (const block of message.content) {
      if (block?.type === "text") {
        if (typeof block.text !== "string")
          throw new Error("Invalid session text");
      } else if (block?.type === "tool_use") {
        if (
          message.role !== "assistant" ||
          typeof block.id !== "string" ||
          !block.id ||
          typeof block.name !== "string" ||
          !block.input ||
          typeof block.input !== "object" ||
          Array.isArray(block.input) ||
          calls.has(block.id) ||
          seen.has(block.id)
        )
          throw new Error("Invalid session tool call");
        calls.add(block.id);
        seen.add(block.id);
      } else if (block?.type === "tool_result") {
        if (
          message.role !== "user" ||
          typeof block.toolUseId !== "string" ||
          typeof block.content !== "string" ||
          results.has(block.toolUseId)
        )
          throw new Error("Invalid session tool result");
        results.add(block.toolUseId);
      } else throw new Error("Unknown session content");
    }
    if (pending.size) {
      if (
        message.role !== "user" ||
        message.content.some(
          (block: { type: string }) => block.type !== "tool_result",
        ) ||
        results.size !== pending.size ||
        [...results].some((id) => !pending.has(id))
      )
        throw new Error("Incomplete session tool round");
    } else if (results.size) throw new Error("Session has orphan tool results");
    pending = calls;
  }
  if (pending.size) throw new Error("Session has unfinished tool calls");
}

interface Envelope {
  version: 1;
  scope: string;
  workspaceDigest: string;
  messages: Message[];
  savedAt: string;
}
export class SessionJournal {
  constructor(
    readonly filename: string,
    readonly workspace: string,
    readonly scope: string,
  ) {}
  async load(): Promise<Message[] | undefined> {
    let info;
    try {
      info = await lstat(this.filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > MAX_SESSION_BYTES
    )
      throw new Error("Unsafe or oversized session checkpoint");
    const data = JSON.parse(await readFile(this.filename, "utf8")) as Envelope;
    if (data.version !== 1 || data.scope !== this.scope)
      throw new Error("Session scope changed");
    validateHistory(data.messages);
    if (data.workspaceDigest !== (await workspaceDigest(this.workspace)))
      throw new Error("Workspace changed since complete session checkpoint");
    return data.messages;
  }
  async save(messages: Message[]): Promise<void> {
    validateHistory(messages);
    const data: Envelope = {
      version: 1,
      scope: this.scope,
      workspaceDigest: await workspaceDigest(this.workspace),
      messages,
      savedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_SESSION_BYTES)
      throw new Error("Session checkpoint exceeds 8MB");
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.filename);
      const directory = await open(dirname(this.filename), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async discard(): Promise<void> {
    try {
      await rename(this.filename, `${this.filename}.discarded-${Date.now()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
