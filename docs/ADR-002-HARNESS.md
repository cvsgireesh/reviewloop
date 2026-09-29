# ADR 002: reuse Pi's agent loop and Codex's native patch engine

Status: selected for the current implementation; live model and Linux sandbox qualification remain separate acceptance gates.

ReviewLoop needs a coding loop with registered tools, bounded provider calls and observable events. Reimplementing that machinery adds maintenance and failure modes. Use pinned Pi Agent core 0.99.1, preserving ReviewLoop's AWS transport through a stream adapter. Keep GitHub monitoring, durable job accounting, preferences, verification, Telegram approval and the exact-commit publisher outside the model-controlled loop.

Commands continue through ReviewLoop's rootless Sandbox. Register only confined tools; do not import a default host-shell tool. Provider calls must reserve budget before dispatch, settle valid usage, retain uncertain charges and honor cancellation. Retries and any future compaction must obey those same rules. Upstream event hooks are observability, not authority to publish.

For patches, call the official Codex 0.159.0 native `--codex-run-as-apply-patch` engine through Sandbox.run. ReviewLoop validates every Add/Update/Delete/Move destination, rejects traversal, `.git`, symlinks and hardlinked targets, bounds the patch and shell transport, and quotes the patch as one literal argument. It does not implement patch-body matching or fall back to host application. Sandbox checks are still essential: host path inspection alone is not a race-proof security boundary. Commands and patch tools must not run concurrently against the same workspace.

The internal Codex ABI is not a stable public SDK. The worker checks exact `codex-cli 0.159.0` before invocation and fails closed on mismatch. A failed multi-file patch may leave partial edits; the controller must still verify the final tree before presenting it for approval. Patch success never authorizes a push.

## Worker image

An owner may build the provided baseline explicitly:

```sh
podman build -f containers/Containerfile -t localhost/reviewloop-worker:0.2.0 .
```

This build downloads Node's base image and the pinned public Codex package. ReviewLoop never builds or pulls it automatically. Add repository-specific test dependencies explicitly, then run the live sandbox qualification before inference. The Node 24 base tag is mutable; deployments requiring reproducibility should pin a reviewed image digest. The baseline does not supply every repository's test dependencies. Both Podman and Docker execution require verified rootless mode.

## Alternatives checked

DeepSeek Harness 0.2.0-rc.2 is genuinely composable: its loop can run with custom guarded tools, and its Pi adapter supports Bedrock. Rejecting it merely because a default profile exposes an unrestricted shell would be incorrect. We selected direct Pi because the required in-process boundary is smaller than adopting Cordis service composition and another session/runtime layer. Its prerelease package versions also require a coherent pinned closure.

Codex's full TypeScript SDK wraps the Codex CLI. Codex documents Bedrock support for supported OpenAI models through the Responses API; that does not establish compatibility with ReviewLoop's requested Anthropic model through Bedrock Converse. Adopting the full runtime would require changing that model choice or qualifying a protocol bridge. The independent native patch engine is useful without that migration. Pi also has a native Bedrock adapter, but retaining the existing AWS transport initially preserves current budget and request-boundary tests.

Exact versions, licenses and primary source links are in [REUSE.md](REUSE.md). Pi is MIT; Codex is Apache-2.0. No quality parity is claimed: representative real coding evaluations, model/provider qualification and Linux isolation checks are still required.

## Verification

The official Codex 0.159.0 package was installed into a disposable test prefix. Trusted fixtures exercised real add/update/move/delete operations and literal shell syntax with explicitly authorized unsafe-local execution. Guard tests reject escape paths, symlinks and hardlinks before execution; a wrong version refuses patch application. The native contract test is opt-in through `REVIEWLOOP_CODEX_TEST_BIN` pointing to the installed CLI's bin directory; ordinary tests never download binaries. This does not qualify the container image or claim host isolation for those local fixture runs.
