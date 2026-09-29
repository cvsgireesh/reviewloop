import test from "node:test";
import assert from "node:assert/strict";
import { Telegram } from "../src/telegram.js";
import type { Job } from "../src/types.js";
process.env.TEST_TELEGRAM_TOKEN = "SECRET_TOKEN";
const config = { tokenEnv: "TEST_TELEGRAM_TOKEN", chatId: "10", userId: "20" };
const user = { id: 20, is_bot: false };
const message = { message_id: 9, chat: { id: 10 }, from: user };
function fixture(updates: any[] = []) {
  const calls: {
    method: string;
    body: any;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const fetcher = (async (url: string, options: RequestInit) => {
    const method = url.split("/").at(-1)!;
    calls.push({
      method,
      body: JSON.parse(options.body as string),
      signal: options.signal,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        result:
          method === "getUpdates"
            ? updates
            : method === "sendMessage"
              ? { message_id: calls.length }
              : true,
      }),
    );
  }) as typeof fetch;
  return { telegram: new Telegram(config, fetcher), calls };
}
test("both owner identities required, bot and channel spoof rejected; offset advances", async () => {
  const updates = [
    {
      update_id: 1,
      message: { ...message, text: "/pause", from: { id: 21, is_bot: false } },
    },
    { update_id: 2, message: { ...message, text: "/pause", chat: { id: 11 } } },
    {
      update_id: 3,
      message: { ...message, text: "/pause", from: { ...user, is_bot: true } },
    },
    {
      update_id: 4,
      message: { ...message, text: "/pause", sender_chat: { id: 10 } },
    },
    { update_id: 5, message: { ...message, text: "/pause" } },
    { update_id: 6, message: { ...message, text: "/garbage" } },
  ];
  const { telegram } = fixture(updates);
  const result = await telegram.poll(0);
  assert.deepEqual(result, {
    decisions: [{ action: "pause", updateId: 5 }],
    nextOffset: 7,
  });
});
test("callbacks exact parsed and bind nonce job message; old updates skipped", async () => {
  const callback = {
    id: "callback",
    from: user,
    message,
    data: "approve:job1:nonce1",
  };
  const { telegram, calls } = fixture([
    { update_id: 0, callback_query: callback },
    { update_id: 1, callback_query: callback },
    {
      update_id: 2,
      callback_query: { ...callback, data: "approve:job1:nonce1\n" },
    },
    {
      update_id: 3,
      callback_query: { ...callback, from: { id: 99, is_bot: false } },
    },
  ]);
  const result = await telegram.poll(1);
  assert.deepEqual(result.decisions, [
    {
      action: "approve",
      jobId: "job1",
      nonce: "nonce1",
      messageId: 9,
      updateId: 1,
    },
  ]);
  assert.equal(result.nextOffset, 4);
  assert.equal(
    calls.filter((c) => c.method === "answerCallbackQuery").length,
    2,
  );
  assert.equal(calls[0]!.body.timeout, 25);
});
test("typed replies are revisions, never approval; explicit revision and memory commands parse", async () => {
  const texts = [
    "yes",
    "okay",
    "/approve job1",
    "/revise job1 add tests",
    "/remember use tabs",
    "/forget pref1",
    "/status",
    "/resume",
  ];
  const { telegram } = fixture(
    texts.map((text, i) => ({
      update_id: i,
      message: { ...message, text, reply_to_message: { message_id: 123 } },
    })),
  );
  const { decisions } = await telegram.poll(0);
  assert.equal(
    decisions.some((d) => d.action === "approve"),
    false,
  );
  assert.deepEqual(decisions[0], {
    action: "revise",
    text: "yes",
    messageId: 123,
    updateId: 0,
  });
  assert.deepEqual(
    decisions.find((d) => d.jobId === "job1"),
    {
      action: "revise",
      jobId: "job1",
      text: "add tests",
      messageId: 123,
      updateId: 3,
    },
  );
  assert.equal(decisions.length, 7);
});
test("splits plain text, last message carries valid buttons and receipt", async () => {
  const { telegram, calls } = fixture();
  const receipt = await telegram.send(
    { id: "job1", approvalNonce: "nonce1" } as Job,
    "*text*".repeat(2000),
    true,
  );
  assert.equal(calls.length, 3);
  assert.equal(receipt.messageId, 3);
  assert.deepEqual(receipt.messageIds, [1, 2, 3]);
  for (const call of calls) {
    assert.ok(call.body.text.length <= 4096);
    assert.equal(call.body.parse_mode, undefined);
    assert.ok(call.signal);
  }
  assert.equal(calls[0]!.body.reply_markup, undefined);
  assert.equal(
    calls[2]!.body.reply_markup.inline_keyboard[0][0].callback_data,
    "approve:job1:nonce1",
  );
  await assert.rejects(
    telegram.send(
      { id: "j".repeat(64), approvalNonce: "x" } as Job,
      "test",
      true,
    ),
    /oversized/,
  );
});
test("HTTP and provider failures redacted, cancellation passed through", async () => {
  for (const fetcher of [
    async () => new Response("no", { status: 429 }),
    async () =>
      new Response(JSON.stringify({ ok: false, description: "SECRET_TOKEN" })),
    async () => {
      throw new Error("https://api.telegram.org/botSECRET_TOKEN");
    },
  ]) {
    const api = new Telegram(config, fetcher as typeof fetch);
    await assert.rejects(
      api.notify("hello"),
      (error) =>
        error instanceof Error &&
        /Telegram/.test(error.message) &&
        !error.message.includes("SECRET_TOKEN"),
    );
  }
  const controller = new AbortController();
  controller.abort();
  const api = new Telegram(config, (async (_url, options) => {
    options?.signal?.throwIfAborted();
    throw new Error("unexpected");
  }) as typeof fetch);
  await assert.rejects(api.poll(0, controller.signal), /cancelled/);
});
test("notification receipts include each chunk and typed replies preserve first or final chunk binding", async () => {
  const { telegram } = fixture();
  const receipt = await telegram.notify("x".repeat(5000));
  assert.deepEqual(receipt, { messageId: 2, messageIds: [1, 2] });
  const { telegram: receiver } = fixture(
    receipt.messageIds!.map((id, index) => ({
      update_id: 10 + index,
      message: {
        ...message,
        text: "Please explain this part",
        reply_to_message: { message_id: id },
      },
    })),
  );
  const { decisions } = await receiver.poll(0);
  assert.deepEqual(
    decisions.map((d) => [d.action, d.messageId]),
    [
      ["revise", 1],
      ["revise", 2],
    ],
  );
});
