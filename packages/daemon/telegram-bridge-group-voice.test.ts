/**
 * Group voice (8SO ruling 2026-10-17, conditions C-G1 to C-G17, attack tests G1 to G17).
 * The real bridge handlers, fetch stubbed so nothing leaves the box. The transcribe seam
 * stands in for getFile + ffmpeg + whisper: if it is never called, nothing was downloaded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlowModeController } from "../flow/flow-mode";
import { createPendingStore } from "../telegram-bot/flow-bot";
import {
	R10_GROUP_NOTICE,
	R10_TRANSIT_NOTICE,
	groupNoticeHash,
	readVoiceState,
	sendVoiceNote,
	writeVoiceState,
} from "../telegram-bot/voice-mode";
import {
	GROUP_VOICE_BUSY,
	GROUP_VOICE_TOO_BIG,
	RUN_ASYNC_MAX_BYTES,
	TelegramDaemonBridge,
	bindChatThread,
	groupVoiceIds,
	isForwardedLike,
	runAsync,
	tgSend,
	transcribeVoice,
} from "./telegram-bridge";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const BOT = 777;
const GROUP = -1001234500001;
const OTHER_GROUP = -1001234500002;
const CANARY = "CANARY-purple-elephant-7731 please read my notes";

let bodies: { url: string; body: Record<string, any> }[];
let logs: string[];
let nextId: number;
let postOk: boolean;
let dir: string;
const saved: Record<string, any> = {};

beforeEach(() => {
	bodies = [];
	logs = [];
	nextId = 100;
	postOk = true;
	dir = mkdtempSync(join(tmpdir(), "gv-test-"));
	saved.fetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		let body: Record<string, any> = {};
		try {
			body = init?.body ? JSON.parse(init.body) : {};
		} catch {}
		bodies.push({ url: String(url), body });
		if (!postOk) return new Response(JSON.stringify({ ok: false }), { status: 400 });
		return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
	}) as unknown as typeof fetch;
	for (const k of ["log", "warn", "error", "info"] as const) {
		saved[k] = console[k];
		console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
	}
});
afterEach(() => {
	globalThis.fetch = saved.fetch;
	for (const k of ["log", "warn", "error", "info"] as const) console[k] = saved[k];
	bindChatThread("0", undefined);
	rmSync(dir, { recursive: true, force: true });
});

const sends = () => bodies.filter((x) => /\/(sendMessage|sendVoice)$/.test(x.url));
const allText = () => JSON.stringify(bodies.map((x) => x.body));

function make(over: Record<string, unknown> = {}, envOver: Record<string, string> = {}) {
	const prompts: string[] = [];
	const heard: unknown[] = [];
	const transcribed: string[] = [];
	const said: { text: string; explicitChat?: string; threadId?: number; expectedChatId: string }[] =
		[];
	const cos: string[] = [];
	const judge: string[] = [];
	const real = createFlowModeController();
	const origHear = real.hear.bind(real);
	real.hear = ((...a: Parameters<typeof origHear>) => {
		heard.push(a);
		return origHear(...a);
	}) as typeof real.hear;
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(JAMES),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES), String(GROUP), String(OTHER_GROUP)],
		authorizedUserIds: [String(JAMES), String(ARTALE)],
		operatorUserIds: [String(JAMES)],
		flowController: real,
		voiceStatePath: join(dir, "voice.json"),
		observeLogPath: join(dir, "observed.jsonl"),
		env: { TELEGRAM_FLOW_VOICE_GROUP_IDS: String(GROUP), ...envOver },
		judgeModel: async (p: string) => {
			judge.push(p);
			return "{}";
		},
		spokenModel: async () => "Spoken draft.",
		sendVoiceNote: async (o: any) => {
			said.push(o);
			return { sent: true, reason: "ok" };
		},
		...over,
	}) as any;
	b.botId = BOT;
	b.botUsername = "eightbot";
	b.voiceEnabled = true;
	b.transcribe = async (_t: string, fileId: string) => {
		transcribed.push(fileId);
		return CANARY;
	};
	b.adapter = { handleUserMessage: async (t: string) => void prompts.push(t), close() {} };
	b.multiStepEnabled = true;
	b.cosRouter = {
		handleCommand: async (t: string) => {
			cos.push(t);
			return true;
		},
	};
	return { b, prompts, heard, transcribed, said, cos, judge, real };
}

const voiceMsg = (extra: Record<string, unknown> = {}, from = JAMES, chat = GROUP) =>
	({
		message_id: 5,
		from: { id: from, first_name: "x" },
		chat: { id: chat, type: "supergroup" },
		reply_to_message: { from: { id: BOT } },
		voice: { file_id: "SECRET-FILE-ID", duration: 3, file_size: 20_000 },
		...extra,
	}) as any;

/** The terminal daemon event for a legacy-path turn: posts the reply, speaks, ends the turn. */
async function agentReplies(b: any, text: string) {
	b.handleDaemonMessage({
		type: "event",
		event: "agent:stream",
		payload: { final: true, chunk: text },
	});
	await new Promise((r) => setTimeout(r, 30));
}
const ready = async (t: ReturnType<typeof make>) => {
	await t.b.ensureGroupVoiceNotices();
	bodies.length = 0;
	return t;
};

