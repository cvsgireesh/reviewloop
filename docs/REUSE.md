# Reuse and attribution

ReviewLoop uses existing libraries for model transport, GitHub API access and validation. Its job controller, approval protocol, memory policy and notification integration are project code. The coding loop uses Pi Agent core. File patches use the pinned official Codex native patch engine inside the configured sandbox; this is not the full Codex agent runtime.

## Direct components

| Component                                                         | Role                                                                          | Upstream license                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-telemetry` (0.99.1) | Agent loop and types; explicit no-op telemetry; existing AWS transport bridge | MIT                                                                    |
| `@openai/codex` (0.159.0, worker image)                           | Native apply-patch engine only; exact version checked before each invocation  | Apache-2.0                                                             |
| `@aws-sdk/client-bedrock-runtime`                                 | Bedrock request transport, `BedrockRuntimeClient` and Converse API            | Apache-2.0                                                             |
| `@octokit/rest`                                                   | GitHub REST API                                                               | MIT                                                                    |
| `zod`                                                             | Configuration validation                                                      | MIT                                                                    |
| Node.js `node:sqlite`                                             | Local durable state                                                           | Node MIT plus bundled notices; SQLite public domain                    |
| Git executable                                                    | Local snapshots and publication                                               | GPL-2.0; separate executable                                           |
| Podman / Docker executable                                        | Configured container execution                                                | Podman Apache-2.0; Docker distribution/components have their own terms |

The lockfile records selected npm versions. These top-level license labels are not a complete transitive dependency or container-image license inventory. Review image contents and retain dependency notices when distributing. ReviewLoop itself is licensed under the [MIT License](../LICENSE).

Sources: [AWS SDK](https://github.com/aws/aws-sdk-js-v3), [AWS Converse examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html), [Octokit](https://github.com/octokit/rest.js), [Zod](https://github.com/colinhacks/zod), [Node](https://github.com/nodejs/node/blob/main/LICENSE), [SQLite](https://www.sqlite.org/copyright.html), [Git](https://github.com/git/git/blob/master/COPYING), [Podman](https://github.com/containers/podman).

## Design references, not runtime dependencies

DeepSeek Harness was inspected at commit `639ed015397290b3745d163aafe02ffee4aa3f84` (source version 0.2.0-rc.2, MIT). Useful patterns are durable session events separate from transient notifications, a model adapter separate from the loop, typed tool registration with monotonic policy guards, and skill summaries followed by on-demand instruction loading.

- [Architecture and turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/architecture.md)
- [Guarded tools](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/tools/README.md)
- [Skill providers](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/skill/skill/README.md)
- [Real TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/client/README.md)

DeepSeek's reusable `dsh-agent-loop` and tool-registration APIs do **not** require its default unrestricted shell. Its `dsh-llm-pi-ai` adapter already supports Bedrock through the installed Pi catalog provider. A custom composition is feasible. We selected direct Pi Agent core for a smaller in-process integration with ReviewLoop's existing controller and sandbox, not because DeepSeek cannot use Bedrock. DeepSeek remains a developer-preview alternative with Cordis service composition and prerelease version coordination costs.

- [Reusable loop](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/README.md)
- [Bedrock-preserving provider composition](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/llm/llm-pi-ai/src/provider.ts)
- [Pi Agent API](https://github.com/earendil-works/pi/blob/6a4af07d6145c88dad4e3472acebe75cc57af88f/packages/agent/README.md)
- [Pi telemetry: no exporter, explicit context](https://github.com/earendil-works/pi/blob/6a4af07d6145c88dad4e3472acebe75cc57af88f/packages/telemetry/README.md)

Codex was inspected at commit `26dd19ef478cfa294406413bafedb84b49f93ea4` (Apache-2.0). Its [TypeScript SDK](https://github.com/openai/codex/blob/26dd19ef478cfa294406413bafedb84b49f93ea4/sdk/typescript/README.md) wraps the CLI and exposes persisted threads, streamed events and structured results. These are useful lifecycle patterns, not evidence of native Bedrock compatibility. ReviewLoop's use of similar patterns does not confer Codex's isolation or reliability guarantees.

The worker installs the official Codex executable rather than copying or reimplementing its patch algorithm. The internal `--codex-run-as-apply-patch` ABI is pinned to 0.159.0 and guarded at runtime. Retain upstream package licenses/notices when distributing the image. [Upstream parser](https://github.com/openai/codex/blob/26dd19ef478cfa294406413bafedb84b49f93ea4/codex-rs/apply-patch/src/parser.rs).

Codex has [documented Bedrock support](https://help.openai.com/en/articles/20001252-use-codex-with-amazon-bedrock) for supported OpenAI models through the Responses API. Compatibility with this project's requested Anthropic model through Bedrock Converse is not established. ReviewLoop's inference therefore remains in its AWS transport; using Codex's patch engine does not route code to OpenAI. No model inference occurs in patch application. Reusing these components is not evidence of Codex-level coding quality or production isolation.
