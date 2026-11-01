/**
 * #5221: four live bugs in the 8GI group, one test per bug, through the call shapes the
 * bridge uses in production (handleTelegramMessage, handleDaemonMessage, the adapter's
 * onAgentStream, announceStartup).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFlowModeController } from "../flow/flow-mode";
import { stripReasoning } from "../telegram-bot/strip-reasoning";
import { VOICE_NOT_SET_UP, asksForVoice } from "../telegram-bot/voice-mode";
import { TelegramDaemonBridge } from "./telegram-bridge";

const JAMES = 100000001;
const GROUP = -200000003;
const BOT = "moira8do_bot";
const saved: Record<string, any> = {};
let sent: { chat: string; text: string }[];
let logged: string[];

beforeEach(() => {
	sent = [];
	logged = [];
	saved.fetch = globalThis.fetch;
	globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
		try {
			const b = init?.body ? JSON.parse(init.body) : {};
			if (typeof b.text === "string") sent.push({ chat: String(b.chat_id), text: b.text });
		} catch {}
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	}) as unknown as typeof fetch;
	for (const k of ["log", "warn", "error", "info"] as const) {
		saved[k] = console[k];
		console[k] = (...a: unknown[]) => void logged.push(a.join(" "));
	}
});
afterEach(() => {
	globalThis.fetch = saved.fetch;
	for (const k of ["log", "warn", "error", "info"] as const) console[k] = saved[k];
});

function make(over: Record<string, unknown> = {}, chatId: number = JAMES) {
	const toModel: string[] = [];
	const voice: any[] = [];
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(chatId),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES), String(GROUP)],
		authorizedUserIds: [String(JAMES)],
		operatorUserIds: [String(JAMES)],
		env: {},
		flowController: createFlowModeController(),
		spokenModel: async () => "Hello, I am Moira.",
		sendVoiceNote: async (o: any) => {
			voice.push(o);
			return { sent: true, reason: "ok" };
		},
		...over,
	}) as any;
	b.botUsername = BOT;
	b.multiStepEnabled = true;
	b.voiceEnabled = false;
	b.adapter = { handleUserMessage: async (t: string) => void toModel.push(t) };
	return { b, toModel, voice };
}
const inGroup = { chatType: "supergroup", fromId: JAMES };
const inDm = { chatType: "private", fromId: JAMES };

describe("1. reasoning never reaches a chat", () => {
	test("closed, unclosed leading, multiple and orphan-close blocks", () => {
		expect(stripReasoning("<think>plan it</think>The answer.")).toBe("The answer.");
		expect(stripReasoning("<think>\nplan\n</think>\n\nA <think>x</think>B")).toBe("A B");
		expect(stripReasoning("<think>never closed, still thinking")).toBe("");
		expect(stripReasoning("hidden thoughts</think>Answer")).toBe("Answer");
		expect(stripReasoning("No tags here.")).toBe("No tags here.");
	});
	test("legacy final reply: only the answer is posted and spoken, the reasoning is not logged", async () => {
		const t = make();
		t.b.voiceEnabled = true;
		t.b.voiceTurnAt = Date.now();
		t.b.voiceTurnChat = String(JAMES);
		t.b.handleDaemonMessage({
			type: "event",
			event: "agent:stream",
			payload: { final: true, chunk: "<think>SECRET-REASONING</think>The answer." },
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(sent.map((s) => s.text)).toEqual(["The answer."]);
		expect(JSON.stringify(sent) + logged.join("\n")).not.toContain("SECRET-REASONING");
	});
	test("a reply that is only an unclosed reasoning block posts nothing", async () => {
		const t = make();
		t.b.handleDaemonMessage({
			type: "event",
			event: "agent:stream",
			payload: { final: true, chunk: "<think>SECRET-REASONING never ends" },
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(sent).toEqual([]);
	});
});

describe("2. asked for voice, answered in voice", () => {
	test("the phrases", () => {
		for (const s of [
			"introduce yourself in voice",
			"send a voice note",
			"say it",
			"reply by voice",
		])
			expect(asksForVoice(s)).toBe(true);
		for (const s of ["what is a voice actor", "hello there"]) expect(asksForVoice(s)).toBe(false);
	});
	test("in a group: 'in voice' arms the turn and the note goes to that group with the cell's voice", async () => {
		process.env.EIGHT_VESSEL_NAME = "Moira";
		try {
			const t = make({}, GROUP);
			await t.b.handleTelegramMessage(`@${BOT} introduce yourself in voice`, GROUP, {
				...inGroup,
				entities: [{ type: "mention", offset: 0, length: BOT.length + 1 }],
			});
			expect(t.toModel).toEqual(["introduce yourself in voice"]);
			t.b.originChatId = String(GROUP);
			await t.b.maybeSpeak("Hello, I am Moira.");
			expect(t.voice).toHaveLength(1);
			expect(t.voice[0]).toMatchObject({
				voice: "Luna",
				expectedChatId: String(GROUP),
				explicitChat: String(GROUP),
			});
		} finally {
			delete process.env.EIGHT_VESSEL_NAME;
		}
	});
	test("no local TTS: text fallback says voice is not set up", async () => {
		const t = make({
			sendVoiceNote: async () => ({ sent: false, reason: "kittentts-telegram not installed" }),
		});
		await t.b.handleTelegramMessage("say it", JAMES, inDm);
		await t.b.maybeSpeak("Hello.");
		expect(sent.map((s) => s.text)).toEqual([VOICE_NOT_SET_UP]);
	});
	test("a plain turn does not speak when voice mode is off", async () => {
		const t = make();
		await t.b.handleTelegramMessage("hello", JAMES, inDm);
		await t.b.maybeSpeak("Hello.");
		expect(t.voice).toEqual([]);
		expect(sent).toEqual([]);
	});
});

describe("3. in a group a command must name this bot", () => {
	for (const cmd of ["/start", "/status", "/help"]) {
		test(`bare ${cmd} in the group: no answer, no model`, async () => {
			const t = make({}, GROUP);
			await t.b.handleTelegramMessage(cmd, GROUP, inGroup);
			expect(sent).toEqual([]);
			expect(t.toModel).toEqual([]);
		});
	}
	test("/start@<bot> in the group is answered", async () => {
		const t = make({}, GROUP);
		await t.b.handleTelegramMessage(`/start@${BOT}`, GROUP, inGroup);
		expect(sent.length).toBe(1);
		expect(sent[0].text).toContain("online");
	});
	test("/start@examplebot_two in the group is not ours", async () => {
		const t = make({}, GROUP);
		await t.b.handleTelegramMessage("/start@examplebot_three", GROUP, inGroup);
		expect(sent).toEqual([]);
	});
	test("a DM keeps plain commands", async () => {
		const t = make();
		await t.b.handleTelegramMessage("/start", JAMES, inDm);
		expect(sent.length).toBe(1);
		expect(sent[0].text).toContain("online");
	});
});

describe("4. startup posts no card to a group", () => {
	test("group chat id: logged, nothing sent", async () => {
		const t = make({}, GROUP);
		await t.b.announceStartup("legacy");
		expect(sent).toEqual([]);
		expect(logged.some((l) => l.includes("online"))).toBe(true);
	});
	test("private chat id: the card still goes out", async () => {
		const t = make();
		await t.b.announceStartup("legacy");
		expect(sent.length).toBe(1);
	});
});