describe("G1 to G3: who and where", () => {
	test("G1: a non-operator member's note: no getFile, nothing sent, no refusal", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({}, ARTALE));
		await t.b.handleGroupVoice(voiceMsg({}, 9999));
		expect(t.transcribed).toEqual([]);
		expect(bodies).toEqual([]);
		expect(t.prompts).toEqual([]);
	});
	test("G1: the observe record for a drop holds sender, chat and duration, never the file id", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({}, ARTALE));
		const raw = readFileSync(join(dir, "observed.jsonl"), "utf8");
		const row = JSON.parse(raw.trim());
		expect(row).toMatchObject({
			kind: "voice-dropped",
			chat_id: GROUP,
			from_id: ARTALE,
			duration_s: 3,
		});
		expect(raw).not.toContain("SECRET-FILE-ID");
	});
	test("G2: operator in a chat-allowlisted group that is not on the voice list: nothing", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({}, JAMES, OTHER_GROUP));
		expect(t.transcribed).toEqual([]);
		expect(bodies).toEqual([]);
	});
	test("G3: operator in the listed group, not a reply to the bot: ignored", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({ reply_to_message: undefined }));
		await t.b.handleGroupVoice(voiceMsg({ reply_to_message: { from: { id: 12345 } } }));
		expect(t.transcribed).toEqual([]);
		expect(bodies).toEqual([]);
	});
});

describe("G4: the happy path and no transcript in any group string", () => {
	test("transcribed once; every outbound goes to that chat; the canary is in no message", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual(["SECRET-FILE-ID"]);
		expect(t.prompts).toEqual([CANARY]); // the agent gets it, the room does not
		await agentReplies(t.b, "Done, the branch is pushed.");
		for (const x of bodies) expect(String(x.body.chat_id)).toBe(String(GROUP));
		expect(allText()).not.toContain("CANARY");
		expect(allText()).not.toContain("Heard");
		expect(logs.join("\n")).not.toContain("CANARY");
		expect(logs.join("\n")).not.toContain("SECRET-FILE-ID");
	});
	test("a '[' transcript is never echoed raw; our own status strings are", async () => {
		const t = await ready(make());
		t.b.transcribe = async () => `[Music] ${CANARY}`;
		await t.b.handleGroupVoice(voiceMsg());
		expect(allText()).not.toContain("CANARY");
		expect(allText()).toContain("could not be processed");
		expect(t.prompts).toEqual([]);
		const t2 = await ready(make());
		t2.b.transcribe = async () => "[could not download voice message]";
		await t2.b.handleGroupVoice(voiceMsg());
		expect(allText()).toContain("could not download voice message");
	});
});

describe("G5 and G6: identity and provenance", () => {
	test("G5: anonymous admin (GroupAnonymousBot, sender_chat = the group) is dropped", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(
			voiceMsg({ sender_chat: { id: GROUP, type: "supergroup" } }, 1087968824),
		);
		// even with the operator's own id, a sender_chat means it is not a person
		await t.b.handleGroupVoice(voiceMsg({ sender_chat: { id: GROUP, type: "supergroup" } }));
		expect(t.transcribed).toEqual([]);
		expect(bodies).toEqual([]);
	});
	for (const field of [
		"forward_origin",
		"forward_from",
		"forward_from_chat",
		"forward_date",
		"forward_sender_name",
		"is_automatic_forward",
		"via_bot",
		"external_reply",
	]) {
		test(`G6: ${field} on an otherwise valid operator note is dropped`, async () => {
			const t = await ready(make());
			await t.b.handleGroupVoice(voiceMsg({ [field]: field === "forward_date" ? 1 : { id: 1 } }));
			expect(t.transcribed).toEqual([]);
			expect(bodies).toEqual([]);
			expect(isForwardedLike({ [field]: field === "forward_date" ? 1 : true })).toBe(true);
		});
	}
});

