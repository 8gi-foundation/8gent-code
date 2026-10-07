/**
 * #3615: per-sender tiers, no shell from groups, local model default, and the
 * shared-token startup refusal. Pure-function tests plus a bridge-level pass
 * through handleTelegramMessage with fetch stubbed, so nothing leaves the box.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { statSync, rmSync } from "node:fs";
import {
	groupAddressing,
	OBSERVED_LOG,
	observeUnauthorized,
	scrubErr,
	cleanText,
	assertNotAiJamesToken,
	commandOf,
	isCommandAllowed,
	resolveBridgeModel,
	senderTier,
	TelegramDaemonBridge,
} from "./telegram-bridge";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const STRANGER = 111;
const GROUP = -1001;
const cfg = {
	authorizedUserIds: [String(JAMES), String(ARTALE)],
	operatorUserIds: [String(JAMES)],
	botUsername: "eightbot",
};
/** Telegram mention entity for a leading "@eightbot". */
const MENT = [{ type: "mention", offset: 0, length: 9 }];
const group = (fromId: number) => ({ chatType: "supergroup", fromId });
const dm = (fromId: number) => ({ chatType: "private", fromId });

describe("sender tiers", () => {
	test("James full, Artale prompt, stranger observe", () => {
		expect(senderTier(group(JAMES), cfg)).toBe("full");
		expect(senderTier(group(ARTALE), cfg)).toBe("prompt");
		expect(senderTier(group(STRANGER), cfg)).toBe("observe");
	});
	test("group with no allowlist fails closed", () => {
		expect(senderTier(group(JAMES), {})).toBe("observe");
	});
});

describe("privileged commands", () => {
	test("Artale /run in the group is refused", () => {
		expect(isCommandAllowed("/run ls", group(ARTALE), cfg)).toBe(false);
	});
	test("James /run in the group is refused", () => {
		expect(isCommandAllowed("/run ls", group(JAMES), cfg)).toBe(false);
		expect(isCommandAllowed("/deploy", group(JAMES), cfg)).toBe(false);
	});
	test("James /run in a DM is allowed", () => {
		expect(isCommandAllowed("/run ls", dm(JAMES), cfg)).toBe(true);
		expect(isCommandAllowed("/deploy", dm(JAMES), cfg)).toBe(true);
	});
	test("Artale /run in a DM is refused", () => {
		expect(isCommandAllowed("/run ls", dm(ARTALE), cfg)).toBe(false);
	});
	test("@botname and case do not bypass", () => {
		expect(commandOf("/RUN@eightbot ls", "eightbot")).toBe("/run");
		expect(commandOf("/run@otherbot ls", "eightbot")).toBeNull();
		expect(commandOf("/run@eightbot ls")).toBeNull();
		expect(isCommandAllowed("/RUN@eightbot ls", group(ARTALE), cfg)).toBe(false);
	});
	test("missing sender context refuses", () => {
		expect(isCommandAllowed("/run ls", undefined, cfg)).toBe(false);
	});
	test("dispatch commands are closed to the prompt tier, open to James in the group", () => {
		expect(isCommandAllowed("/delegate x", group(ARTALE), cfg)).toBe(false);
		expect(isCommandAllowed("/kill 1", group(ARTALE), cfg)).toBe(false);
		expect(isCommandAllowed("/delegate x", group(JAMES), cfg)).toBe(true);
	});
	test("/status and /help pass for the prompt tier; plain prompts do not", () => {
		expect(isCommandAllowed("build a thing", group(ARTALE), cfg)).toBe(false);
		expect(isCommandAllowed("build a thing", group(JAMES), cfg)).toBe(true);
		expect(isCommandAllowed("/status", group(ARTALE), cfg)).toBe(true);
	});
});

