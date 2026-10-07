/**
 * #3615: per-sender tiers, no shell from groups, local model default, and the
 * shared-token startup refusal. Pure-function tests plus a bridge-level pass
 * through handleTelegramMessage with fetch stubbed, so nothing leaves the box.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { statSync, rmSync } from "node:fs";
import {
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
};
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
		expect(commandOf("/RUN@eightbot ls")).toBe("/run");
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
		expect(calls.every((c) => c.includes("sendMessage"))).toBe(true);
	});

	test("Artale's /boardroom, /goals and /voice in the group cause no side effect", async () => {
		for (const text of ["/boardroom topic", "/goals", "/voice on", "/Boardroom@eightbot x"]) {
			// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
			await (bridge() as any).handleTelegramMessage(text, GROUP, group(ARTALE));
		}
		expect(calls.every((c) => c.includes("sendMessage"))).toBe(true);
	});

	test("a voice transcript of /run from Artale goes through the same gate", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: private handler under test.
		await (bridge() as any).dispatchTranscript("/run ls", {
			chat: { id: GROUP, type: "supergroup" },
			from: { id: ARTALE },
		});
		expect(calls.every((c) => c.includes("sendMessage"))).toBe(true);
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
		await a.handleTelegramMessage("hello", GROUP, group(JAMES));
		expect(hits).toEqual(["adapter:hello"]);
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