describe("G7: voice only, capped before getFile", () => {
	test("message.audio from the operator is not accepted", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(
			voiceMsg({ voice: undefined, audio: { file_id: "A", duration: 5, file_size: 1000 } }),
		);
		expect(t.transcribed).toEqual([]);
		expect(bodies).toEqual([]);
	});
	test("61 s and 2 MB are refused with a fixed string, before getFile", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(
			voiceMsg({ voice: { file_id: "L", duration: 61, file_size: 5000 } }),
		);
		await t.b.handleGroupVoice(
			voiceMsg({ voice: { file_id: "B", duration: 5, file_size: 2 * 1024 * 1024 } }),
		);
		await t.b.handleGroupVoice(voiceMsg({ voice: { file_id: "N", duration: 5 } })); // no size: fail closed
		expect(t.transcribed).toEqual([]);
		expect(sends().map((x) => x.body.text)).toEqual([
			GROUP_VOICE_TOO_BIG,
			GROUP_VOICE_TOO_BIG,
			GROUP_VOICE_TOO_BIG,
		]);
	});
	test("60 s and 1 MB exactly are accepted", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(
			voiceMsg({ voice: { file_id: "E", duration: 60, file_size: 1024 * 1024 } }),
		);
		expect(t.transcribed).toEqual(["E"]);
	});
	test("a cloud runtime gets the fixed needs-local sentence, only for the admitted operator", async () => {
		const t = await ready(make({}, { DEFAULT_RUNTIME: "openrouter" }));
		await t.b.handleGroupVoice(voiceMsg({}, ARTALE));
		expect(bodies).toEqual([]);
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual([]);
		expect(sends().length).toBe(1);
		expect(String(sends()[0]?.body.text)).toContain("Voice notes are off");
	});
	test("the poll loop sends every group voice note to handleGroupVoice, never the DM path", async () => {
		globalThis.fetch = saved.fetch;
		let served = false;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				if (!new URL(req.url).pathname.endsWith("/getUpdates"))
					return Response.json({ ok: true, result: [] });
				if (!served) {
					served = true;
					return Response.json({
						ok: true,
						result: [{ update_id: 1, message: voiceMsg() }],
					});
				}
				await new Promise((r) => setTimeout(r, 50));
				return Response.json({ ok: true, result: [] });
			},
		});
		const t = make({
			telegramApiBase: `http://127.0.0.1:${server.port}/bot`,
			poll: { timeoutSec: 0, abortGraceMs: 200, backoffBaseMs: 10, backoffMaxMs: 40 },
		});
		const got: string[] = [];
		t.b.handleGroupVoice = async () => void got.push("group");
		t.b.handleVoiceMessage = async () => void got.push("dm");
		t.b.admitVoice = async () => {
			got.push("admit");
			return true;
		};
		try {
			t.b.startPolling();
			const t0 = Date.now();
			while (got.length === 0 && Date.now() - t0 < 4000)
				await new Promise((r) => setTimeout(r, 10));
		} finally {
			t.b.stop();
			server.stop(true);
		}
		expect(got).toEqual(["group"]);
	});
});

describe("G8: routing, per turn and in both directions", () => {
	// The toggle is off here so only a voice-note arm could speak.
	const dmText = (t: ReturnType<typeof make>) =>
		t.b.handleTelegramMessage("hello from the DM", JAMES, { chatType: "private", fromId: JAMES });

	test("group voice turn, then a DM text turn: the reply goes to the DM, unspoken, nothing in the group", async () => {
		const t = await ready(make());
		t.b.voiceEnabled = false;
		await t.b.handleGroupVoice(voiceMsg());
		await dmText(t); // a new turn replaces the group binding
		bodies.length = 0;
		await agentReplies(t.b, "dm answer");
		const out = sends();
		expect(out.length).toBe(1);
		expect(String(out[0]?.body.chat_id)).toBe(String(JAMES));
		expect(t.said).toEqual([]);
	});
	test("DM voice note, then a group text turn: the group reply is not spoken, nothing to the DM", async () => {
		const t = await ready(make());
		t.b.voiceEnabled = false;
		t.b.transcribe = async () => CANARY;
		await t.b.handleVoiceMessage(
			{
				chat: { id: JAMES, type: "private" },
				from: { id: JAMES },
				voice: { file_id: "f", duration: 1 },
			},
			"f",
		);
		bodies.length = 0;
		await t.b.handleTelegramMessage("@eightbot status please", GROUP, {
			chatType: "supergroup",
			fromId: JAMES,
			entities: [{ type: "mention", offset: 0, length: 9 }],
		});
		await agentReplies(t.b, "group answer");
		const out = sends();
		expect(out.length).toBe(1);
		expect(String(out[0]?.body.chat_id)).toBe(String(GROUP));
		expect(t.said).toEqual([]);
	});
	test("group voice turn, then an operator DM voice note: Heard goes only to the DM", async () => {
		const t = await ready(make());
		t.b.voiceEnabled = false;
		await t.b.handleGroupVoice(voiceMsg());
		await agentReplies(t.b, "group answer");
		bodies.length = 0;
		await t.b.handleVoiceMessage(
			{
				chat: { id: JAMES, type: "private" },
				from: { id: JAMES },
				voice: { file_id: "f", duration: 1 },
			},
			"f",
		);
		const heardTo = sends()
			.filter((x) => String(x.body.text).startsWith("Heard:"))
			.map((x) => String(x.body.chat_id));
		expect(heardTo).toEqual([String(JAMES)]);
	});
	test("the terminal event resets the sticky origin and the binding", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		expect(t.b.originChatId).toBe(String(GROUP));
		await agentReplies(t.b, "done");
		expect(t.b.originChatId).toBeNull();
		expect(t.b.groupVoiceTurn).toBeNull();
		bodies.length = 0;
		await tgSend("tok", String(GROUP), "later"); // no binding left: no topic
		expect(bodies[0]?.body.message_thread_id).toBeUndefined();
	});
});