describe("group traffic through the bridge", () => {
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
	const bridge = () =>
		new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(GROUP),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(GROUP)],
			authorizedUserIds: cfg.authorizedUserIds,
			operatorUserIds: cfg.operatorUserIds,
		});

	test("a non-allowlisted member is observed, not answered", () => {
		// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
		(bridge() as any).observeSender({
			update_id: 1,
			message: {
				message_id: 1,
				from: { id: STRANGER, first_name: "x" },
				chat: { id: GROUP, type: "supergroup" },
				text: "hello",
			},
		});
		expect(calls).toEqual([]);
	});

	test("Artale's /run in the group causes no side effect beyond a refusal reply", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
		await (bridge() as any).handleTelegramMessage("/run ls", GROUP, group(ARTALE));
		expect(calls).toEqual([]);
	});

	test("Artale's /boardroom, /goals and /voice in the group cause no side effect", async () => {
		for (const text of ["/boardroom topic", "/goals", "/voice on", "/Boardroom@eightbot x"]) {
			// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
			await (bridge() as any).handleTelegramMessage(text, GROUP, group(ARTALE));
		}
		expect(calls).toEqual([]);
	});

	test("a voice transcript of /run from Artale goes through the same gate", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
		await (bridge() as any).dispatchTranscript("/run ls", {
			chat: { id: GROUP, type: "supergroup" },
			from: { id: ARTALE },
		});
		expect(calls).toEqual([]);
	});

	test("James's /run in the group causes no side effect", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
		await (bridge() as any).handleTelegramMessage("/run ls", GROUP, group(JAMES));
		expect(calls).toEqual([]);
	});
});

describe("model default", () => {
	test("resolves to the local provider with nothing configured", () => {
		expect(resolveBridgeModel({})).toEqual({ runtime: "ollama", model: "eight-1.0-q3:14b" });
	});
	test("a stray DEFAULT_MODEL does not move traffic to the cloud", () => {
		expect(resolveBridgeModel({ DEFAULT_MODEL: "foo:7b" }).runtime).toBe("ollama");
	});
	test("cloud only when DEFAULT_RUNTIME names it", () => {
		expect(resolveBridgeModel({ DEFAULT_RUNTIME: "openrouter" })).toEqual({
			runtime: "openrouter",
			model: "auto:free",
		});
	});
});

describe("shared-token startup refusal", () => {
	const tok = "123456:not-a-real-token";
	const sha = createHash("sha256").update(tok).digest("hex");
	test("same token as AI James refuses, without printing the token", () => {
		let msg = "";
		try {
			assertNotAiJamesToken(tok, { AI_JAMES_BOT_TOKEN_SHA256: sha }, () => null);
		} catch (e) {
			msg = String(e);
		}
		expect(msg).toContain("refusing to start");
		expect(msg).not.toContain(tok);
	});
	test("hash file reference works", () => {
		expect(() => assertNotAiJamesToken(tok, {}, () => `${sha}\n`)).toThrow("refusing to start");
	});
	test("a different token passes", () => {
		expect(assertNotAiJamesToken("999:other", { AI_JAMES_BOT_TOKEN_SHA256: sha }, () => null)).toBe(
			true,
		);
	});
	test("no reference, DM-only: warns once and returns false", () => {
		const warn = console.warn;
		const lines: string[] = [];
		console.warn = (m: string) => lines.push(m);
		try {
			expect(assertNotAiJamesToken(tok, {}, () => null, ["123"])).toBe(false);
		} finally {
			console.warn = warn;
		}
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("AI_JAMES_BOT_TOKEN_SHA256");
	});
	test("no reference, group chat: refuses naming the env var", () => {
		expect(() => assertNotAiJamesToken(tok, {}, () => null, ["123", "-1001"])).toThrow(
			"AI_JAMES_BOT_TOKEN_SHA256",
		);
	});
});

const VARIANTS = [
	"/voiceon",
	"/goalsclear",
	"/goalsset x",
	"/boardroomx",
	"/boardroom-x",
	"/boardroom\u200Bx",
	"/voice\u200Bon",
	"/boardroom\u2060x",
	"/ run ls",
	"/unknowncmd",
];

describe("F2: one parser, unknown slash text refused", () => {
	for (const v of VARIANTS) {
		test(`refused for Artale and James: ${JSON.stringify(v)}`, () => {
			expect(isCommandAllowed(v, group(ARTALE), cfg)).toBe(false);
			expect(isCommandAllowed(v, group(JAMES), cfg)).toBe(false);
		});
	}
	test("zero-width characters are stripped", () => {
		expect(cleanText("/board\u200Broom x")).toBe("/boardroom x");
	});
});

