# ReviewLoop MVP implementation plan

The owner approved implementation after reviewing the architecture. This supersedes the earlier design-only boundary. No company credentials, paid inference, real PR mutation or push of source is authorized by this local build.

Goal: installable Linux supervisor that monitors the owner's open PRs in explicitly configured owned repositories, autonomously evaluates feedback, edits and independently verifies a candidate, persists memory/preferences and evidence, asks through Telegram, and publishes only the exact approved candidate.

Architecture: a TypeScript Node 24 service; built-in SQLite durable state and outbox; Git and Octokit for repository operations; official AWS SDK for Bedrock; constrained agent tools in rootless Podman/Docker; Telegram Bot API outbound long polling. Persistent owner preferences cannot modify security policy. Models, notifications and sandbox execution are replaceable interfaces.

## Tasks and ownership

- [ ] Root: config validation, SQLite job/state/preferences/outbox/audit, controller, Git workspace/publisher, CLI and service orchestration.
- [ ] Atlas: provider/tool-loop harness, isolated execution, skills/context, focused tests. Files: src/harness.ts, src/model.ts, src/sandbox.ts, src/skills.ts, skills/, tests/harness.test.ts, tests/sandbox.test.ts, tests/model.test.ts.
- [ ] Integration agent: GitHub discovery/snapshots/fingerprints and Telegram send/receive/identity checks. Files src/github.ts, src/telegram.ts and their tests.
- [ ] Scout: upstream reuse evidence, then install/setup docs and operational runbook. No duplicate agent platform or copied unlicensed code.
- [ ] Root + independent reviewer: adversarial approval, stale head, duplicate/restart recovery, typed revisions, memory restart, package install and full tool-loop integration against disposable fixture repos. Report live-service tests separately.

## Contracts and nonnegotiable checks

Public contracts live in src/types.ts. Agents own separate files; parent reviews/integrates them. Use ESM .js imports. Unknown config fails validation. Secrets are environment names, never copied into workspaces. No worker GitHub token, runtime socket or .git access. No auto-pull of images, implicit telemetry or alternate model fallback. Shell/test execution fails closed without configured runtime. unsafe-local exists only for explicitly selected trusted fixture testing and is labeled unisolated.

Jobs are durable and per-PR serialized. Canonical feedback+head hash deduplicates polling; feedback authors do not gain tool/security authority. Only configured Telegram user/chat can decide or write durable preferences. Candidate SHA, patch hash, tests and approval nonce are persisted. New feedback/head/config invalidates approval. Push uses exact expected remote head, no merge. Uncertain publish outcome is reconciled before retries. Notification failure remains observable and retryable.

The example budget ($5/job, $25 total, three edit/check cycles) is an editable conservative proposal, not spending authorization or a measured cost estimate. Enforce step/token/time bounds and estimated USD reservation when owner supplies current prices; never invent rates. CLI/setup must disclose limits and missing credentials. No autonomous paid inference during development.

## Acceptance verification

Run npm run check, npm test, npm run build, npm pack, clean package install + CLI help/init/doctor. Exercise scripted tool calls against actual temporary Git repos; actual file mutation, test execution, immutable commits, negative/positive approval and publication to a local bare remote. Distinguish that evidence from a real Bedrock+Telegram+GitHub pilot, which needs configured deployment credentials and permission.