describe("G9: topics", () => {
	test("a note in topic 7: typing, text and the spoken note all carry 7", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		await agentReplies(t.b, "Done.");
		const ours = bodies.filter((x) => String(x.body.chat_id) === String(GROUP));
		expect(ours.length).toBeGreaterThan(1);
		for (const x of ours) expect(x.body.message_thread_id).toBe(7);
		const spoken = t.said.filter((x) => x.text !== "Got it, give me a minute.");
		expect(spoken.length).toBe(1);
		expect(spoken[0]?.threadId).toBe(7);
		expect(spoken[0]?.explicitChat).toBe(String(GROUP));
	});
	test("a note with no topic: nothing carries one", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		await agentReplies(t.b, "Done.");
		for (const x of bodies) expect(x.body.message_thread_id).toBeUndefined();
		expect(t.said.every((x) => x.threadId === undefined)).toBe(true);
	});
	test("a refusal in a topic carries the topic too", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(
			voiceMsg({ message_thread_id: 9, voice: { file_id: "L", duration: 99, file_size: 10 } }),
		);
		expect(sends()[0]?.body.message_thread_id).toBe(9);
	});
	test("the adapter and file sender are handed the per-turn topic", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		expect(t.b.boundThread()).toBe(7);
		await t.b.handleTelegramMessage("hello from the DM", JAMES, {
			chatType: "private",
			fromId: JAMES,
		});
		expect(t.b.boundThread()).toBeUndefined();
	});
});

describe("G10 to G12: no cards, modes, slash commands or judge", () => {
	test("G10: 'act mode' in the group: no controller.hear, no card, mode unchanged", async () => {
		const t = await ready(make());
		t.b.transcribe = async () => "go to act mode";
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.heard).toEqual([]);
		expect(bodies.some((x) => x.body.reply_markup)).toBe(false);
		expect(t.real.mode).toBe("act");
		expect(t.prompts).toEqual(["go to act mode"]); // just a prompt
	});
	test("G10: a forged callback on a DM token, message.chat = the group: refused, token not consumed", async () => {
		const t = await ready(make());
		await t.b.handleTelegramMessage("/mode", JAMES, { chatType: "private", fromId: JAMES });
		const card = bodies.find((x) => x.body.reply_markup);
		const data = card?.body.reply_markup.inline_keyboard[0][0].callback_data as string;
		const messageId = nextId - 1;
		await t.b.handleCallbackQuery({
			id: "q",
			from: { id: JAMES },
			data,
			message: { message_id: messageId, chat: { id: GROUP, type: "supergroup" } },
		});
		expect(t.real.log.filter((l) => l.accepted)).toEqual([]);
		// the token is still live: the real DM tap works once afterwards
		await t.b.handleCallbackQuery({
			id: "q2",
			from: { id: JAMES },
			data,
			message: { message_id: messageId, chat: { id: JAMES, type: "private" } },
		});
		expect(t.real.log.filter((l) => l.accepted).length).toBe(1);
	});
	test("G10: mint with a supergroup or group returns null", () => {
		const store = createPendingStore();
		expect(store.mint("menu", GROUP, "supergroup", [{ to: "think" }])).toBeNull();
		expect(store.mint("menu", GROUP, "group", [{ to: "think" }])).toBeNull();
		expect(store.size()).toBe(0);
	});
	for (const say of [
		"/kill all",
		"/delegate x",
		"/run rm -rf x",
		"/deploy",
		"/mode quiet",
		"/voice off",
	]) {
		test(`G11: transcript "${say}" is a plain prompt, no command handler runs`, async () => {
			const t = await ready(make());
			t.b.transcribe = async () => say;
			await t.b.handleGroupVoice(voiceMsg());
			expect(t.cos).toEqual([]);
			expect(t.prompts).toEqual([say]);
			expect(t.b.voiceEnabled).toBe(true);
			expect(t.real.mode).toBe("act");
			expect(bodies.some((x) => x.body.reply_markup)).toBe(false);
		});
	}
	test("G11: typed slash commands still work exactly as before (the plain flag is voice only)", async () => {
		const t = await ready(make());
		await t.b.handleTelegramMessage("/plan x", JAMES, { chatType: "private", fromId: JAMES });
		expect(t.cos).toEqual(["/plan x"]);
	});
	test("G12: the judge model is never called for a group note", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		await new Promise((r) => setTimeout(r, 30));
		expect(t.judge).toEqual([]);
		expect(t.heard).toEqual([]);
	});
});

