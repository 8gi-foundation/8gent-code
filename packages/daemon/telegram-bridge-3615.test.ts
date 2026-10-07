/**
 * #3615: per-sender tiers, no shell from groups, local model default, and the
 * shared-token startup refusal. Pure-function tests plus a bridge-level pass
 * through handleTelegramMessage with fetch stubbed, so nothing leaves the box.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
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
	test("plain prompts and /status pass for the prompt tier", () => {
		expect(isCommandAllowed("build a thing", group(ARTALE), cfg)).toBe(true);
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

	test("Artale's /run in the group causes no side effect", async () => {
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
