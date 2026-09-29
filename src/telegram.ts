import type { Config, Decision, Job, NotificationReceipt } from "./types.js";

type TelegramUser = { id?: number; is_bot?: boolean };
type TelegramMessage = {
  message_id?: number;
  text?: string;
  from?: TelegramUser;
  sender_chat?: unknown;
  chat?: { id?: number };
  reply_to_message?: { message_id?: number };
};
type Update = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: {
    id?: string;
    from?: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
};
const identifier = "[A-Za-z0-9_-]+";
export class Telegram {
  private token: string;
  constructor(
    private config: Config["telegram"],
    private fetcher: typeof fetch = fetch,
  ) {
    this.token = process.env[config.tokenEnv] ?? "";
    if (!this.token)
      throw new Error(
        `Missing Telegram token environment variable ${config.tokenEnv}`,
      );
  }
  private async call(
    method: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<any> {
    const timeout = AbortSignal.timeout(30_000);
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        result?: unknown;
      };
      if (payload.ok !== true || payload.result === undefined)
        throw new Error("Provider rejected request");
      return payload.result;
    } catch {
      // Provider errors and fetch errors can contain a URL with the bot token.
      throw new Error(
        signal?.aborted
          ? "Telegram request cancelled"
          : `Telegram ${method} failed (network, timeout, or provider error)`,
      );
    }
  }
  private async sendText(
    text: string,
    markup?: object,
  ): Promise<NotificationReceipt> {
    const chunks: string[] = [];
    let remaining = text || "(empty notification)";
    while (remaining.length) {
      let end = Math.min(4096, remaining.length);
      if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!))
        end--;
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    const messageIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const sent = await this.call("sendMessage", {
        chat_id: this.config.chatId,
        text: chunks[i],
        ...(i === chunks.length - 1 && markup ? { reply_markup: markup } : {}),
      });
      if (!Number.isSafeInteger(sent?.message_id))
        throw new Error("Telegram returned invalid message receipt");
      messageIds.push(sent.message_id);
    }
    return { messageId: messageIds.at(-1)!, messageIds };
  }
  async send(
    job: Job,
    text: string,
    buttons = false,
  ): Promise<NotificationReceipt> {
    let markup: object | undefined;
    if (buttons) {
      if (!job.approvalNonce) throw new Error("Approval nonce required");
      const callbacks = ["approve", "reject"].map(
        (action) => `${action}:${job.id}:${job.approvalNonce}`,
      );
      if (
        callbacks.some(
          (data) =>
            Buffer.byteLength(data) > 64 ||
            !new RegExp(
              `^(approve|reject):${identifier}:${identifier}$(?![\\s\\S])`,
            ).test(data),
        )
      )
        throw new Error("Invalid or oversized approval callback");
      markup = {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: callbacks[0] },
            { text: "Reject", callback_data: callbacks[1] },
          ],
        ],
      };
    }
    return this.sendText(text, markup);
  }
  async notify(text: string): Promise<NotificationReceipt> {
    return this.sendText(text);
  }
  private authorized(
    user: TelegramUser | undefined,
    message: TelegramMessage | undefined,
  ): boolean {
    return (
      !!user &&
      user.is_bot === false &&
      String(user.id) === this.config.userId &&
      !!message &&
      !message.sender_chat &&
      String(message.chat?.id) === this.config.chatId
    );
  }
  async poll(
    offset: number,
    signal?: AbortSignal,
  ): Promise<{ decisions: Decision[]; nextOffset: number }> {
    const updates = (await this.call(
      "getUpdates",
      { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
      signal,
    )) as Update[];
    if (!Array.isArray(updates))
      throw new Error("Telegram returned invalid updates");
    const decisions: Decision[] = [];
    let nextOffset = offset;
    for (const update of updates) {
      if (!Number.isSafeInteger(update?.update_id) || update.update_id! < 0)
        throw new Error("Telegram returned invalid update ID");
      if (update.update_id! < offset) continue;
      nextOffset = Math.max(nextOffset, update.update_id! + 1);
      const updateId = update.update_id!;
      const callback = update.callback_query;
      if (callback) {
        if (!this.authorized(callback.from, callback.message)) continue;
        const match = new RegExp(
          `^(approve|reject):(${identifier}):(${identifier})$(?![\\s\\S])`,
        ).exec(callback.data ?? "");
        if (match)
          decisions.push({
            action: match[1] as "approve" | "reject",
            jobId: match[2],
            nonce: match[3],
            messageId: callback.message?.message_id,
            updateId,
          });
        // An acknowledgement is cosmetic; failure must not discard already parsed decisions.
        if (callback.id)
          await this.call(
            "answerCallbackQuery",
            {
              callback_query_id: callback.id,
              text: match
                ? "Decision received for validation"
                : "Invalid action",
            },
            signal,
          ).catch(() => undefined);
        continue;
      }
      const message = update.message;
      if (
        !this.authorized(message?.from, message) ||
        typeof message?.text !== "string"
      )
        continue;
      const text = message.text.trim();
      const command =
        /^\/(remember|forget|status|pause|resume|revise)(?:\s+([\s\S]+))?$/.exec(
          text,
        );
      const messageId = message.reply_to_message?.message_id;
      if (command) {
        const action = command[1] as Decision["action"];
        const rest = command[2]?.trim();
        if (action === "revise") {
          const revision = new RegExp(`^(${identifier})\\s+([\\s\\S]+)$`).exec(
            rest ?? "",
          );
          if (revision)
            decisions.push({
              action,
              jobId: revision[1],
              text: revision[2]!.trim(),
              updateId,
              messageId,
            });
        } else if (action === "remember" || action === "forget") {
          if (rest) decisions.push({ action, text: rest, updateId });
        } else if (!rest) decisions.push({ action, updateId });
      } else if (messageId !== undefined && text && !text.startsWith("/")) {
        // Plain replies are revision requests only, never approvals.
        decisions.push({ action: "revise", text, messageId, updateId });
      }
    }
    return { decisions, nextOffset };
  }
}