describe("G13: the spoken reply", () => {
	test("the draft input is the posted reply and nothing else; spoken once, to the group", async () => {
		const prompts: string[] = [];
		const t = await ready(
			make({
				spokenModel: async (p: string) => {
					prompts.push(p);
					return "Spoken draft.";
				},
			}),
		);
		await t.b.handleGroupVoice(voiceMsg());
		await agentReplies(t.b, "The build is green.");
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.endsWith("The build is green.")).toBe(true);
		expect(prompts[0]).not.toContain("CANARY");
		expect(t.said.filter((x) => x.text !== "Got it, give me a minute.")).toEqual([
			expect.objectContaining({
				text: "Spoken draft.",
				explicitChat: String(GROUP),
				expectedChatId: String(GROUP),
			}),
		]);
		// consumed once: a second reply in the window is text only
		await agentReplies(t.b, "Another reply.");
		expect(
			t.said.filter((x) => x.explicitChat && x.text !== "Got it, give me a minute.").length,
		).toBe(1);
	});
	test("/voice off silences the group", async () => {
		const t = await ready(make());
		t.b.voiceEnabled = false;
		await t.b.handleGroupVoice(voiceMsg());
		await agentReplies(t.b, "Done.");
		expect(t.said).toEqual([]);
		expect(sends().some((x) => x.body.text === "Done.")).toBe(true); // the text still lands
	});
	test("a typed group turn is not spoken by a group voice arm", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		await agentReplies(t.b, "first");
		t.said.length = 0;
		await t.b.maybeSpeak("typed reply with nothing armed");
		expect(t.said.filter((x) => x.explicitChat)).toEqual([]);
	});
	test("sendVoiceNote: a group goes by --chat and only to the chat the turn names", async () => {
		const bin = join(dir, "tts");
		const out = join(dir, "args.txt");
		writeFileSync(bin, `#!/bin/bash\necho "$@" > ${out}\ncat > /dev/null\n`, { mode: 0o755 });
		const ok = await sendVoiceNote({
			text: "hi",
			voice: "Jasper",
			expectedChatId: String(GROUP),
			explicitChat: String(GROUP),
			bin,
			resolveConfiguredChatId: () => String(JAMES),
		});
		expect(ok.sent).toBe(true);
		expect(readFileSync(out, "utf8").trim()).toBe(`--voice Jasper --chat ${GROUP}`);
		const bad = await sendVoiceNote({
			text: "hi",
			voice: "Jasper",
			expectedChatId: String(JAMES),
			explicitChat: String(GROUP),
			bin,
		});
		expect(bad.sent).toBe(false);
	});
	test("sendVoiceNote: a topic is spoken only if the TTS bridge declares --thread, else silent", async () => {
		const plain = join(dir, "tts-plain");
		writeFileSync(plain, "#!/bin/bash\ncat > /dev/null\n", { mode: 0o755 });
		const r1 = await sendVoiceNote({
			text: "hi",
			voice: "J",
			expectedChatId: String(GROUP),
			explicitChat: String(GROUP),
			threadId: 7,
			bin: plain,
		});
		expect(r1).toEqual({ sent: false, reason: "TTS bridge cannot address a topic" });
		const out = join(dir, "args2.txt");
		const aware = join(dir, "tts-aware");
		writeFileSync(
			aware,
			`#!/bin/bash\n# --thread) THREAD=$2\necho "$@" > ${out}\ncat > /dev/null\n`,
			{ mode: 0o755 },
		);
		const r2 = await sendVoiceNote({
			text: "hi",
			voice: "J",
			expectedChatId: String(GROUP),
			explicitChat: String(GROUP),
			threadId: 7,
			bin: aware,
		});
		expect(r2.sent).toBe(true);
		expect(readFileSync(out, "utf8").trim()).toBe(`--voice J --chat ${GROUP} --thread 7`);
	});
});

