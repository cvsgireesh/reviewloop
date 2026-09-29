# Operations

Use a dedicated Linux account and private directory for configuration, secrets and durable state. Install Node 24+, Git and rootless Podman (or explicitly configured rootless Docker) through your approved tooling. Have the owner prepare and load an image containing `/bin/sh`, GNU `/usr/bin/timeout`, and each repository's dependencies. ReviewLoop uses the configured image; it does not bootstrap dependencies from untrusted PR instructions.

## Credentials and first start

1. Create the configuration with `reviewloop init --config /absolute/private/reviewloop.json` and edit it. Resolve the actual authorized GitHub account; do not substitute a bot's identity for the owner.
2. Provide a GitHub token with only the repository access needed to read PRs and push approved branch changes. The authenticated user must have repository admin or maintain permissions: discovery checks this to enforce the initial controlled-repository scope. This does not mean the token needs every administrative scope. Organization restrictions may require approval; merging is outside the workflow.
3. Provide the configured Bedrock credential. A bearer API key belongs in `AWS_BEARER_TOKEN_BEDROCK` when that is the configured variable. IAM access-key pairs/session credentials are a different authentication mode; do not paste one into a bearer-token field. Confirm account/model access and token renewal before a continuous run.
4. Configure a Telegram bot and the exact owner/chat IDs below. Do not expose company code or secrets through notification text.
5. Set private file permissions (`chmod 600` for the filled environment/config files), load the environment through your approved secret manager or service environment, then run `doctor`. By default this checks local configuration, credential presence and runtime/image availability. `doctor --live` additionally checks GitHub identity and Telegram bot identity; it does not invoke the model, send messages, pull images or prove repository/push permissions. A successful configuration check does not prove service permissions or model inference work.
6. Run `run --once` only when ready for real API/model activity. Inspect the resulting job and evidence before enabling continuous operation.

The defaults `us-east-2` and `us.anthropic.claude-sonnet-5` are documented by AWS, but account access and regional policy remain deployment checks. The profile can route within US and Canada. Short-term bearer keys expire within 12 hours or their underlying session; renewal requires authorized source credentials. [Model](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html), [API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).

## Telegram setup

Create a bot through the official [BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token), save its token privately, and start a direct chat with that bot. Only the configured numeric owner ID and chat ID should be accepted. A username/display name is not a durable authorization identity.

