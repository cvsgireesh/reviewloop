# Agent integration and contributor guide

ReviewLoop is a CLI application with internal TypeScript interfaces. It does not expose an MCP server or a public agent-control HTTP API. The interfaces below describe the current source; treat them as versioned implementation details rather than a stable third-party SDK.

Start with [contributor instructions](../AGENTS.md), [setup and usage](../README.md), [operations](OPERATIONS.md), [security boundaries](SECURITY.md) and [recorded validation](VALIDATION.md).

## CLI surfaces

After `npm run build`, use `node dist/cli.js --help` or the installed `reviewloop` command. Configuration defaults to `./reviewloop.json`.

| Intent                                               | Command                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Generate a secret-free config without overwriting    | `reviewloop init`                                                                             |
| Inspect prerequisites without network requests       | `reviewloop doctor`                                                                           |
| Read local state                                     | `reviewloop status`, `jobs`, `show JOB_ID`, `events [JOB_ID]`                                 |
| Manage owner preferences                             | `reviewloop preferences list`, `preferences add TEXT [--repo OWNER/REPO]`, `forget MEMORY_ID` |
| Control local scheduling                             | `reviewloop pause`, `resume`, `retry JOB_ID`                                                  |
| Execute one real supervisor cycle                    | `reviewloop run --once`                                                                       |
| Validate bundled fixture oracles without model calls | `reviewloop evaluate --reference --output NEW_DIRECTORY`                                      |

`doctor --live` performs identity checks, not inference or message delivery. `run` can call models and notify the owner; publishing still requires approval. `evaluate --allow-model-calls` explicitly enables model spending. See [evaluation protocol](../evals/README.md) before using it. There is no CLI approval bypass.

## Runtime and tools

[`runHarness(input, model, sandbox)`](../src/harness.ts) embeds Pi Agent core. [`ModelProvider.complete(request)`](../src/types.ts) remains the model transport boundary, implemented in [`model.ts`](../src/model.ts) for Bedrock and configured OpenAI-compatible endpoints. The runtime supplies budget callbacks, records usage and audit events, and returns a candidate summary—not independent test evidence.

[`Sandbox.run(workspace, command, options)`](../src/types.ts) executes commands in the configured runtime. Options include an image, timeout and abort signal. Production execution requires the configured rootless sandbox; trusted-fixture local execution must be explicitly enabled.

Tool declarations live in [`skills.ts`](../src/skills.ts), with execution in [`workspace-tools.ts`](../src/workspace-tools.ts):

| Tool          | Arguments and behavior                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| `list_files`  | Optional `offset`, `limit`; bounded listing with dependency/cache exclusions |
| `read_file`   | `path`, optional `start_line`, `line_count`; numbered bounded page           |
| `write_file`  | `path`, `content`; create, or replace a previously read unchanged file       |
| `edit_file`   | `path`, `old_text`, `new_text`; requires exactly one matching occurrence     |
| `search`      | `query`; bounded literal text search, reports incomplete scans               |
| `apply_patch` | `patch`; pinned Codex patch helper inside the sandbox, no host fallback      |
| `run_command` | `command`; uses the sandbox and repository image                             |
| `read_skill`  | `name`; loads one bundled skill from the catalog                             |

Paths reject traversal, Git metadata and unsafe links. Tools run sequentially. The two bundled skills are [`review-feedback`](../skills/review-feedback/SKILL.md) and [`verify-candidate`](../skills/verify-candidate/SKILL.md). They are loaded on demand; their text cannot grant privileges.

## State, memory and evidence

[`SessionJournal`](../src/session.ts) stores complete conversation rounds outside the mounted workspace. `validateHistory` rejects orphan or unfinished calls. Scope and workspace digest must match on load. Context reduction omits older tool outputs with an explicit notice while retaining call/result pairing and user instructions; it is deterministic pruning, not model-generated semantic compaction.

[`Store`](../src/store.ts) manages SQLite jobs, grouped budgets, owner preferences, recent published-run summaries and the notification outbox. `remember`, `memories` and `forget` serve owner preference controls; no worker tool can mutate them. A preference is context and cannot override approval or sandbox policy.

`HarnessInput.beforeCall`, `onUsage`, `onEvent` and optional `checkpoint` are controller callbacks. Audit events include `agent_runtime`, `model_call`, `model_result`, `tool_call` and `tool_result`; tool audit records contain bounded metadata/hashes rather than full raw output. Complete private session checkpoints can contain repository content. Keep state private and out of Git.

Controller verification and frozen Git candidate evidence determine whether approval is offered. The agent's final prose does not establish that tests ran. Preserve this separation when adding adapters or tools.

## Canonical source

Repository: [cvsgireesh/reviewloop](https://github.com/cvsgireesh/reviewloop).

Editable source: [AGENTS.md](https://github.com/cvsgireesh/reviewloop/blob/main/AGENTS.md), [this guide](https://github.com/cvsgireesh/reviewloop/blob/main/docs/AGENT-GUIDE.md). Raw Markdown: [instructions](https://raw.githubusercontent.com/cvsgireesh/reviewloop/main/AGENTS.md), [guide](https://raw.githubusercontent.com/cvsgireesh/reviewloop/main/docs/AGENT-GUIDE.md).