describe("G14: the notice", () => {
	const EXACT =
		"In this group, voice notes from the operator that reply to this bot are transcribed on the operator's machine (ffmpeg plus whisper-cli, no cloud STT). Everything posted in this group, including those voice notes and our spoken replies, is visible to every member and is stored and relayed by Telegram. Group chats are not end-to-end encrypted. Voice notes from anyone else are ignored: they are not downloaded or transcribed. The transcript is never posted here. No audio or transcript is sent to any rented model API.";
	test("the constant is the ruled string and avoids the banned words (C15)", () => {
		expect(R10_GROUP_NOTICE).toBe(EXACT);
		for (const w of ["private", "offline", "sovereign"]) {
			expect(R10_GROUP_NOTICE.toLowerCase()).not.toContain(w);
		}
		expect(R10_GROUP_NOTICE).not.toBe(R10_TRANSIT_NOTICE);
	});
	test("docs/telegram-bridge-voice.md carries the exact string", () => {
		const doc = readFileSync(join(import.meta.dir, "../../docs/telegram-bridge-voice.md"), "utf8");
		expect(doc).toContain(EXACT);
		expect(doc).toContain("TELEGRAM_FLOW_VOICE_GROUP_IDS");
	});
	test("/help in the listed group shows it and not the private-chat sentence", async () => {
		const t = await ready(make());
		await t.b.handleTelegramMessage("/help@eightbot", GROUP, {
			chatType: "supergroup",
			fromId: JAMES,
		});
		const help = String(sends().at(-1)?.body.text);
		expect(help).toContain(EXACT);
		expect(help).not.toContain("operator's own private chat");
		// the DM keeps its own notice
		bodies.length = 0;
		await t.b.handleTelegramMessage("/help", JAMES, { chatType: "private", fromId: JAMES });
		expect(String(sends().at(-1)?.body.text)).toContain(R10_TRANSIT_NOTICE);
		expect(String(sends().at(-1)?.body.text)).not.toContain(EXACT);
	});
	test("a non-operator's /help in the listed group learns it too", async () => {
		const t = await ready(make());
		await t.b.handleTelegramMessage("/help@eightbot", GROUP, {
			chatType: "supergroup",
			fromId: ARTALE,
		});
		expect(String(sends().at(-1)?.body.text)).toContain(EXACT);
	});
	test("posted once into the group, not again on restart, again when the wording changes", async () => {
		const t = make();
		await t.b.ensureGroupVoiceNotices();
		await t.b.ensureGroupVoiceNotices();
		const posts = () => bodies.filter((x) => x.body.text === EXACT);
		expect(posts().length).toBe(1);
		expect(String(posts()[0]?.body.chat_id)).toBe(String(GROUP));
		const restarted = make();
		await restarted.b.ensureGroupVoiceNotices();
		expect(posts().length).toBe(1);
		const path = join(dir, "voice.json");
		const state = JSON.parse(readFileSync(path, "utf8"));
		expect(state.groupNotices[String(GROUP)]).toBe(groupNoticeHash());
		state.groupNotices[String(GROUP)] = "old-wording";
		writeFileSync(path, JSON.stringify(state));
		await make().b.ensureGroupVoiceNotices();
		expect(posts().length).toBe(2);
	});
	test("the /voice toggle keeps the notice record", () => {
		const path = join(dir, "voice.json");
		writeFileSync(
			path,
			JSON.stringify({ enabled: false, updatedAt: "", groupNotices: { x: "h" } }),
		);
		writeVoiceState(true, path);
		expect(readVoiceState(path).groupNotices).toEqual({ x: "h" });
	});
	test("a failed post leaves group voice off for that chat", async () => {
		const t = make();
		postOk = false;
		await t.b.ensureGroupVoiceNotices();
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual([]);
		postOk = true;
		await t.b.ensureGroupVoiceNotices();
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed.length).toBe(1);
	});
	test("before the notice is posted, voice is off", async () => {
		const t = make();
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual([]);
	});
});

describe("G15: config fails closed", () => {
	test("empty, missing and junk mean off", async () => {
		for (const v of ["", " ", "junk", "*", "all", "-", "12abc", "1001234500001"]) {
			const t = make({}, { TELEGRAM_FLOW_VOICE_GROUP_IDS: v });
			await t.b.ensureGroupVoiceNotices();
			await t.b.handleGroupVoice(voiceMsg());
			expect(t.transcribed).toEqual([]);
			expect(groupVoiceIds({ TELEGRAM_FLOW_VOICE_GROUP_IDS: v })).toEqual([]);
		}
		const none = make({ env: {} });
		await none.b.ensureGroupVoiceNotices();
		await none.b.handleGroupVoice(voiceMsg());
		expect(none.transcribed).toEqual([]);
	});
	test("an id off by one digit means off", async () => {
		const t = make({}, { TELEGRAM_FLOW_VOICE_GROUP_IDS: String(GROUP - 1) });
		await t.b.ensureGroupVoiceNotices();
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual([]);
	});
	test("a chat on TELEGRAM_AUTHORIZED_CHAT_IDS alone does not turn voice on", async () => {
		const t = make({}, { TELEGRAM_FLOW_VOICE_GROUP_IDS: "" });
		await t.b.ensureGroupVoiceNotices();
		await t.b.handleGroupVoice(voiceMsg({}, JAMES, OTHER_GROUP));
		expect(t.transcribed).toEqual([]);
	});
	test("a listed id that is not on the chat allowlist gets no notice and no voice", async () => {
		const t = make({ authorizedChatIds: [String(JAMES)] });
		await t.b.ensureGroupVoiceNotices();
		expect(bodies).toEqual([]);
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual([]);
	});
	test("a private chat id on the list never counts: type must be group or supergroup", async () => {
		const t = make({}, { TELEGRAM_FLOW_VOICE_GROUP_IDS: `${GROUP},-5` });
		await t.b.ensureGroupVoiceNotices();
		const m = voiceMsg();
		m.chat.type = "channel";
		await t.b.handleGroupVoice(m);
		expect(t.transcribed).toEqual([]);
	});
	test("the allowlist value is not in code", () => {
		const src = readFileSync(join(import.meta.dir, "telegram-bridge.ts"), "utf8");
		expect(src).not.toContain("1003845259821");
	});
	test("a second operator in the env does not widen it: only the ruled operator id", async () => {
		const t = make({ operatorUserIds: [String(JAMES), String(ARTALE)] });
		await ready(t);
		await t.b.handleGroupVoice(voiceMsg({}, ARTALE));
		expect(t.transcribed).toEqual([]);
	});
});

