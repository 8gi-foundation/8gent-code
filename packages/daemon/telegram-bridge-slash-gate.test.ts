/**
 * Typed and spoken input pass the input gate before the model (#4530, audit fix 5).
 * A slash line that is not a bridge command never reaches adapter.handleUserMessage.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDjSpawn, setDjTools } from "../music/dj";
import { TelegramDaemonBridge } from "./telegram-bridge";

const JAMES = 5486040131;
const DM = { id: JAMES, type: "private" };
const saved: Record<string, any> = {};
let sent: string[];

beforeEach(() => {
	sent = [];
	saved.fetch = globalThis.fetch;
	globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
		try {
			const b = init?.body ? JSON.parse(init.body) : {};
			if (typeof b.text === "string") sent.push(b.text);
		} catch {}
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	}) as unknown as typeof fetch;
	for (const k of ["log", "warn", "error", "info"] as const) {
		saved[k] = console[k];
		console[k] = () => {};
	}
});
afterEach(() => {
	globalThis.fetch = saved.fetch;
	for (const k of ["log", "warn", "error", "info"] as const) console[k] = saved[k];
});

function make(transcript = "") {
	const toModel: string[] = [];
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(JAMES),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES)],
		authorizedUserIds: [String(JAMES)],
		operatorUserIds: [String(JAMES)],
		env: {},
		judgeModel: null,
	}) as any;
	b.multiStepEnabled = true;
	b.adapter = { handleUserMessage: async (t: string) => void toModel.push(t) };
	b.transcribe = async () => transcript;
	return { b, toModel };
}
const sender = { chatType: "private", fromId: JAMES };
const voiceMsg = {
	message_id: 1,
	from: { id: JAMES },
	chat: DM,
	voice: { file_id: "f", duration: 2 },
} as any;

describe("typed input", () => {
	test("an unknown slash line is refused in the chat and never reaches the model", async () => {
		const t = make();
		await t.b.handleTelegramMessage("/nosuchthing now", JAMES, sender);
		expect(t.toModel).toEqual([]);
		expect(sent).toContain("Unknown command /nosuchthing. Type /help.");
	});
	test("a registry command is handled without the model and its text goes to the chat", async () => {
		const t = make();
		await t.b.handleTelegramMessage("/session", JAMES, sender);
		expect(t.toModel).toEqual([]);
		expect(sent.some((s) => s.includes(`tg-${JAMES}`))).toBe(true);
	});
	test("plain text reaches the model once", async () => {
		const t = make();
		await t.b.handleTelegramMessage("hello there", JAMES, sender);
		expect(t.toModel).toEqual(["hello there"]);
	});
});

describe("spoken input", () => {
	test("an unknown spoken slash is refused with no model call", async () => {
		const t = make("/nosuchthing now");
		await t.b.handleVoiceMessage(voiceMsg, "f");
		expect(t.toModel).toEqual([]);
		expect(sent).toContain("Unknown command /nosuchthing. Type /help.");
	});
	test("a spoken registry command is handled once, not by the model", async () => {
		const t = make("/session");
		await t.b.handleVoiceMessage(voiceMsg, "f");
		expect(t.toModel).toEqual([]);
		expect(sent.filter((s) => s.includes(`tg-${JAMES}`)).length).toBe(1);
	});
	test("a group voice transcript starting with a slash is never run and never reaches the model", async () => {
		const spawned: string[] = [];
		setDjTools({ mpv: "/usr/bin/mpv", ytdlp: "/usr/bin/yt-dlp" });
		setDjSpawn(((c: string) => void spawned.push(c)) as never);
		try {
			const t = make();
			await t.b.handleTelegramMessage("/dj play x", JAMES, sender, {
				plain: true,
				groupVoice: true,
			});
			expect(spawned).toEqual([]);
			expect(t.toModel).toEqual([]);
		} finally {
			setDjSpawn();
			setDjTools();
		}
	});
	test("a plain transcript reaches the model once", async () => {
		const t = make("what is on my list");
		await t.b.handleVoiceMessage(voiceMsg, "f");
		expect(t.toModel).toEqual(["what is on my list"]);
	});
});
