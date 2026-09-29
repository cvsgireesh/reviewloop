export interface RepositoryConfig {
  name: string;
  checks: string[];
  image?: string;
  protectedPaths?: string[];
  authors?: string[];
  pullRequests?: number[];
}
export interface Config {
  github: {
    apiUrl: string;
    tokenEnv: string;
    username: string;
    repositories: RepositoryConfig[];
    pollSeconds: number;
  };
  model: {
    provider: "bedrock" | "openai-compatible";
    modelId: string;
    region: string;
    tokenEnv: string;
    baseUrl?: string;
    maxOutputTokens: number;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
  };
  telegram: { tokenEnv: string; chatId: string; userId: string };
  runtime: {
    stateDir: string;
    sandbox: "podman" | "docker" | "unsafe-local";
    image: string;
    maxJobMinutes: number;
    maxSteps: number;
    maxRepairAttempts: number;
    maxToolOutputBytes: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxTotalInputTokens?: number;
    maxTotalOutputTokens?: number;
    maxCostUsd?: number;
    maxTotalCostUsd?: number;
    approvalHours: number;
    maxChangedFiles: number;
    maxPatchBytes: number;
  };
}
export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorId: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  headRepo: string;
  state: string;
  feedback: string;
  fingerprint: string;
}
export type JobStatus =
  | "queued"
  | "running"
  | "verifying"
  | "awaiting_approval"
  | "approved"
  | "publishing"
  | "published"
  | "blocked"
  | "stale"
  | "rejected"
  | "no_change";
export interface Job {
  id: string;
  repo: string;
  pr: number;
  snapshot: PullRequest;
  status: JobStatus;
  feedback: string;
  createdAt: string;
  updatedAt: string;
  candidateSha?: string;
  patchHash?: string;
  summary?: string;
  evidence?: CheckResult[];
  error?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  approvalNonce?: string;
  approvalExpiresAt?: string;
  telegramMessageId?: number;
  attempts: number;
  policyHash?: string;
  budgetGroup?: string;
}
export interface CheckResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
}
export type Content =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };
export interface Message {
  role: "user" | "assistant";
  content: Content[];
}
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ModelReply {
  content: Content[];
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
}
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}
export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelReply>;
}
export interface HarnessInput {
  workspace: string;
  task: string;
  preferences: string[];
  priorSummaries: string[];
  config: Config;
  signal?: AbortSignal;
  onUsage: (inputTokens: number, outputTokens: number) => void;
  beforeCall: (estimatedInputTokens: number, maxOutputTokens: number) => void;
  onEvent: (event: string, detail: Record<string, unknown>) => void;
}
export interface HarnessResult {
  summary: string;
  steps: number;
}
export interface Sandbox {
  run(
    workspace: string,
    command: string,
    options?: { image?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CheckResult>;
  doctor(): Promise<string[]>;
}
export interface Decision {
  action:
    | "approve"
    | "reject"
    | "revise"
    | "remember"
    | "forget"
    | "status"
    | "pause"
    | "resume";
  jobId?: string;
  nonce?: string;
  text?: string;
  messageId?: number;
  updateId: number;
}
export interface NotificationReceipt {
  messageId: number;
  messageIds?: number[];
}
