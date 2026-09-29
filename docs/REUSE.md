# Reuse and attribution

ReviewLoop uses existing libraries for model transport, GitHub API access and validation. Its job controller, approval protocol, bounded coding loop, memory policy and notification integration are project code. We do not claim to have embedded Codex or DeepSeek Harness.

## Direct components

| Component                         | Role                                                               | Upstream license                                                       |
| --------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `@aws-sdk/client-bedrock-runtime` | Bedrock request transport, `BedrockRuntimeClient` and Converse API | Apache-2.0                                                             |
| `@octokit/rest`                   | GitHub REST API                                                    | MIT                                                                    |
| `zod`                             | Configuration validation                                           | MIT                                                                    |
| Node.js `node:sqlite`             | Local durable state                                                | Node MIT plus bundled notices; SQLite public domain                    |
| Git executable                    | Local snapshots and publication                                    | GPL-2.0; separate executable                                           |
| Podman / Docker executable        | Configured container execution                                     | Podman Apache-2.0; Docker distribution/components have their own terms |

The lockfile records selected npm versions. These top-level license labels are not a complete transitive dependency or container-image license inventory. Review image contents and retain dependency notices when distributing. ReviewLoop itself is licensed under the [MIT License](../LICENSE).

Sources: [AWS SDK](https://github.com/aws/aws-sdk-js-v3), [AWS Converse examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html), [Octokit](https://github.com/octokit/rest.js), [Zod](https://github.com/colinhacks/zod), [Node](https://github.com/nodejs/node/blob/main/LICENSE), [SQLite](https://www.sqlite.org/copyright.html), [Git](https://github.com/git/git/blob/master/COPYING), [Podman](https://github.com/containers/podman).

## Design references, not runtime dependencies

DeepSeek Harness was inspected at commit `639ed015397290b3745d163aafe02ffee4aa3f84` (source version 0.2.0-rc.2, MIT). Useful patterns are durable session events separate from transient notifications, a model adapter separate from the loop, typed tool registration with monotonic policy guards, and skill summaries followed by on-demand instruction loading.

- [Architecture and turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/architecture.md)
- [Guarded tools](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/tools/README.md)
- [Skill providers](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/skill/skill/README.md)
- [Real TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/sdk/client/README.md)

Its SDK launches a full runtime; the minimal profile has a DeepSeek adapter and unrestricted shell and omits skills/instructions/compaction. Adopting that profile would require deliberate Bedrock and isolation integration. The project explicitly describes itself as developer preview. At inspection, npm `latest` for its client differed from repository/`next`; unpinned installation would not reproduce these APIs.

Codex was inspected at commit `26dd19ef478cfa294406413bafedb84b49f93ea4` (Apache-2.0). Its [TypeScript SDK](https://github.com/openai/codex/blob/26dd19ef478cfa294406413bafedb84b49f93ea4/sdk/typescript/README.md) wraps the CLI and exposes persisted threads, streamed events and structured results. These are useful lifecycle patterns, not evidence of native Bedrock compatibility. ReviewLoop's use of similar patterns does not confer Codex's isolation or reliability guarantees.

No upstream source was copied into this documentation task. If code is later imported, record its exact origin and retain the required notices.
