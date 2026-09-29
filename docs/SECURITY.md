# Security boundaries

ReviewLoop runs code influenced by PR feedback. Feedback, repository files, skills, model output and test logs are untrusted input. Eligibility for monitoring does not authorize a commenter to change configuration, grant tools, write owner preferences or approve a push.

## Intended separation

- The controller owns GitHub/Telegram/model credentials, durable state and publication. The coding workspace must not contain those credentials, the repository's `.git` directory, container-engine sockets or host state.
- Use rootless Podman or rootless Docker with a preloaded trusted image and bounded execution. A container shares its host kernel; it is not a virtual-machine boundary. Apply host-level isolation appropriate to the repositories you run.
- `unsafe-local` is unisolated execution for explicitly selected trusted fixtures only. It is not a production fallback when container setup fails.
- Only the configured Telegram owner and chat can make decisions. Approval binds the candidate commit, patch and current inputs; changed inputs need fresh approval. The model has no push or merge tool.
- Skills and saved preferences supply context. They cannot override tool guards, budgets, eligible repositories or publication approval. Memory writes are owner-controlled, not an agent self-authorization mechanism.

These are implementation requirements, not a security certification. Check the actual tests and deployment before relying on them. Shell deny-lists and prompt instructions alone are not containment.

## Data flows

The intended external recipients are GitHub (PR discovery and approved publication), the selected model endpoint (necessary coding context), and Telegram (owner notifications/decisions). Container image/package downloads during owner-managed preparation also contact their registries. No product analytics or telemetry is intended; that does not mean zero network traffic, zero provider retention or a complete dependency egress audit.

Notifications should contain the minimum useful summary. Keep full patches and sensitive test output in private state. A bot message is not an appropriate destination for secrets. Never promise provider zero retention without verifying the selected account's terms, controls and logging configuration.

## Operational rules

Run under a dedicated account with a private state directory. Keep tokens out of command arguments, repository files, screenshots, issue reports and public artifacts. Use narrowly scoped credentials and an approved refresh mechanism. A static short-lived Bedrock token cannot support indefinite operation on its own.

Set finite step, token, wall-clock, repair, patch-size and changed-file limits. If dollar budgets are used, configure current prices explicitly; estimates may omit billing features and are not a hard AWS account spending cap.

Checks are independently executed commands configured by the owner. Passing checks does not prove correctness, absence of malicious behavior or suitability to merge. Human approval remains necessary before pushing; merging remains outside this workflow.

## Incident response

Stop the service, retain private evidence, and revoke affected credentials if exposure is plausible. Inspect the remote branch before any retry following an uncertain publication. Restore state only with the service stopped. Do not post credential-bearing logs publicly; report a redacted reproduction through a channel approved by the repository owner.

## Verification policy and remaining limits

Checks run in a fresh materialization of the staged Git tree. Ignored files left in the agent workspace cannot supply missing modules to those checks. Candidate preparation checks the resulting tree again before freezing its commit. Existing common test paths and build/test manifests (including `package.json` and `pyproject.toml`) are protected against modification or deletion; repository `protectedPaths` glob patterns extend that policy. New test files are allowed. Work that requires changing existing protected tests/manifests is blocked for manual handling, not silently exempted.

Path-based protection cannot prove test semantics. Checks can depend on unprotected helpers, code can detect test execution, and newly added files can change behavior. Configure additional protected paths and trusted external checks for your repository. Passing this policy is not proof that the agent preserved the strength of the tests.

Before model dispatch, usage is conservatively reserved in durable state. Valid responses settle that reservation; unknown outcomes retain it. Retries and owner revisions share the original budget group, including late usage from superseded calls. Retained reservations can overestimate actual charges; consult the provider bill rather than deleting state to reset the limit.

The CLI checks rootless runtime availability before starting and the execution adapter checks it before commands. Startup cleanup is scoped to managed containers labeled for the configured state directory. A real container isolation/recovery pilot has not been established by fixture tests; deployment validation remains necessary.