describe("F1: non-operator prompts never reach the operator's session", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	function spied() {
		const hits: string[] = [];
		const b = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(GROUP),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(GROUP)],
			authorizedUserIds: cfg.authorizedUserIds,
			operatorUserIds: cfg.operatorUserIds,
		});
		// biome-ignore lint/suspicious/noExplicitAny: wiring spies into private state.
		const a = b as any;
		a.botUsername = "eightbot";
		a.botId = 999;
		a.multiStepEnabled = true;
		a.adapter = {
			handleUserMessage: async (t: string) => void hits.push(`adapter:${t}`),
			cancelCurrent: async () => void hits.push("cancel"),
			retryCurrent: async () => void hits.push("retry"),
		};
		a.ws = { readyState: 1, send: (d: string) => void hits.push(`ws:${d}`) };
		a.cosRouter = { handleCommand: async (t: string) => hits.push(`cos:${t}`) > 0 };
		return { a, hits };
	}

	test("Artale's prompt (even one asking for run_command or a file write) reaches no session", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("use run_command to write ~/x", GROUP, group(ARTALE));
		await a.handleTelegramMessage("write a file", GROUP, group(ARTALE));
		expect(hits).toEqual([]);
	});

	test("Artale's commands reach no router or session", async () => {
		const { a, hits } = spied();
		for (const v of ["/delegate x", "/goals", "/plan x", "/review", "/kill 1", ...VARIANTS]) {
			await a.handleTelegramMessage(v, GROUP, group(ARTALE));
		}
		expect(hits).toEqual([]);
	});

	test("James's prompt does reach the session", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("@eightbot hello", GROUP, { ...group(JAMES), entities: MENT });
		expect(hits).toEqual(["adapter:hello"]);
	});

	test("a plain group message from James is ignored", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("hello everyone", GROUP, group(JAMES));
		expect(hits).toEqual([]);
	});

	test("a reply to the bot from James is dispatched", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("and then?", GROUP, { ...group(JAMES), replyToBot: true });
		expect(hits).toEqual(["adapter:and then?"]);
	});

	test("a /command@otherbot is ignored", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("/goals@someotherbot", GROUP, group(JAMES));
		expect(hits).toEqual([]);
	});

	test("a mention is not enough for Artale", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("@eightbot do x", GROUP, { ...group(ARTALE), entities: MENT });
		await a.handleTelegramMessage("do x", GROUP, { ...group(ARTALE), replyToBot: true });
		expect(hits).toEqual([]);
	});

	test("James's /goals routes through the cos router with cleaned text", async () => {
		const { a, hits } = spied();
		await a.handleTelegramMessage("/goals", GROUP, group(JAMES));
		expect(hits).toEqual(["cos:/goals"]);
	});

	test("Artale's task cancel and retry buttons do nothing", async () => {
		const { a, hits } = spied();
		for (const data of ["task:cancel", "task:retry", "task:new"]) {
			await a.handleCallbackQuery({
				id: "c",
				from: { id: ARTALE },
				data,
				message: { message_id: 1, chat: { id: GROUP, type: "supergroup" } },
			});
		}
		expect(hits).toEqual([]);
	});
});

