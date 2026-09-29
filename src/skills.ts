import { readFile } from "node:fs/promises";
import type { ToolSpec } from "./types.js";

export const skillCatalog = [
  {
    name: "review-feedback",
    description:
      "Assess relevance, conflicts and evidence before making a justified PR fix.",
  },
  {
    name: "verify-candidate",
    description:
      "Prepare a narrow candidate and explain verification limits without claiming approval.",
  },
] as const;

export async function readSkill(name: string): Promise<string> {
  if (!skillCatalog.some((skill) => skill.name === name))
    throw new Error("Unknown bundled skill");
  return readFile(
    new URL(`../skills/${name}/SKILL.md`, import.meta.url),
    "utf8",
  );
}

function spec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSpec {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
const string = { type: "string" };
export const tools: ToolSpec[] = [
  spec(
    "read_skill",
    "Load a bundled skill by catalog name.",
    { name: string },
    ["name"],
  ),
  spec(
    "list_files",
    "List regular workspace files; .git, symlinks and dependency caches are excluded.",
    {
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    [],
  ),
  spec(
    "read_file",
    "Read a numbered page of a UTF-8 workspace file. No absolute paths, traversal or symlinks.",
    {
      path: string,
      start_line: { type: "integer", minimum: 1 },
      line_count: { type: "integer", minimum: 1 },
    },
    ["path"],
  ),
  spec(
    "write_file",
    "Create a file, or replace a previously read unchanged file. No .git, traversal or symlinks.",
    { path: string, content: string },
    ["path", "content"],
  ),
  spec(
    "edit_file",
    "Replace exactly one occurrence of old_text; rejects ambiguous matches.",
    { path: string, old_text: string, new_text: string },
    ["path", "old_text", "new_text"],
  ),
  spec(
    "apply_patch",
    "Apply a Codex patch inside the configured sandbox; requires preloaded Codex helper.",
    { patch: string },
    ["patch"],
  ),
  spec(
    "search",
    "Find a literal string in bounded workspace files; no regular expressions.",
    { query: string },
    ["query"],
  ),
  spec(
    "run_command",
    "Run a command through the configured isolated sandbox with bounded output/time.",
    { command: string },
    ["command"],
  ),
];
