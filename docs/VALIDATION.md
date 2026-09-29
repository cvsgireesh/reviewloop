# MVP validation — 2026-09-29

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

Passing the local suite establishes the tested controller behavior, not production readiness, provider entitlement or model quality. The source and installable package are ready for this credentialed pilot; no live service was installed or enabled.