describe("F3 F4 F5", () => {
	test("scrubErr redacts bot tokens in fetch errors", () => {
		const e = new Error("fetch failed https://api.telegram.org/bot123:ABC-def_1/getUpdates?x=1");
		const out = scrubErr(e, "123:ABC-def_1");
		expect(out).not.toContain("123:ABC");
		expect(out).toContain("/bot<redacted>");
	});
	test("hash is computed over the trimmed token", () => {
		const tok = "555:trim-me";
		const sha = createHash("sha256").update(tok).digest("hex");
		expect(() =>
			assertNotAiJamesToken(`${tok}\n`, { AI_JAMES_BOT_TOKEN_SHA256: sha }, () => null),
		).toThrow("refusing to start");
	});
	test("getMe naming aijamesosbot refuses startup", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ ok: true, result: { username: "aijamesosbot" } }),
			)) as unknown as typeof fetch;
		try {
			const b = new TelegramDaemonBridge({
				telegramToken: "t",
				chatId: "1",
				daemonUrl: "ws://127.0.0.1:1",
			});
			await expect(b.start()).rejects.toThrow("aijamesosbot");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("unverifiable getMe in group mode refuses startup", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		try {
			const b = new TelegramDaemonBridge({
				telegramToken: "t",
				chatId: "-1001",
				daemonUrl: "ws://127.0.0.1:1",
				authorizedChatIds: ["-1001"],
			});
			await expect(b.start()).rejects.toThrow("group mode");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	test("OBSERVED_LOG is created 0600", () => {
		try {
			rmSync(OBSERVED_LOG);
		} catch {}
		observeUnauthorized({
			update_id: 1,
			message: { date: 1, text: "x", message_id: 1, chat: { id: 1 }, from: { first_name: "a" } },
		});
		expect(statSync(OBSERVED_LOG).mode & 0o777).toBe(0o600);
		rmSync(OBSERVED_LOG);
	});
});

describe("replies: silent in groups, once an hour in DMs", () => {
	const realFetch = globalThis.fetch;
	let sends: string[] = [];
	beforeEach(() => {
		sends = [];
		globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
			if (String(url).includes("sendMessage")) sends.push(String(init?.body ?? ""));
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const mk = () => {
		const b = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(GROUP),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(GROUP), String(ARTALE)],
			authorizedUserIds: cfg.authorizedUserIds,
			operatorUserIds: cfg.operatorUserIds,
		});
		// biome-ignore lint/suspicious/noExplicitAny: private state.
		(b as any).botUsername = "eightbot";
		return b;
	};

	test("5 group messages from Artale produce 0 replies", async () => {
		const b = mk();
		for (let i = 0; i < 5; i++) {
			// biome-ignore lint/suspicious/noExplicitAny: private handler.
			await (b as any).handleTelegramMessage(`@eightbot do ${i}`, GROUP, {
				...group(ARTALE),
				entities: MENT,
			});
		}
		expect(sends).toHaveLength(0);
	});

	test("5 DMs from Artale produce 1 reply, naming who to ask", async () => {
		const b = mk();
		for (let i = 0; i < 5; i++) {
			// biome-ignore lint/suspicious/noExplicitAny: private handler.
			await (b as any).handleTelegramMessage(`do ${i}`, ARTALE, dm(ARTALE));
		}
		expect(sends).toHaveLength(1);
		expect(sends[0]).toContain("Ask James for access");
	});
});

