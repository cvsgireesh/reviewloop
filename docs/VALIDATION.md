# Version 0.2.0 validation — 2026-09-29

The upgrade replaces the custom coding loop with pinned Pi Agent core 0.99.1 and uses the official Codex 0.159.0 native patch engine through the configured sandbox. The controller, AWS transport, budget accounting, Git verification and approval publisher remain ReviewLoop code. This is component reuse, not adoption of the full Codex agent and not evidence of equivalent coding quality.

## Executed locally

- TypeScript checks, formatting checks and build passed. The complete integrated suite passed: **88 tests, zero failures, zero skips**, with the native Codex contract enabled through `REVIEWLOOP_CODEX_TEST_BIN`. Runtime dependency audit reported zero known vulnerabilities at execution time.
- `npm pack` produced `cvsgireesh-reviewloop-0.2.0.tgz`. It was installed into a fresh npm prefix; the installed executable ran help, config initialization, preference persistence, status and all four reference evaluations. Packaged worker-image instructions and evaluation fixtures were present. No live service was started.
- Nine focused evaluation-runner tests passed locally. They exercised all four baseline/reference oracles, scripted tool edits followed by real Node checks, hidden-test separation, path restrictions, early process-exit detection, verification-time source mutation, persisted uncertain reservations, and token/dollar limits before provider dispatch. The provider was injected; no paid or real-model evaluation occurred.
- Each of the four benchmark baselines passes visible smoke checks and fails its hidden acceptance suite. Every reference overlay passes visible and hidden checks and changes only permitted paths. [Detailed oracle evidence](../evals/verification-results.json). These runs validate the benchmark, not model quality.
- The checked-in runtime uses Pi's agent lifecycle with explicitly registered confined tools, sequential tool execution and no-op telemetry. Provider calls go through the existing configured transport adapter rather than a Pi default provider.
- Checkpoint tests cover complete-round retry without tool replay, scope and workspace drift, unsafe links, uncertain usage, restart recovery and frozen-candidate inheritance. Regression tests cover a crash after candidate creation but before saving its approval state, and recovery of failed-test diagnostics absent from the older checkpoint. Candidate comparisons and parent commits remain anchored to the original PR head. These local fixtures do not establish reliability on a deployed host.
- [ADR 002](ADR-002-HARNESS.md) records the separately executed native Codex patch contract fixtures and their limits. A local patch-engine run is not container qualification.

## Evidence still missing for this upgrade

1. A successful rootless Linux qualification of the intended runtime and `localhost/reviewloop-worker:0.2.0` image. The image recipe exists; it has not been qualified merely by checking source or arguments.
2. Actual configured-model runs of the repair benchmark, with fixed budgets, model/version, repeated trials and per-task outcomes. No live model success rate or Codex-level comparison is established.
3. An authorized disposable GitHub/Telegram/Bedrock pilot, including identity, renewal, notifications, revision continuation, approval and restart behavior on the deployment machine.

Use `reviewloop evaluate --reference --output /tmp/reviewloop-reference-UNIQUE` for credential-free oracle validation. Actual model evaluation requires explicit `--allow-model-calls`, a configured provider and a qualified rootless sandbox:

```sh
reviewloop evaluate --allow-model-calls --config reviewloop.json --output /tmp/reviewloop-model-UNIQUE
```

Reports distinguish reference, injected-provider and configured-provider runs. Read the [benchmark protocol](../evals/README.md) before comparing results. Four synthetic tasks cannot establish broad coding quality or resistance to arbitrary hostile source code.

---

# Version 0.1.0 historical validation — 2026-09-29

Version 0.1.0 was built on macOS with Node.js 26.8.1. The deployment target is Linux with Node.js 24 or newer. Linux CI is configured but has not run remotely because the source has not been pushed.

## Executed locally

- `npm run check`: passed.
- `npm test`: 58 tests passed, zero failures and zero skips.
- `npm run build`: passed.
- `npm pack`: produced an installable npm tarball.
- Installed the tarball into a fresh, separate npm prefix. Its actual symlinked executable ran help, config initialization, durable preference add/list, status and audit commands successfully. Offline doctor rejected an unconfigured deployment without model inference; the installed sandbox qualification help also ran.
- The test suite edited real fixture files, ran real checks, and pushed the exact approved candidate to a temporary local bare Git remote. Model decisions in these controller tests were scripted; this is not evidence of live model coding quality.
- Official AWS SDK transport was exercised with a mock HTTP handler, including bearer authorization, Converse tool use/results, usage and output limits. The alternate provider used a local HTTP fixture. No paid inference occurred.
- Telegram owner/chat validation, explicit approval tokens, typed revisions, multipart replies, redaction and polling were tested with simulated Bot API responses. No Telegram message was sent.
- Real process tests exercised timeouts and output bounds. Container argument and cleanup tests used a fixture executable; no real container isolation was established by those tests.

## Important regressions covered

Approval cannot be reused after feedback/head/configuration changes. Revisions and delayed model usage retain the same budget group. An uncertain provider outcome retains its reserved tokens/cost across restart. Pilot-wide token limits stop new groups before model dispatch. Late API responses and notification receipts cannot revive a superseded approval.

Independent checks run in a clean materialization of the staged Git tree, so ignored helper files cannot make an incomplete commit appear valid. Existing common test definitions/manifests and configured protected paths cannot be silently weakened. New tests are allowed. These controls do not prove semantic correctness or identify every possible test dependency.

The single-writer lock was exercised across separate processes, including proven-dead PID recovery and conservative refusal of reused/mismatched process identities. State, preferences, decisions and the notification outbox survived database reopen.

## Still required on the deployment machine

1. Run the real sandbox qualification from the operations guide against each intended rootless runtime/image. The current development host did not qualify: its configured local runtime endpoint/image was unavailable. A separate Docker context exists but is not a qualified rootless deployment.
2. Confirm Bedrock account/model access, actual tool-using inference, pricing and credential renewal.
3. Verify GitHub permissions and Telegram delivery/owner decisions with a disposable pilot PR before watching working repositories.
4. Exercise service restart and notification delivery on that Linux host.

Passing the local suite establishes the tested controller behavior, not production readiness, provider entitlement or model quality. That version's local package was prepared for a separately authorized pilot; no live service was installed or enabled. These results do not certify the 0.2.0 upgrade.