describe("G16: canary", () => {
	test("in no log, group message, card, observe row, state file or temp file", async () => {
		const before = readdirSync(tmpdir()).filter((f) => f.startsWith("tg-voice-"));
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		await t.b.handleGroupVoice(voiceMsg({}, ARTALE));
		await agentReplies(t.b, "Done.");
		expect(logs.join("\n")).not.toContain("CANARY");
		expect(allText()).not.toContain("CANARY");
		expect(readFileSync(join(dir, "observed.jsonl"), "utf8")).not.toContain("CANARY");
		expect(readFileSync(join(dir, "voice.json"), "utf8")).not.toContain("CANARY");
		const row = logs.find((l) => l.includes("group voice turn")) ?? "";
		expect(row).toContain('"outcome":"dispatched"');
		expect(row).not.toContain("SECRET-FILE-ID");
		expect(Object.keys(JSON.parse(row.slice(row.indexOf("{"))))).toEqual([
			"at",
			"chat",
			"thread",
			"from",
			"duration_s",
			"outcome",
		]);
		expect(readdirSync(tmpdir()).filter((f) => f.startsWith("tg-voice-"))).toEqual(before);
	});
	test("a failed download leaves no temp audio behind", async () => {
		const before = readdirSync(tmpdir()).filter((f) => f.startsWith("tg-voice-"));
		const out = await transcribeVoice("tok", "SECRET-FILE-ID");
		expect(out.startsWith("[")).toBe(true);
		expect(readdirSync(tmpdir()).filter((f) => f.startsWith("tg-voice-"))).toEqual(before);
	});
});

describe("G17: concurrency", () => {
	test("two notes back to back: the second is refused, never answered into the first's binding", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 8, message_id: 6 }));
		expect(t.transcribed.length).toBe(1);
		expect(t.b.groupVoiceTurn.threadId).toBe(7);
		const refusal = sends().find((x) => x.body.text === GROUP_VOICE_BUSY);
		expect(refusal?.body.message_thread_id).toBe(8);
		await agentReplies(t.b, "first reply");
		const reply = sends().find((x) => x.body.text === "first reply");
		expect(reply?.body.message_thread_id).toBe(7);
	});
	test("with the agent busy the note is refused before getFile", async () => {
		const t = await ready(make());
		t.b.agentBusy = true;
		await t.b.handleGroupVoice(voiceMsg());
		expect(t.transcribed).toEqual([]);
		expect(sends().map((x) => x.body.text)).toEqual([GROUP_VOICE_BUSY]);
	});
	test("a turn that never ended stops blocking after the in-flight window", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		t.b.groupVoiceTurn.at -= 6 * 60_000;
		await t.b.handleGroupVoice(voiceMsg({ message_id: 6 }));
		expect(t.transcribed.length).toBe(2);
	});
});