describe("groupAddressing", () => {
	const bot = { username: "eightbot" };
	const ctx = (extra: object, who = JAMES) => ({ ...group(who), ...extra });
	test("mention entity, case-insensitive, is stripped", () => {
		const e = [{ type: "mention", offset: 0, length: 9 }];
		expect(groupAddressing("@EightBot: do x", ctx({ entities: e }), bot, cfg)).toEqual({
			addressed: true,
			text: "do x",
		});
	});
	test("a different username does not address us", () => {
		const e = [{ type: "mention", offset: 0, length: 10 }];
		expect(groupAddressing("@eightbot2 hi", ctx({ entities: e }), bot, cfg).addressed).toBe(false);
	});
	test("text that merely contains the name, with no entity, does not address us", () => {
		expect(groupAddressing("@eightbot hi", ctx({}), bot, cfg).addressed).toBe(false);
		expect(groupAddressing("ask @eightbot", ctx({}), bot, cfg).addressed).toBe(false);
	});
	test("a non-leading mention does not address us", () => {
		const e = [{ type: "mention", offset: 4, length: 9 }];
		expect(groupAddressing("hey @eightbot x", ctx({ entities: e }), bot, cfg).addressed).toBe(
			false,
		);
	});
	test("offsets slice the ORIGINAL text, not the cleaned one", () => {
		const e = [{ type: "mention", offset: 1, length: 9 }];
		expect(groupAddressing("\u200B@eightbot hi", ctx({ entities: e }), bot, cfg)).toEqual({
			addressed: true,
			text: "hi",
		});
	});
	test("a mention inside code, pre or url does not count", () => {
		for (const type of ["code", "pre", "url", "text_link"]) {
			const e = [
				{ type: "mention", offset: 0, length: 9 },
				{ type, offset: 0, length: 12 },
			];
			expect(groupAddressing("@eightbot hi", ctx({ entities: e }), bot, cfg).addressed).toBe(false);
		}
	});
	test("forwarded or via-bot messages are never addressed", () => {
		expect(
			groupAddressing("@eightbot hi", ctx({ entities: MENT, forwarded: true }), bot, cfg).addressed,
		).toBe(false);
	});
	test("a reply flag addresses us", () => {
		expect(groupAddressing("and?", ctx({ replyToBot: true }), bot, cfg).addressed).toBe(true);
	});
	test("/cmd@ourbot is addressed, /cmd@otherbot is not", () => {
		expect(groupAddressing("/status@eightbot", ctx({}, ARTALE), bot, cfg).addressed).toBe(true);
		expect(groupAddressing("/status@otherbot", ctx({}, JAMES), bot, cfg).addressed).toBe(false);
	});
	test("DMs are always addressed", () => {
		expect(groupAddressing("hi", dm(JAMES), bot, cfg).addressed).toBe(true);
	});
	test("a bare command counts only from an operator", () => {
		expect(groupAddressing("/status", group(JAMES), bot, cfg).addressed).toBe(true);
		expect(groupAddressing("/status", group(ARTALE), bot, cfg).addressed).toBe(false);
	});
	test("unknown bot username fails closed", () => {
		expect(
			groupAddressing("@eightbot hi", ctx({ entities: MENT }), {}, { ...cfg, botUsername: null })
				.addressed,
		).toBe(false);
	});
});

