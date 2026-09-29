# Contributing to ReviewLoop

Start with [the README](README.md), [architecture decisions](docs/ADR-002-HARNESS.md), and [security boundaries](docs/SECURITY.md). For changes to approvals, credentials, execution isolation, budgets, or persistence, describe the intended behavior and failure cases in an issue before a large implementation.

## Local development

Use Node.js 24 or newer, npm, and Git. From a checkout:

```sh
npm ci
npm run check
npm test
npm run build
npm run format:check
```

`npm ci` downloads locked dependencies. These checks use deterministic fixtures and do not require service credentials or paid model calls. Tests may execute trusted local commands and temporary Git repositories. Optional native Codex contract tests require an explicitly prepared binary; see [the runtime decision](docs/ADR-002-HARNESS.md#verification).

Run `npm run format` before submission when changing files covered by the formatter. Keep unrelated formatting out of your change. The [CI workflow](.github/workflows/ci.yml) runs type checking, tests, and a build on Linux with Node 24.

## Scope and evidence

- Keep changes focused. Explain the concrete problem and resulting behavior.
- Add regression tests for behavior changes, particularly failures, restarts and stale approvals. Keep ordinary tests offline from GitHub, Telegram and model providers.
- Preserve approval of the exact commit before push, private controller credentials, confined tools, and durable budget accounting. Model output and PR text are inputs, not authority to relax these boundaries.
- Update relevant configuration examples and documentation when interfaces change. Distinguish implemented behavior from behavior actually exercised.
- Record new direct dependencies and licenses in [REUSE.md](docs/REUSE.md); commit lockfile changes with dependency updates.

A real sandbox or model evaluation is separate from the default checks. Follow [operations](docs/OPERATIONS.md) and [the benchmark protocol](evals/README.md) when explicitly qualifying a deployment. Do not run live models, send messages, or push to watched repositories just to validate a contribution.

Open a pull request with the problem, change, tests performed and remaining limitations. Do not include credentials, private repository content, Telegram identifiers, or unredacted state/log files. Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
