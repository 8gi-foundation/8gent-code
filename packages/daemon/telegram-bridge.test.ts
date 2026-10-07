/**
 * Telegram bridge authorization tests.
 *
 * The bridge's chat-id allowlist is the reason `telegram` is trusted with full
 * dispatch capabilities in packages/permissions/dispatch-policy.ts. That
 * argument is only as good as the coverage of the allowlist, so these tests
 * pin the path that had none: inline-keyboard callbacks.
 *
 * Callback queries carry no `update.message`, so the poll loop's check reads
 * `update.message?.chat?.id` as undefined and does not fire, and
 * handleTelegramMessage never sees them. Buttons approve permission prompts
 * and cancel running tasks, so an unchecked button path is an unchecked
 * control path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TelegramDaemonBridge } from "./telegram-bridge";

const AUTHORIZED_CHAT = 123456;
const FOREIGN_CHAT = 999999;

function makeBridge() {
	return new TelegramDaemonBridge({
		telegramToken: "test-token",
		chatId: String(AUTHORIZED_CHAT),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(AUTHORIZED_CHAT)],
	});
}

/** A callback query as Telegram delivers it, from a given chat. */
function callbackFrom(chatId: number | undefined) {
	return {
		id: "cbq_1",
		from: { id: chatId ?? 0 },
		data: "approve:req_1",
		message: chatId === undefined ? undefined : { message_id: 42, chat: { id: chatId } },
	};
}

describe("handleCallbackQuery authorization", () => {
	const realFetch = globalThis.fetch;
	let calls: string[] = [];

	beforeEach(() => {
		calls = [];
		// Every outbound Telegram API action goes through fetch, so counting
		// fetches is a direct measure of "did this callback cause a side effect".
		globalThis.fetch = (async (url: unknown) => {
			calls.push(String(url));
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a callback from a foreign chat produces no side effect at all", async () => {
		const bridge = makeBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(callbackFrom(FOREIGN_CHAT));
		// Not even answerCallbackQuery. The rejection happens before the bridge
		// tells the caller their tap was received.
		expect(calls).toEqual([]);
	});

	test("a callback with no originating chat is rejected, not trusted", async () => {
		const bridge = makeBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(callbackFrom(undefined));
		expect(calls).toEqual([]);
	});

	test("a callback from the allowlisted chat is still processed", async () => {
		const bridge = makeBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(callbackFrom(AUTHORIZED_CHAT));
		// The handler answers the callback to clear the client-side spinner
		// before it looks up the pending approval. Seeing that call is how we
		// know the check let the real operator through rather than blocking
		// everyone equally.
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]).toContain("answerCallbackQuery");
	});

	test("an unknown requestId from the allowlisted chat resolves nothing", async () => {
		const bridge = makeBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(callbackFrom(AUTHORIZED_CHAT));
		// Only the spinner-clearing call. No editMessageText, because there was
		// no pending approval under that id to resolve.
		expect(calls.filter((c) => c.includes("editMessageText"))).toEqual([]);
	});
});

// ── Sender allowlist ────────────────────────────────────────────────
//
// The chat allowlist names WHERE the bridge listens. In a private chat that
// also names WHO is talking, which is the whole basis for trusting the channel
// with full dispatch capability. In a group it does not: every member can send
// a prompt and press Approve. The sender allowlist closes that, and like the
// chat allowlist it fails closed.

import { isSenderAuthorized } from "./telegram-bridge";

const OPERATOR = 5551;
const STRANGER = 7772;
const GROUP_CHAT = -1001234567890;

function makeGroupBridge(authorizedUserIds?: string[]) {
	return new TelegramDaemonBridge({
		telegramToken: "test-token",
		chatId: String(GROUP_CHAT),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(GROUP_CHAT)],
		authorizedUserIds,
	});
}

function groupCallbackFrom(userId: number) {
	return {
		id: "cbq_2",
		from: { id: userId },
		data: "approve:req_2",
		message: { message_id: 43, chat: { id: GROUP_CHAT, type: "supergroup" } },
	};
}

describe("isSenderAuthorized", () => {
	test("with an allowlist, only listed user ids pass, in any chat type", () => {
		const cfg = { authorizedUserIds: [String(OPERATOR)] };
		expect(isSenderAuthorized({ chatType: "supergroup", fromId: OPERATOR }, cfg)).toBe(true);
		expect(isSenderAuthorized({ chatType: "private", fromId: OPERATOR }, cfg)).toBe(true);
		expect(isSenderAuthorized({ chatType: "supergroup", fromId: STRANGER }, cfg)).toBe(false);
		expect(isSenderAuthorized({ chatType: "private", fromId: STRANGER }, cfg)).toBe(false);
		expect(isSenderAuthorized({ chatType: "private", fromId: undefined }, cfg)).toBe(false);
	});

	test("without an allowlist, a private chat keeps today's behaviour", () => {
		expect(isSenderAuthorized({ chatType: "private", fromId: STRANGER }, {})).toBe(true);
		expect(isSenderAuthorized({ fromId: STRANGER }, {})).toBe(true);
	});

	test("without an allowlist, a group or supergroup rejects everyone", () => {
		expect(isSenderAuthorized({ chatType: "supergroup", fromId: OPERATOR }, {})).toBe(false);
		expect(isSenderAuthorized({ chatType: "group", fromId: OPERATOR }, {})).toBe(false);
		expect(
			isSenderAuthorized({ chatType: "supergroup", fromId: OPERATOR }, { authorizedUserIds: [] }),
		).toBe(false);
	});
});

describe("handleCallbackQuery sender authorization", () => {
	const realFetch = globalThis.fetch;
	let calls: string[] = [];

	beforeEach(() => {
		calls = [];
		globalThis.fetch = (async (url: unknown) => {
			calls.push(String(url));
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a stranger pressing Approve in the allowlisted group causes no side effect", async () => {
		const bridge = makeGroupBridge([String(OPERATOR)]);
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(groupCallbackFrom(STRANGER));
		expect(calls).toEqual([]);
	});

	test("the operator pressing Approve in the allowlisted group is processed", async () => {
		const bridge = makeGroupBridge([String(OPERATOR)]);
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(groupCallbackFrom(OPERATOR));
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]).toContain("answerCallbackQuery");
	});

	test("a group with no sender allowlist rejects even the primary chat's members", async () => {
		const bridge = makeGroupBridge(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleCallbackQuery(groupCallbackFrom(OPERATOR));
		expect(calls).toEqual([]);
	});

	test("a refused sender is observed, never answered", async () => {
		const bridge = makeGroupBridge([String(OPERATOR)]);
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		(bridge as any).observeSender({
			update_id: 1,
			message: {
				message_id: 1,
				from: { id: STRANGER },
				chat: { id: GROUP_CHAT, type: "supergroup" },
				text: "hi",
			},
		});
		expect(calls.filter((c) => c.includes("sendMessage"))).toHaveLength(0);
	});
});