describe("instant acknowledgement", () => {
	const ACK = "Got it, give me a minute.";
	const acks = (t: ReturnType<typeof make>) => t.said.filter((x) => x.text === ACK);

	test("one spoken ack per accepted group note, bound to that chat and topic", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		expect(acks(t).length).toBe(1);
		expect(acks(t)[0]).toMatchObject({ explicitChat: String(GROUP), threadId: 7 });
		expect(sends().some((x) => x.body.text === ACK)).toBe(false); // spoken, so no text copy
	});
	test("the spoken ack is relevant to the transcript, from the real handler", async () => {
		const t = await ready(make());
		t.b.transcribe = async () => "what is the status of the pull request";
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		const said = t.said.filter((x) => x.text === "Checking the PR status now");
		expect(said.length).toBe(1);
		expect(said[0]).toMatchObject({ explicitChat: String(GROUP), threadId: 7 });
		expect(acks(t)).toEqual([]);
	});
	test("slow transcription: generic ack goes out at the 1.5 s budget, not after whisper", async () => {
		const t = await ready(make());
		// A real child that runs 3 s. With spawnSync this froze the loop and the ack came late.
		t.b.transcribe = async () => {
			await runAsync("sleep", ["3"], 10_000);
			return "what is the status of the pull request";
		};
		const t0 = Date.now();
		const turn = t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		while (acks(t).length === 0 && Date.now() - t0 < 2800) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const at = Date.now() - t0;
		expect(acks(t).length).toBe(1); // generic, spoken while transcription still runs
		expect(at).toBeLessThan(2000);
		await turn;
		expect(t.said.filter((x) => x.text === "Checking the PR status now")).toEqual([]);
		process.stdout.write(`measured: generic ack spoken at ${at} ms, transcription 3000 ms\n`);
	});
	test("runAsync never blocks the event loop and times out", async () => {
		let ticks = 0;
		const iv = setInterval(() => ticks++, 50);
		const r = await runAsync("sleep", ["1"], 10_000);
		clearInterval(iv);
		expect(r.status).toBe(0);
		expect(ticks).toBeGreaterThan(10);
		const k = await runAsync("sleep", ["5"], 200);
		expect(k.status).toBeNull();
	});
	test("runAsync caps each stream at 1 MiB and keeps draining", async () => {
		const r = await runAsync(
			"sh",
			["-c", "head -c 3000000 /dev/zero | tr '\\0' a; head -c 3000000 /dev/zero | tr '\\0' b >&2"],
			20_000,
		);
		expect(r.status).toBe(0);
		expect(r.stdout.length).toBe(RUN_ASYNC_MAX_BYTES);
		expect(r.stderr.length).toBe(RUN_ASYNC_MAX_BYTES);
	});
	test("a timed-out child is dead after SIGKILL", async () => {
		const r = await runAsync("sleep", ["30"], 200);
		expect(r.status).toBeNull();
		expect(typeof r.pid).toBe("number");
		await new Promise((x) => setTimeout(x, 100));
		let err: NodeJS.ErrnoException | undefined;
		try {
			process.kill(r.pid as number, 0);
		} catch (e) {
			err = e as NodeJS.ErrnoException;
		}
		expect(err?.code).toBe("ESRCH");
	});
	test("no ack for a dropped or rejected note", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg({}, ARTALE));
		await t.b.handleGroupVoice(voiceMsg({ reply_to_message: undefined }));
		await t.b.handleGroupVoice(voiceMsg({ via_bot: { id: 1 } }));
		await t.b.handleGroupVoice(voiceMsg({ voice: { file_id: "L", duration: 99, file_size: 1 } }));
		expect(acks(t)).toEqual([]);
		expect(sends().some((x) => x.body.text === ACK)).toBe(false);
		const off = await ready(make({}, { TELEGRAM_FLOW_VOICE_GROUP_IDS: "" }));
		await off.b.handleGroupVoice(voiceMsg());
		expect(acks(off)).toEqual([]);
	});
	test("a DM note is acked once to the DM only, after admission", async () => {
		const t = await ready(make());
		t.b.admitVoice = async () => true;
		globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
			const u = String(url);
			if (u.endsWith("/getUpdates")) return new Response("{}");
			bodies.push({ url: u, body: init?.body ? JSON.parse(init.body) : {} });
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
		}) as unknown as typeof fetch;
		await t.b.ackVoice(String(JAMES));
		expect(acks(t)).toEqual([expect.objectContaining({ expectedChatId: String(JAMES) })]);
		expect(acks(t)[0]?.explicitChat).toBeUndefined();
	});
	test("a DM note while the bot is busy, or on a cloud runtime, gets no ack", async () => {
		const t = await ready(make());
		t.b.agentBusy = true;
		await t.b.ackDmVoice(JAMES);
		expect(t.said).toEqual([]);
		expect(sends().some((x) => x.body.text === ACK)).toBe(false);
		t.b.agentBusy = false;
		await t.b.ackDmVoice(JAMES);
		expect(acks(t).length).toBe(1);
		const cloud = await ready(make({}, { DEFAULT_RUNTIME: "openrouter" }));
		await cloud.b.ackDmVoice(JAMES);
		expect(cloud.said).toEqual([]);
	});
	test("TTS failure falls back to the same short text in the same chat and topic", async () => {
		const t = await ready(make({ sendVoiceNote: async () => ({ sent: false, reason: "down" }) }));
		await t.b.handleGroupVoice(voiceMsg({ message_thread_id: 7 }));
		const text = sends().filter((x) => x.body.text === ACK);
		expect(text.length).toBe(1);
		expect(String(text[0]?.body.chat_id)).toBe(String(GROUP));
		expect(text[0]?.body.message_thread_id).toBe(7);
		const thrown = await ready(
			make({
				sendVoiceNote: async () => {
					throw new Error("boom");
				},
			}),
		);
		await thrown.b.handleGroupVoice(voiceMsg());
		expect(sends().filter((x) => x.body.text === ACK).length).toBe(1);
	});
	test("with /voice off the group gets the text ack, not audio", async () => {
		const t = await ready(make());
		t.b.voiceEnabled = false;
		await t.b.handleGroupVoice(voiceMsg());
		expect(acks(t)).toEqual([]);
		expect(sends().filter((x) => x.body.text === ACK).length).toBe(1);
	});
	test("the ack is the fixed phrase and carries no transcript", async () => {
		const t = await ready(make());
		await t.b.handleGroupVoice(voiceMsg());
		expect(allText()).not.toContain("CANARY");
	});
});
