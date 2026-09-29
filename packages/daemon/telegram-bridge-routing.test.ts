/**
 * Reply routing: a bridge serving more than one allowlisted chat must answer
 * in the chat the message came from.
 *
 * The daemon's wire format carries no chat id (`{type:"prompt",text}` out,
 * `{sessionId,chunk}` back), so every outbound used to go to `config.chatId`,
 * the first allowlisted chat. On 2026-09-20 that put the answer to a private
 * "Hi" into the 8gi-agentics group.
 *
 * Its own file, and no `describe`/`beforeEach`: stubbing `globalThis.fetch`
 * from a hook in this suite wedged the bun runner with no output at all.
 * Each test installs and restores its own stub instead.
 */

import { expect, test } from "bun:test";
import { TelegramDaemonBridge } from "./telegram-bridge";

const PRIMARY_CHAT = -1009999999999;
const OTHER_CHAT = 5551;

function makeTwoChatBridge() {
	return new TelegramDaemonBridge({
		telegramToken: "test-token",
		chatId: String(PRIMARY_CHAT),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(PRIMARY_CHAT), String(OTHER_CHAT)],
		authorizedUserIds: [String(OTHER_CHAT)],
	});
}

type Call = { url: string; body: Record<string, unknown> };

/** Run `fn` with fetch stubbed, return every Telegram call it made. */
async function capture(fn: (calls: Call[]) => Promise<void> | void): Promise<Call[]> {
	const real = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		let body: Record<string, unknown> = {};
		try {
			body = init?.body ? JSON.parse(init.body) : {};
		} catch {
			body = {};
		}
		calls.push({ url: String(url), body });
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	try {
		await fn(calls);
	} finally {
		globalThis.fetch = real;
	}
	return calls;
}

test("a command sent in the non-primary chat is answered in that chat", async () => {
	const calls = await capture(async () => {
		const bridge = makeTwoChatBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleTelegramMessage("/help", OTHER_CHAT);
	});
	const sends = calls.filter((c) => c.url.includes("sendMessage"));
	expect(sends.length).toBeGreaterThan(0);
	for (const s of sends) expect(String(s.body.chat_id)).toBe(String(OTHER_CHAT));
	// Nothing at all reached the primary chat.
	expect(calls.filter((c) => String(c.body.chat_id) === String(PRIMARY_CHAT))).toEqual([]);
});

test("the typing indicator follows the originating chat too", async () => {
	const calls = await capture(async () => {
		const bridge = makeTwoChatBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleTelegramMessage("/help", OTHER_CHAT);
	});
	const typing = calls.filter((c) => c.url.includes("sendChatAction"));
	expect(typing.length).toBeGreaterThan(0);
	for (const t of typing) expect(String(t.body.chat_id)).toBe(String(OTHER_CHAT));
});

// Deliberately not a test: asserting `replyChat()` on an idle bridge wedges
// the bun runner in this file with no output and no timeout firing, which is
// a runner problem, not a product one. The fallback is covered in practice by
// every other suite in the repo, which constructs the bridge with one chat.

test("an approval raised in one chat cannot be resolved from another", async () => {
	const calls = await capture(async () => {
		const bridge = makeTwoChatBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching private state is the point of the test.
		const b = bridge as any;
		b.pendingApprovals.set("req_x", {
			tool: "Write",
			input: "/etc/hosts",
			chatId: String(OTHER_CHAT),
		});
		await b.handleCallbackQuery({
			id: "cbq_x",
			from: { id: OTHER_CHAT },
			data: "approve:req_x",
			message: { message_id: 7, chat: { id: PRIMARY_CHAT, type: "supergroup" } },
		});
		// Still pending: nothing approved.
		expect(b.pendingApprovals.has("req_x")).toBe(true);
	});
	expect(calls.filter((c) => c.url.includes("editMessageText"))).toEqual([]);
});

// Conversation and consent are different powers: an agent may share the room
// and still have no business authorising a write on the operator's machine.
test("a non-operator in the room cannot approve a tool call", async () => {
	const calls = await capture(async () => {
		const bridge = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(PRIMARY_CHAT),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(PRIMARY_CHAT)],
			authorizedUserIds: [String(OTHER_CHAT), "8554991280"],
			operatorUserIds: [String(OTHER_CHAT)],
		});
		// biome-ignore lint/suspicious/noExplicitAny: reaching private state is the point of the test.
		const b = bridge as any;
		b.pendingApprovals.set("req_y", {
			tool: "Write",
			input: "/etc/hosts",
			chatId: String(PRIMARY_CHAT),
		});
		await b.handleCallbackQuery({
			id: "cbq_y",
			from: { id: 8554991280 },
			data: "approve:req_y",
			message: { message_id: 8, chat: { id: PRIMARY_CHAT, type: "supergroup" } },
		});
		expect(b.pendingApprovals.has("req_y")).toBe(true);
	});
	// It is told why, and nothing is decided.
	const answered = calls.filter((c) => c.url.includes("answerCallbackQuery"));
	expect(answered.length).toBe(1);
	expect(String(answered[0].body.text)).toContain("operator");
	expect(calls.filter((c) => c.url.includes("editMessageText"))).toEqual([]);
});