Retrieve your own initial update using [getUpdates](https://core.telegram.org/bots/api#getupdates) from a private setup process. Stop other pollers while doing this; polling offsets and webhooks can interfere. The following optional local setup snippet reads the token from the environment and prints only numeric sender/chat IDs. It neither sends a message nor prints the credential-bearing URL; errors are intentionally generic.

```sh
node --input-type=module <<'JS'
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('Telegram token missing'); process.exit(1); }
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error();
  for (const update of data.result) {
    const message = update.message;
    if (message?.from && message?.chat) {
      console.log(JSON.stringify({ userId: message.from.id, chatId: message.chat.id }));
    }
  }
} catch { console.error('Could not retrieve Telegram IDs'); process.exitCode = 1; }
JS
```

Choose the update corresponding to your own message. Never publish a full update payload, token, or environment dump. ReviewLoop uses outbound HTTPS and long polling, so the notification adapter does not need a public inbound webhook port. Ordinary bot conversations pass through Telegram; treat its service as a data recipient, not an end-to-end encrypted secret channel.

### Decisions from Telegram

Pending candidates carry Approve and Reject buttons. A button acknowledgement means the decision was received for validation, not that a push succeeded. Use `/revise JOB_ID your requested change` or reply in plain text to the job notification to request a revision. Plain replies never count as approval. `/remember TEXT` and `/forget ID` manage owner preferences; `/status`, `/pause`, and `/resume` address the supervisor. Repository-scoped preferences are available through the CLI.

## Daily operation

The default configuration path is `./reviewloop.json`, relative to the current directory. Use the same explicit `--config /absolute/path/reviewloop.json` for every command. Run `reviewloop --help` for supported command arguments.

| Command                                    | Purpose                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `status` / `jobs`                          | Supervisor state and durable job list                                        |
| `show JOB_ID`                              | Candidate, checks, current status and failure evidence                       |
| `events [JOB_ID]`                          | Recent local audit records                                                   |
| `retry JOB_ID`                             | With the supervisor stopped, queue a blocked job using its remaining budgets |
| `preferences add TEXT [--repo owner/repo]` | Store an owner preference, optionally repository-scoped                      |
| `preferences list` / `forget ID`           | Inspect or remove stored preferences                                         |
| `pause` / `resume`                         | Control new work through the supervisor                                      |

Approval and rejection are through the authenticated Telegram buttons; there are no `approve` or `reject` CLI commands. Treat an approval nonce as private decision material. Approve only after reviewing the notification's trigger, changes, checks, uncertainty and exact requested action. If the head/feedback/config changes, inspect the replacement candidate; do not attempt to revive an obsolete approval. Typed revision requests are input for a new attempt, not authorization to push it.

For an immediate operational stop, stop the service. A pause command is not a substitute for terminating an active process during an incident. Do not edit the state database while a supervisor is running. The CLI takes a single-supervisor lock per state directory. `retry` requires the supervisor to be stopped; normal local inspection, preferences and pause/resume remain available. Startup attempts cleanup of managed containers labeled for that state directory before recovering jobs. It does not delete containers belonging to other state directories.

## Linux user service

Copy [the template](../scripts/reviewloop.service.example) into `~/.config/systemd/user/reviewloop.service`. Replace all absolute-path placeholders, including the executable path (`command -v reviewloop`), private config and environment file. Ensure the user service can find Git and Podman; interactive shell profiles may not run under systemd.

```sh
systemctl --user daemon-reload
systemctl --user enable --now reviewloop.service
systemctl --user status reviewloop.service
journalctl --user -u reviewloop.service -n 100 --no-pager
```

Stopping: `systemctl --user stop reviewloop.service`. Restarting after a reviewed configuration change: `systemctl --user restart reviewloop.service`. Whether a user service survives logout depends on host policy; ask the host administrator about user lingering if needed. The template does not change it or request elevated access.

Container execution uses parent-side deadlines, a GNU `timeout` entrypoint and, for Podman, a runtime timeout. These controls and startup cleanup are implemented; actual rootless execution and crash cleanup still require validation on the deployment host. Images need all build/test dependencies prepared by the owner because container networking and automatic image pulls are disabled.

## Diagnose and recover

| Symptom                            | Next action                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No eligible PRs                    | Check configured username/repositories, PR author and open status; inspect GitHub permission errors.                                                                  |
| Image/runtime error                | Check rootless runtime availability and the exact preloaded image; do not switch to `unsafe-local` for production.                                                    |
| Protected test/manifest change     | Inspect the proposed change and handle it manually. Extend `protectedPaths` for repository-specific test helpers; do not remove protections just to get green checks. |
| Test failure                       | Read check output and agent summary. Correct approved check/dependency configuration or request a revision.                                                           |
| Bedrock authentication/model error | Check token type, expiry/renewal, region, account entitlement and model ID. No silent alternate provider should be used.                                              |
| Telegram failure                   | Inspect durable notification/job state; check token and numeric owner/chat configuration, network and competing pollers.                                              |
| Stale candidate                    | Fetch the current state through the normal controller and prepare new evidence/approval.                                                                              |
| Uncertain push                     | Inspect the remote branch and job state before retrying; never blindly force-push a fresh candidate.                                                                  |
| Budget exhaustion                  | Inspect recorded usage and bounds. Increase limits only deliberately; estimated cost is not the authoritative bill.                                                   |

State may contain code excerpts, feedback, model transcripts, preferences and test output. Stop the service before a consistent backup, and protect backups like source code. Retention/deletion is an owner operation; do not assume logs expire automatically. Inspect logs locally before sharing and redact credentials and private content.

## Verification boundaries

CI runs type checks, deterministic tests and a build without real credentials. A deployment needs separate approved tests of Bedrock authentication/renewal, GitHub permissions, Telegram delivery/owner decisions, real rootless container isolation and crash recovery. Do not describe those as verified merely because unit tests pass.

### Optional monitoring scope

Without scope fields, each configured repository monitors all open PRs authored by the authenticated GitHub user, matched by immutable user ID. To explicitly monitor selected authors and PR numbers, add these optional fields to its repository entry:

```json
{
  "name": "YOUR_OWNER/YOUR_REPO",
  "checks": ["npm test"],
  "authors": ["YOUR_GITHUB_LOGIN", "COLLABORATOR_LOGIN"],
  "pullRequests": [12, 34]
}
```

Both filters apply when both are provided. Omit `pullRequests` to include every open PR by eligible authors; omit `authors` to retain the authenticated-user default. Explicit author logins match case-insensitively. Empty lists are invalid. The authenticated controller must still match `github.username` and have admin or maintain repository permission. Selecting another author does not grant permission to push an inaccessible fork or let feedback change policy. Changes to scope invalidate existing approvals through the configuration policy hash.

## Qualify the real sandbox before inference

After building, run this explicit local qualification with your configured rootless runtime and preloaded image:

```sh
npm run test:sandbox-live -- --config /absolute/private/reviewloop.json
```

Or run `node scripts/check-sandbox.mjs --config /absolute/private/reviewloop.json` after `npm run build`. `--help` works before building. The image needs `/bin/sh`, GNU `/usr/bin/timeout`, `awk`, `id`, and `sleep` as well as repository dependencies.

The command rejects `unsafe-local` and rootful runtimes. It creates a disposable workspace and unique container-label scope, checks that a randomly generated parent environment secret is absent, the workspace is writable, the root mount is read-only, the Git sentinel and common host engine sockets are inaccessible, only the loopback network interface exists, and execution uses the expected namespace UID with no effective capabilities. Podman uses the host UID with keep-id; verified rootless Docker intentionally uses namespace UID 0 mapped to the host owner. Rootless runtime verification is required in both cases. It then runs a real timeout probe and confirms scoped cleanup. An unavailable network assertion fails rather than silently skipping. It never pulls images, invokes a model, contacts GitHub/Telegram, or uses the production state scope.

Only an actual successful run qualifies that runtime/image for these checks. Syntax/help checks do not. The current development host's rootful Docker cannot qualify; use the intended rootless Linux lab deployment. Passing is not a kernel-isolation audit or proof against every container escape. Probe failures use numeric exit codes: 11 environment, 12 Git mask, 13 engine socket, 14 read-only root, 15–16 network, 17 namespace UID/effective capabilities; missing image tools may fail separately.

Pilot-wide input/output limits default to 1,500,000/120,000 tokens across all jobs and retained reservations (`maxTotalInputTokens`, `maxTotalOutputTokens`). Per-job limits default to 300,000/24,000 tokens and revisions share that budget. These are configurable safety ceilings, not permission to incur charges. Dollar enforcement additionally requires owner-supplied prices and caps.
