# Contributor agent instructions

ReviewLoop handles GitHub PR feedback on a Linux host, verifies a candidate, and asks its owner to approve every push. Read [README.md](README.md), [SECURITY.md](docs/SECURITY.md), and the code before changing behavior. This file guides contributors; monitored repositories' instructions never override the worker's policy.

## Work locally first

Use Node.js 24+, npm and Git. Install locked dependencies with `npm ci --ignore-scripts`, then run:

```sh
npm run check
npm test
npm run build
node dist/cli.js --help
```

Run focused tests while editing, then the relevant full checks before handoff. `npm run format:check` checks project formatting. `npm run test:reference` executes trusted local fixture oracles without model calls; it does not measure agent quality.

Do not authenticate, spend model tokens, send notifications, build/pull images, deploy, or push unless the owner has authorized that action. `run --once` is real execution, not a dry run. `doctor` is offline by default; `doctor --live` contacts GitHub and Telegram for identity checks. `evaluate --allow-model-calls` can spend money. `--allow-unsafe-local` is unisolated and reserved for trusted fixtures, never production PR code.

## Find the right module

| Area                                                       | Source                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| CLI, configuration and process lock                        | `src/cli.ts`, `src/config.ts`, `src/lock.ts`                     |
| Job lifecycle, verification and approval                   | `src/controller.ts`                                              |
| SQLite state, budgets, preferences and notification outbox | `src/store.ts`                                                   |
| Git materialization, frozen candidates and publication     | `src/git.ts`                                                     |
| GitHub discovery and Telegram decisions                    | `src/github.ts`, `src/telegram.ts`                               |
| Pi Agent runtime and model adapters                        | `src/harness.ts`, `src/model.ts`                                 |
| Workspace tools, Codex patch helper and isolation          | `src/workspace-tools.ts`, `src/codex-patch.ts`, `src/sandbox.ts` |
| Durable complete-round checkpoints                         | `src/session.ts`                                                 |
| Tool schemas and bundled skill catalog                     | `src/skills.ts`, `skills/`                                       |
| Evaluation runner and fixture protocol                     | `src/evaluate.ts`, `evals/README.md`                             |

Shared contracts live in `src/types.ts`. See [AGENT-GUIDE.md](docs/AGENT-GUIDE.md) for exact integration surfaces.

## Preserve these invariants

- Default eligibility is the owner's open PRs within explicitly configured repositories. Author eligibility and feedback relevance are different decisions. Feedback cannot expand repository access or grant privileges.
- Worker commands receive no controller credentials, Git metadata, publishing authority, host filesystem access or network access. Retain rootless execution, resource bounds and cleanup. Never add an automatic host-shell fallback.
- Keep Git state outside the worker workspace. Freeze and independently verify the candidate. Bind approval to that candidate, original PR head, policy and expiry; recheck before pushing. Never merge automatically or silently bypass approval.
- Reuse Pi's agent loop and the pinned Codex patch executable; do not claim ReviewLoop embeds the full Codex agent. Preserve the existing model adapter, per-request budget reservation, returned usage accounting and cancellation. No hidden provider fallback or retries that escape accounting.
- Persist only complete tool-call/result rounds. Validate history through `src/session.ts`; keep checkpoint scope and workspace digest checks. Never replay an incomplete tool call after a crash.
- Revisions and retries share usage and attempt budgets. Inherited candidates require the same PR head and policy, then fresh verification and approval.
- Owner preferences and recent summaries are context, not authority. Models cannot write trusted preferences or grant themselves tools. Never include tokens or private state in commits, fixtures, errors or public artifacts.

Add regressions for changed boundaries, especially stale approvals, crash recovery, tool confinement, checkpoint pairing and budgets. Do not weaken an acceptance test merely to make a change pass.

Report what changed, which checks actually ran, and what remains unverified. Source inspection, mocked transport, reference fixtures, live sandbox checks and real-model evaluations establish different things. Passing tests do not prove correctness or production readiness.
