import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	OPEN_COMMANDS,
	OPERATOR_COMMANDS,
	PRIVILEGED_COMMANDS,
	TelegramDaemonBridge,
} from "./telegram-bridge";
import { COMMAND_DESCRIPTIONS, greetingText, vesselIdentity } from "./telegram-greeting";

const CHAT = 123456;

describe("greeting text", () => {
	test("no identity keeps the plain Eight text", () => {
		const t = greetingText({ identity: null, mode: "multi-step", commands: ["/status"] });
		expect(t.startsWith("Eight is online (multi-step mode). Commands: /status")).toBe(true);
	});

	test("identity from config names the vessel and role", () => {
		const id = vesselIdentity({ EIGHT_VESSEL_NAME: "Atlas", EIGHT_VESSEL_ROLE: "builder" });
		const t = greetingText({ identity: id, mode: "multi-step", commands: ["/status"] });
		expect(t.startsWith("Atlas, builder is online")).toBe(true);
		expect(vesselIdentity({})).toBeNull();
	});

	test("every command the bridge registers has a description, none of the privileged ones leak", () => {
		for (const c of [...OPEN_COMMANDS, ...OPERATOR_COMMANDS]) {
			expect(COMMAND_DESCRIPTIONS[c]).toBeDefined();
		}
		for (const c of PRIVILEGED_COMMANDS) expect(COMMAND_DESCRIPTIONS[c]).toBeUndefined();
	});
});

describe("/start", () => {
	const realFetch = globalThis.fetch;
	const realName = process.env.EIGHT_VESSEL_NAME;
	let sent: string[] = [];
	let modes: (string | undefined)[] = [];

	beforeEach(() => {
		sent = [];
		modes = [];
		process.env.EIGHT_VESSEL_NAME = "Atlas";
		process.env.EIGHT_VESSEL_ROLE = "builder";
		globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
			try {
				const b = JSON.parse(String(init?.body ?? "{}"));
				if (typeof b.text === "string") {
					sent.push(b.text);
					modes.push(b.parse_mode);
				}
			} catch {}
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		if (realName === undefined) {
			process.env.EIGHT_VESSEL_NAME = undefined as unknown as string;
			delete process.env.EIGHT_VESSEL_NAME;
		} else process.env.EIGHT_VESSEL_NAME = realName;
		delete process.env.EIGHT_VESSEL_ROLE;
	});

	test("answers with the identity greeting and the real command list, not Unknown command", async () => {
		const bridge = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(CHAT),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(CHAT)],
		});
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleTelegramMessage("/start", CHAT, {
			fromId: CHAT,
			chatType: "private",
		});
		const all = sent.join("\n");
		expect(all).not.toContain("Unknown command");
		expect(all).toContain("Atlas, builder is online");
		for (const c of OPERATOR_COMMANDS) expect(all).toContain(c);
		expect(all).toContain("/start");
	});

	const OPERATOR = 111;
	const MEMBER = 222;
	const GROUP = -100777;
	const groupBridge = () =>
		new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(GROUP),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(GROUP), String(MEMBER), String(OPERATOR)],
			authorizedUserIds: [String(OPERATOR), String(MEMBER)],
		});

	test("an authorised non-operator gets the open list only, never an operator command", async () => {
		const bridge = groupBridge();
		// biome-ignore lint/suspicious/noExplicitAny: the bot's own username comes from getMe at start.
		(bridge as any).botUsername = "examplebot";
		for (const [chat, chatType, text] of [
			[MEMBER, "private", "/start"],
			[GROUP, "supergroup", "/start@examplebot"],
		] as const) {
			sent = [];
			// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
			await (bridge as any).handleTelegramMessage(text, chat, { fromId: MEMBER, chatType });
			const all = sent.join("\n");
			expect(all).toContain("Atlas, builder is online");
			for (const c of OPEN_COMMANDS) expect(all).toContain(c);
			for (const c of [...OPERATOR_COMMANDS, ...PRIVILEGED_COMMANDS]) {
				expect(all).not.toMatch(new RegExp(`${c}\\b`));
			}
		}
		// A bare /start in the group is not addressed to us from a non-operator: silence, as before.
		sent = [];
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleTelegramMessage("/start", GROUP, {
			fromId: MEMBER,
			chatType: "supergroup",
		});
		expect(sent).toEqual([]);
	});

	test("the greeting never advertises /run or /deploy, even to the operator", async () => {
		const bridge = groupBridge();
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
		await (bridge as any).handleTelegramMessage("/start", OPERATOR, {
			fromId: OPERATOR,
			chatType: "private",
		});
		const all = sent.join("\n");
		expect(all).toContain("Atlas, builder is online");
		for (const c of PRIVILEGED_COMMANDS) expect(all).not.toMatch(new RegExp(`${c}\\b`));
	});

	test("a vessel name with Markdown characters is sent as plain text", async () => {
		process.env.EIGHT_VESSEL_NAME = "night_chair *8EO*";
		process.env.EIGHT_VESSEL_ROLE = "[ops](http://x)";
		for (const [from, chat] of [
			[CHAT, CHAT],
			[MEMBER, MEMBER],
		] as const) {
			const bridge =
				from === CHAT
					? new TelegramDaemonBridge({
							telegramToken: "test-token",
							chatId: String(CHAT),
							daemonUrl: "ws://127.0.0.1:1",
							authorizedChatIds: [String(CHAT)],
						})
					: groupBridge();
			sent = [];
			modes = [];
			// biome-ignore lint/suspicious/noExplicitAny: reaching a private handler is the point of the test.
			await (bridge as any).handleTelegramMessage("/start", chat, {
				fromId: from,
				chatType: "private",
			});
			const i = sent.findIndex((t) => t.includes("night_chair *8EO*, [ops](http://x) is online"));
			expect(i).toBeGreaterThanOrEqual(0);
			expect(modes[i]).toBeUndefined();
		}
	});
});