describe("gate order and authority", () => {
	const realFetch = globalThis.fetch;
	let sent: { url: string; body: string }[] = [];
	beforeEach(() => {
		sent = [];
		globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
			sent.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, status: "ok" }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const mk = () => {
		const hits: string[] = [];
		const b = new TelegramDaemonBridge({
			telegramToken: "test-token",
			chatId: String(JAMES),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(GROUP), String(JAMES), String(ARTALE)],
			authorizedUserIds: cfg.authorizedUserIds,
			operatorUserIds: cfg.operatorUserIds,
		});
		// biome-ignore lint/suspicious/noExplicitAny: private state.
		const a = b as any;
		a.botUsername = "eightbot";
		a.botId = 999;
		a.multiStepEnabled = true;
		a.adapter = {
			handleUserMessage: async (t: string) => void hits.push(`adapter:${t}`),
			cancelCurrent: async () => void hits.push("cancel"),
			retryCurrent: async () => void hits.push("retry"),
		};
		a.cosRouter = { handleCommand: async (t: string) => hits.push(`cos:${t}`) > 0 };
		return { a, hits };
	};

	test("F6: James can run /cancel /unstick /plan /review; Artale cannot", async () => {
		const { a, hits } = mk();
		for (const c of ["/cancel", "/unstick", "/plan x", "/review"]) {
			await a.handleTelegramMessage(c, GROUP, group(JAMES));
		}
		expect(hits).toContain("cancel");
		expect(hits).toContain("cos:/plan x");
		expect(hits).toContain("cos:/review");
		const before = hits.length;
		for (const c of [
			"/cancel@eightbot",
			"/unstick@eightbot",
			"/plan@eightbot x",
			"/review@eightbot",
		]) {
			await a.handleTelegramMessage(c, GROUP, group(ARTALE));
		}
		expect(hits.length).toBe(before);
	});

	test("Artale's /boardroom@ourbot still hits the tier gate", async () => {
		const { a, hits } = mk();
		await a.handleTelegramMessage("/boardroom@eightbot topic", GROUP, group(ARTALE));
		await a.handleTelegramMessage("/delegate@eightbot x", GROUP, group(ARTALE));
		expect(hits).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("N1: a stranger's or non-operator's button press does not move the reply chat", async () => {
		const { a } = mk();
		a.originChatId = String(JAMES);
		for (const from of [STRANGER, ARTALE]) {
			await a.handleCallbackQuery({
				id: "c",
				from: { id: from },
				data: "task:cancel",
				message: { message_id: 1, chat: { id: GROUP, type: "supergroup" } },
			});
		}
		expect(a.originChatId).toBe(String(JAMES));
	});

	test("N1: a refused or unaddressed message does not move the reply chat", async () => {
		const { a } = mk();
		a.originChatId = String(JAMES);
		await a.handleTelegramMessage("@eightbot hi", GROUP, { ...group(ARTALE), entities: MENT });
		await a.handleTelegramMessage("hello people", GROUP, group(JAMES));
		expect(a.originChatId).toBe(String(JAMES));
	});

	test("N2: voice is admitted only for an addressed operator, before any origin change", async () => {
		const { a } = mk();
		a.originChatId = String(JAMES);
		const voice = (from: number, type: string, extra = {}) => ({
			message_id: 1,
			from: { id: from, first_name: "x" },
			chat: { id: type === "private" ? from : GROUP, type },
			voice: { file_id: "f", duration: 1 },
			...extra,
		});
		expect(
			await a.admitVoice(voice(ARTALE, "supergroup", { reply_to_message: { from: { id: 999 } } })),
		).toBe(false);
		expect(await a.admitVoice(voice(ARTALE, "private"))).toBe(false);
		expect(await a.admitVoice(voice(JAMES, "supergroup"))).toBe(false); // not addressed
		expect(a.originChatId).toBe(String(JAMES));
		expect(
			await a.admitVoice(voice(JAMES, "supergroup", { reply_to_message: { from: { id: 999 } } })),
		).toBe(true);
		expect(a.originChatId).toBe(String(GROUP));
	});

	test("reply counts only on the bot's id, never username, quote or forward", () => {
		const { a } = mk();
		const m = (extra: object) => ({
			message_id: 1,
			from: { id: JAMES, first_name: "x" },
			chat: { id: GROUP, type: "supergroup" },
			...extra,
		});
		expect(a.senderCtx(m({ reply_to_message: { from: { id: 999 } } })).replyToBot).toBe(true);
		expect(
			a.senderCtx(m({ reply_to_message: { from: { id: 1, username: "eightbot" } } })).replyToBot,
		).toBe(false);
		expect(
			a.senderCtx(m({ quote: { text: "x" }, external_reply: { from: { id: 999 } } })).replyToBot,
		).toBe(false);
		expect(a.senderCtx(m({ forward_origin: { type: "user" } })).forwarded).toBe(true);
		expect(a.senderCtx(m({ via_bot: { id: 5 } })).forwarded).toBe(true);
	});

	test("N2: plain /status for a non-operator is up/down only and never reaches the task list", async () => {
		const { a, hits } = mk();
		await a.handleTelegramMessage("/status@eightbot", GROUP, group(ARTALE));
		expect(hits).toEqual([]);
		const texts = sent.filter((c) => c.url.includes("sendMessage")).map((c) => c.body);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("Status: up");
		expect(texts[0]).not.toContain("Sessions");
	});

	test("N2: /status for the operator still routes to the task list", async () => {
		const { a, hits } = mk();
		await a.handleTelegramMessage("/status", GROUP, group(JAMES));
		expect(hits).toEqual(["cos:/status"]);
	});

	test("DM throttle is keyed by user id, bounded, never echoes, and a failed send is silent", async () => {
		const { a } = mk();
		await a.handleTelegramMessage("secret-prompt-text", ARTALE, dm(ARTALE));
		const bodies = sent.filter((c) => c.url.includes("sendMessage")).map((c) => c.body);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain("secret-prompt-text");
		for (let i = 1; i <= 400; i++) await a.refuseDm(dm(i), i);
		expect(a.refusedDms.size).toBeLessThanOrEqual(256);
		globalThis.fetch = (async () => {
			throw new Error("down");
		}) as unknown as typeof fetch;
		await expect(a.refuseDm(dm(777777), 777777)).resolves.toBeUndefined();
	});
});
