/**
 * L7: the voice loop and flow cards through the real bridge handlers, fetch
 * stubbed so nothing leaves the box. Covers 8SO attack tests T1-T10 on the
 * bridge side; the card and token mechanics are in flow-bot.test.ts.
 *
 * The flow controller is the real one from packages/flow.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FlowModeController, createFlowModeController } from "../flow/flow-mode";
import { setDjSpawn, setDjTools } from "../music/dj";
import { R10_TRANSIT_NOTICE } from "../telegram-bot/voice-mode";
import {
	OPERATOR_COMMANDS,
	TelegramDaemonBridge,
	VOICE_NEEDS_LOCAL,
	voicePathIsLocal,
} from "./telegram-bridge";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const GROUP = -1001;
const CANARY = "CANARY-purple-elephant-7731 please read my notes";

let bodies: { url: string; body: Record<string, any> }[];
let logs: string[];
let nextId: number;
const saved: Record<string, any> = {};

beforeEach(() => {
	bodies = [];
	logs = [];
	nextId = 100;
	saved.fetch = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		let body: Record<string, any> = {};
		try {
			body = init?.body ? JSON.parse(init.body) : {};
		} catch {}
		bodies.push({ url: String(url), body });
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
});

/** What the real controller accepted, in order. */
const appliedOf = (real: FlowModeController) =>
	real.log.filter((l) => l.accepted).map((l) => ({ to: l.to, origin: l.origin }));

function make(over: Record<string, unknown> = {}, transcript = CANARY, judgeReply = "{}") {
	const prompts: string[] = [];
	const dispatched: string[] = [];
	const real = createFlowModeController();
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(JAMES),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES), String(GROUP)],
		authorizedUserIds: [String(JAMES), String(ARTALE)],
		operatorUserIds: [String(JAMES)],
		flowController: real,
		env: {},
		judgeModel: async (p: string) => {
			prompts.push(p);
			return judgeReply;
		},
		...over,
	}) as any;
	// Hermetic: the constructor seeds voiceEnabled from the operator's real
	// ~/.8gent/telegram-voice.json, so a machine with /voice on made every
	// "does not speak" test fail (#4875). Each test starts with voice off.
	b.voiceEnabled = false;
	b.transcribe = async () => transcript;
	b.dispatchTranscript = async (t: string) => void dispatched.push(t);
	return {
		b: b as any,
		/** Judge prompts: one per operator voice note that reached the judge. */
		signals: prompts,
		dispatched,
		real,
		applied: () => appliedOf(real),
	};
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const voice = (from: number, chat: { id: number; type: string }, extra: object = {}) =>
	({
		message_id: 1,
		from: { id: from },
		chat,
		voice: { file_id: "f", duration: 2 },
		...extra,
	}) as any;
const DM = { id: JAMES, type: "private" };
const recorder = (said: string[]) => async (o: { text: string }) => {
	said.push(o.text);
	return { sent: true, reason: "ok" };
};

describe("voice note to flow signal (C1 C3 C4 C6 T1 T2)", () => {
	test("a live operator DM voice note is one signal, transcript still dispatched", async () => {
		const t = make();
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.signals.length).toBe(1);
		expect(t.signals[0]).toContain(CANARY);
		expect(t.dispatched).toEqual([CANARY]);
	});
	test("T1: forwarded (forward_origin, then via_bot): no signal", async () => {
		const t = make();
		await t.b.handleVoiceMessage(voice(JAMES, DM, { forward_origin: { type: "user" } }), "f");
		await t.b.handleVoiceMessage(voice(JAMES, DM, { via_bot: { id: 9 } }), "f");
		expect(t.signals).toEqual([]);
		expect(t.dispatched.length).toBe(2); // still plain text, never a flow signal
	});
	test("C3 measured: admitVoice does NOT drop a forwarded DM voice note, so the flow path has its own check", async () => {
		const t = make();
		const forwarded = await t.b.admitVoice(voice(JAMES, DM, { forward_origin: { type: "user" } }));
		expect(forwarded).toBe(true); // transcribed as plain text; classifyVoice keeps it out of flow
	});
	test("T1: a forwarded copy of our own spoken reply is an echo: no signal", async () => {
		const t = make({}, "The build is green and the branch is pushed to the remote.");
		t.b.gate.ttsStarted("The build is green and the branch is pushed to the remote.");
		t.b.gate.ttsEnded();
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(t.signals).toEqual([]);
	});
	test("T2: Artale voice in a DM and in the group: no signal", async () => {
		const t = make();
		await t.b.handleVoiceMessage(voice(ARTALE, { id: ARTALE, type: "private" }), "f");
		await t.b.handleVoiceMessage(voice(ARTALE, { id: GROUP, type: "supergroup" }), "f");
		expect(t.signals).toEqual([]);
	});
	test("the operator in the group is not a flow signal either (C1)", async () => {
		const t = make();
		await t.b.handleVoiceMessage(voice(JAMES, { id: GROUP, type: "supergroup" }), "f");
		expect(t.signals).toEqual([]);
	});
	test("T9: empty operator list: no signal, /mode says off, no card", async () => {
		for (const over of [{ operatorUserIds: [] }, { operatorUserIds: undefined }]) {
			const t = make(over);
			await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
			await (t.b as any).handleTelegramMessage("/mode", JAMES, {
				chatType: "private",
				fromId: JAMES,
			});
			expect(t.signals).toEqual([]);
			expect(bodies.some((x) => x.body.reply_markup)).toBe(false);
		}
	});
});

describe("cards through the bridge (C9 T3 T4 T7)", () => {
	async function mintMenu(t: ReturnType<typeof make>) {
		await (t.b as any).handleTelegramMessage("/mode", JAMES, {
			chatType: "private",
			fromId: JAMES,
		});
		const card = bodies.find((x) => x.body.reply_markup);
		expect(card).toBeDefined();
		const btn = card?.body.reply_markup.inline_keyboard[0][0];
		return { data: btn.callback_data as string, messageId: nextId - 1 };
	}
	const q = (data: string, messageId: number, from = JAMES, chat: object = DM) => ({
		id: "q1",
		from: { id: from },
		data,
		message: { message_id: messageId, chat },
	});

	test("/mode in the operator DM mints a card; the tap applies user-button once", async () => {
		const t = make();
		const { data, messageId } = await mintMenu(t);
		await (t.b as any).handleCallbackQuery(q(data, messageId));
		expect(t.applied().length).toBe(1);
		expect(t.applied()[0]?.origin).toBe("user-button");
		await (t.b as any).handleCallbackQuery(q(data, messageId)); // replay
		expect(t.applied().length).toBe(1);
	});
	test("T3: non-operator, group copy, forwarded card, wrong message id: nothing applied", async () => {
		const t = make();
		const { data, messageId } = await mintMenu(t);
		await (t.b as any).handleCallbackQuery(
			q(data, messageId, ARTALE, { id: ARTALE, type: "private" }),
		);
		await (t.b as any).handleCallbackQuery(
			q(data, messageId, JAMES, { id: GROUP, type: "supergroup" }),
		);
		await (t.b as any).handleCallbackQuery(q(data, messageId + 1));
		expect(t.applied()).toEqual([]);
	});
	test("/mode in a group mints nothing and says nothing", async () => {
		const t = make();
		await (t.b as any).handleTelegramMessage("/mode", GROUP, {
			chatType: "supergroup",
			fromId: JAMES,
		});
		expect(bodies.some((x) => x.body.reply_markup)).toBe(false);
	});
	test("T7 / C21: a 'yes' voice note with an approve/deny card open approves nothing, switches nothing", async () => {
		const t = make({}, "yes");
		t.b.pendingApprovals.set("req1", {
			tool: "bash",
			input: {},
			chatId: String(JAMES),
			sessionId: "s",
			expiresAt: Date.now() + 60_000,
		});
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(t.b.pendingApprovals.has("req1")).toBe(true);
		expect(t.b.awaitingAck.size).toBe(0);
		expect(t.applied()).toEqual([]);
		// and with nothing pending
		const t2 = make({}, "yes");
		await t2.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(t2.applied()).toEqual([]);
	});
	test("existing approval cards still work through their own path (C9.1 does not touch them)", async () => {
		const t = make();
		t.b.pendingApprovals.set("req2", {
			tool: "bash",
			input: {},
			chatId: String(JAMES),
			sessionId: "s",
			expiresAt: Date.now() + 60_000,
		});
		t.b.answerApproval = () => {};
		await (t.b as any).handleCallbackQuery(q("approve:req2", 5));
		expect(t.b.pendingApprovals.has("req2")).toBe(false);
	});
});

describe("C5 / T5: edited messages and the poll loop", () => {
	test("an edited_message 'yes' is never delivered", async () => {
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
						result: [
							{
								update_id: 1,
								edited_message: { message_id: 1, from: { id: JAMES }, chat: DM, text: "yes" },
							},
							{
								update_id: 2,
								channel_post: { message_id: 2, chat: { id: -5, type: "channel" }, text: "yes" },
							},
							{
								update_id: 3,
								message: { message_id: 3, from: { id: JAMES }, chat: DM, text: "plain" },
							},
						],
					});
				}
				await new Promise((r) => setTimeout(r, 50));
				return Response.json({ ok: true, result: [] });
			},
		});
		const delivered: string[] = [];
		const b = new TelegramDaemonBridge({
			telegramToken: "123:fake",
			chatId: String(JAMES),
			daemonUrl: "ws://127.0.0.1:1",
			authorizedChatIds: [String(JAMES)],
			authorizedUserIds: [String(JAMES)],
			operatorUserIds: [String(JAMES)],
			telegramApiBase: `http://127.0.0.1:${server.port}/bot`,
			poll: { timeoutSec: 0, abortGraceMs: 200, backoffBaseMs: 10, backoffMaxMs: 40 },
		} as never) as any;
		b.handleTelegramMessage = async (text: string) => void delivered.push(text);
		try {
			b.startPolling();
			const t0 = Date.now();
			while (delivered.length === 0 && Date.now() - t0 < 4000)
				await new Promise((r) => setTimeout(r, 10));
		} finally {
			b.stop();
			server.stop(true);
		}
		expect(delivered).toEqual(["plain"]);
	});
});

describe("T10 / C17: canary in no log, no card, no flow row", () => {
	test("voice, signal, menu card and tap leave no canary in any log or card", async () => {
		const t = make();
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await (t.b as any).handleTelegramMessage("/mode", JAMES, {
			chatType: "private",
			fromId: JAMES,
		});
		const card = bodies.find((x) => x.body.reply_markup) as (typeof bodies)[number];
		const data = card.body.reply_markup.inline_keyboard[0][0].callback_data;
		await (t.b as any).handleCallbackQuery({
			id: "q",
			from: { id: JAMES },
			data,
			message: { message_id: nextId - 1, chat: DM },
		});
		expect(logs.join("\n")).not.toContain("CANARY");
		expect(logs.join("\n")).not.toContain(data.slice(3)); // C14: no token in logs
		// the canary appears only in the operator's own private "Heard" echo, never in a card or edit
		const leaks = bodies.filter(
			(x) => JSON.stringify(x.body).includes("CANARY") && !String(x.body.text).startsWith("Heard:"),
		);
		expect(leaks).toEqual([]);
	});
});

describe("spoken reply loop (L2 draft, quiet hours lifted)", () => {
	const speakVia = (t: ReturnType<typeof make>) =>
		(t.b as any).maybeSpeak("Done. See `a/b/c.ts` and https://x.io/y for details.");

	test("a reply to a voice note is spoken from the post-draft, with the full text already sent", async () => {
		const said: string[] = [];
		const t = make({
			spokenModel: async () => "All done. Details are on screen.",
			sendVoiceNote: recorder(said),
		});
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await speakVia(t);
		expect(said).toEqual(["All done. Details are on screen."]);
		// consumed once: the next reply is text only
		await speakVia(t);
		expect(said.length).toBe(1);
	});
	test("a typed message with /voice off gets no voice note", async () => {
		const said: string[] = [];
		const t = make({ sendVoiceNote: recorder(said) });
		(t.b as any).voiceEnabled = false;
		await speakVia(t);
		expect(said).toEqual([]);
	});
	test("model down: the deterministic draft is spoken, never silence", async () => {
		const said: string[] = [];
		const t = make({
			spokenModel: async () => {
				throw new Error("down");
			},
			sendVoiceNote: recorder(said),
		});
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await speakVia(t);
		expect(said.length).toBe(1);
		expect(said[0]).not.toMatch(/https?:|\/|`/);
	});
	test("a group voice note does not arm a spoken reply", async () => {
		const said: string[] = [];
		const t = make({ sendVoiceNote: recorder(said) });
		await t.b.handleVoiceMessage(voice(JAMES, { id: GROUP, type: "supergroup" }), "f");
		await speakVia(t);
		expect(said).toEqual([]);
	});
	test("spoken at 03:00: no quiet-hours hold", async () => {
		const real = Date;
		const said: string[] = [];
		const t = make({ spokenModel: null, sendVoiceNote: recorder(said) });
		(t.b as any).voiceEnabled = true;
		await speakVia(t);
		expect(said.length).toBe(1);
		expect(Date).toBe(real);
	});
});

describe("R9 / C22 and the operator list", () => {
	test("/mode is an operator command", () => {
		expect((OPERATOR_COMMANDS as readonly string[]).includes("/mode")).toBe(true);
	});
	test("C22: nothing in the approval path or the permission package reads flow mode", () => {
		const root = join(import.meta.dir, "..");
		const approvals = readFileSync(join(root, "daemon/channel-approvals.ts"), "utf8");
		expect(approvals).not.toMatch(/flowMode|flow-bot|FlowController/);
		const bridge = readFileSync(join(root, "daemon/telegram-bridge.ts"), "utf8");
		const approvalMethods = bridge.slice(
			bridge.indexOf("private answerApproval("),
			bridge.indexOf("private watchAdapterApprovals("),
		);
		expect(approvalMethods).not.toMatch(/flowController|flowStore|ctl\./);
	});
	test("C2: the shared isOperator is unchanged and flow does not use it", () => {
		const bridge = readFileSync(join(import.meta.dir, "telegram-bridge.ts"), "utf8");
		const flowCode = bridge.slice(
			bridge.indexOf("private async handleFlowCallback"),
			bridge.indexOf("private async clearKeyboard"),
		);
		expect(flowCode).not.toContain("this.isOperator(");
		expect(bridge).toContain(
			"if (!ops || ops.length === 0) return true; // single-operator private chat, as before",
		);
	});
});

describe("the real controller through the bridge (T6, C20, voice never raises)", () => {
	const dm = { chatType: "private", fromId: JAMES };
	const cards = () => bodies.filter((x) => x.body.reply_markup);

	test("T6: hostile judge output changes nothing, mints no card, and none of its text is shown", async () => {
		for (const raw of [
			'{"to":"infinite"}',
			'{"to":"guarded"}',
			'{"to":"quiet","origin":"user"}',
			'{"to":"quiet","extra":1}',
			'{"to":"think","reason":"SPOKEN-JUDGE-TEXT ' + "x".repeat(200) + '"}',
			"not json SPOKEN-JUDGE-TEXT",
		]) {
			bodies.length = 0;
			const t = make({}, CANARY, raw);
			await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
			await settle();
			expect(t.real.mode).toBe("act");
			expect(cards()).toEqual([]);
			expect(JSON.stringify(bodies)).not.toContain("SPOKEN-JUDGE-TEXT");
			expect(t.applied()).toEqual([]);
		}
	});
	test("a judge lowering becomes a fixed-text card; Yes applies user-voice-confirmed once", async () => {
		const t = make({}, CANARY, '{"to":"quiet","reason":"too chatty"}');
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(cards().length).toBe(1);
		const card = cards()[0] as (typeof bodies)[number];
		expect(card.body.text).toBe("Want me to go quiet?");
		expect(JSON.stringify(card.body)).not.toContain("too chatty");
		const data = card.body.reply_markup.inline_keyboard[0][0].callback_data;
		const q = { id: "q", from: { id: JAMES }, data, message: { message_id: nextId - 1, chat: DM } };
		await t.b.handleCallbackQuery(q);
		await t.b.handleCallbackQuery(q);
		expect(t.real.mode).toBe("quiet");
		expect(t.applied()).toEqual([{ to: "quiet", origin: "user-voice-confirmed" }]);
	});
	test("C20: the judge prompt holds the operator's words only, not our reply or the Heard echo", async () => {
		const t = make({
			spokenModel: async () => "ASSISTANT-SPOKEN-LINE all done.",
			sendVoiceNote: recorder([]),
		});
		await t.b.maybeSpeak("ASSISTANT-REPLY-TEXT is long enough to say aloud.");
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.signals.length).toBe(1);
		expect(t.signals[0]).toContain(CANARY);
		expect(t.signals[0]).not.toMatch(/ASSISTANT|Heard:/);
	});
	test("explicit 'go quiet' by voice is consumed: Quiet, a fixed line, no agent turn, no judge call", async () => {
		const t = make({}, "go quiet");
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.real.mode).toBe("quiet");
		expect(t.dispatched).toEqual([]);
		expect(t.signals).toEqual([]);
		expect(
			bodies.some((x) => x.body.text === "Going quiet. Undo: /mode <name> or the cycle key."),
		).toBe(true);
	});
	test("voice never raises: 'act mode' in Think points at /mode; 'go ahead and do it' gets the fixed refusal", async () => {
		const loose = make({}, "go ahead and do it");
		loose.real.userSwitch("think", "user-key");
		await loose.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(loose.real.mode).toBe("think");
		expect(bodies.some((x) => x.body.text === "Not switching, that is yours to set")).toBe(true);
		bodies.length = 0;
		const t = make({}, "act mode");
		t.real.userSwitch("think", "user-key");
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.real.mode).toBe("think");
		expect(t.dispatched).toEqual([]);
		expect(bodies.some((x) => x.body.text === "Use /mode to switch.")).toBe(true);
		// the controller holds a pending raise, but the bridge has no path that confirms one
		expect(readFileSync(join(import.meta.dir, "telegram-bridge.ts"), "utf8")).not.toContain(
			"confirmOnScreen",
		);
	});
	test("/mode shows a menu and a restore card; both apply as user-button", async () => {
		const t = make();
		t.real.userSwitch("quiet", "user-key");
		await t.b.handleTelegramMessage("/mode", JAMES, dm);
		expect(cards().length).toBe(2);
		const restore = cards()[1] as (typeof bodies)[number];
		const data = restore.body.reply_markup.inline_keyboard[0][0].callback_data;
		await t.b.handleCallbackQuery({
			id: "q",
			from: { id: JAMES },
			data,
			message: { message_id: nextId - 1, chat: DM },
		});
		expect(t.real.mode).toBe("act");
		expect(t.applied().at(-1)).toEqual({ to: "act", origin: "user-button" });
	});
	test("/mode quiet is a typed slash switch", async () => {
		const t = make();
		await t.b.handleTelegramMessage("/mode quiet", JAMES, dm);
		expect(t.applied()).toEqual([{ to: "quiet", origin: "user-slash" }]);
	});
	test("C23: a session re-create resets to Act and kills every card", async () => {
		const t = make();
		await t.b.handleTelegramMessage("/mode", JAMES, dm);
		const data = cards()[0]?.body.reply_markup.inline_keyboard[0][0].callback_data;
		const id = nextId - 1;
		t.b.freshSession();
		t.real.userSwitch("think", "user-key");
		await t.b.handleCallbackQuery({
			id: "q",
			from: { id: JAMES },
			data,
			message: { message_id: id, chat: DM },
		});
		expect(t.real.mode).toBe("think");
		t.b.freshSession();
		expect(t.real.mode).toBe("act");
	});
});

describe("review fixes on #4383", () => {
	const GROUP_MSG = { chatType: "supergroup", fromId: JAMES };
	const R10 =
		"Speech-to-text runs locally on the operator's machine (ffmpeg plus whisper-cli, no cloud STT). Audio from the Telegram path reaches the machine through Telegram's servers: a voice note the operator sends is stored and relayed by Telegram, and our spoken reply travels back the same way. Bot chats are not end-to-end encrypted. That transit is the channel the operator chose, it is not our transcription, and it applies only to the operator's own private chat. Listen-mode notes, when built, are never captured from the Telegram path. No audio or transcript is sent to any rented model API.";

	test("the Heard echo goes to the chat it came from, never to a leftover group turn", async () => {
		const t = make({}, "PRIVATE-DM-WORDS read my notes");
		t.b.originChatId = String(GROUP); // a group turn just ran and left the origin behind
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		const echoes = bodies.filter((x) => String(x.body.text).startsWith("Heard:"));
		expect(echoes.map((e) => String(e.body.chat_id))).toEqual([String(JAMES)]);
		expect(bodies.filter((x) => String(x.body.chat_id) === String(GROUP))).toEqual([]);
	});
	test("the voice status line for a failed transcript also goes to the chat it came from", async () => {
		const t = make({}, "[voice message received - transcription failed, please send as text]");
		t.b.originChatId = String(GROUP);
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(bodies.every((x) => String(x.body.chat_id) === String(JAMES))).toBe(true);
	});
	test("R10 transit text: exact string in the constant, in /help, and in the docs page", async () => {
		expect(R10_TRANSIT_NOTICE).toBe(R10);
		const t = make();
		await t.b.handleTelegramMessage("/help", JAMES, { chatType: "private", fromId: JAMES });
		expect(bodies.some((x) => String(x.body.text).includes(R10))).toBe(true);
		const doc = readFileSync(join(import.meta.dir, "../../docs/telegram-bridge-voice.md"), "utf8");
		expect(doc).toContain(R10);
	});
	test("H1: the spoken-reply arm follows the flow gate: forwarded, group and non-operator notes do not arm it", async () => {
		const said: string[] = [];
		for (const [msg, over] of [
			[voice(JAMES, DM, { forward_origin: { type: "user" } }), {}],
			[voice(JAMES, { id: GROUP, type: "supergroup" }), {}],
			[voice(JAMES, DM), { operatorUserIds: [] }],
		] as const) {
			const t = make({ ...over, sendVoiceNote: recorder(said) });
			await t.b.handleVoiceMessage(msg, "f");
			await t.b.maybeSpeak("Done. Details are on screen.");
		}
		expect(said).toEqual([]);
	});
	test("H2: a mode command clears the spoken-reply arm, so the next reply stays text", async () => {
		const said: string[] = [];
		const t = make({ sendVoiceNote: recorder(said) }, "go quiet");
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(t.real.mode).toBe("quiet");
		await t.b.maybeSpeak("Done. Details are on screen.");
		expect(said).toEqual([]);
	});
	test("H3: the canary stays out of every log through a judge proposal card and its Yes tap", async () => {
		const t = make({}, CANARY, '{"to":"quiet","reason":"too chatty"}');
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		const card = bodies.find((x) => x.body.reply_markup) as (typeof bodies)[number];
		const data = card.body.reply_markup.inline_keyboard[0][0].callback_data;
		await t.b.handleCallbackQuery({
			id: "q",
			from: { id: JAMES },
			data,
			message: { message_id: nextId - 1, chat: DM },
		});
		expect(t.real.mode).toBe("quiet");
		expect(logs.join("\n")).not.toContain("CANARY");
		expect(logs.join("\n")).not.toContain(data.slice(3));
		expect(
			bodies.filter(
				(x) =>
					JSON.stringify(x.body).includes("CANARY") && !String(x.body.text).startsWith("Heard:"),
			),
		).toEqual([]);
	});
	test("H5: an explicit null spoken model means the deterministic text, not the local model", async () => {
		const said: string[] = [];
		const real = globalThis.fetch;
		let modelCalls = 0;
		globalThis.fetch = (async (url: unknown, init?: unknown) => {
			if (String(url).includes("/api/generate")) modelCalls++;
			return (real as typeof fetch)(url as string, init as RequestInit);
		}) as unknown as typeof fetch;
		const t = make({ spokenModel: null, sendVoiceNote: recorder(said) });
		t.b.voiceEnabled = true;
		await t.b.maybeSpeak("Done. Details are on screen.");
		expect(modelCalls).toBe(0);
		expect(said.length).toBe(1);
	});
	test("group text through the real handler: /help stays in the group with no card, /mode says nothing", async () => {
		const t = make();
		await t.b.handleTelegramMessage("/help", GROUP, GROUP_MSG);
		const sendCount = () => bodies.filter((x) => x.url.includes("sendMessage")).length;
		const afterHelp = sendCount();
		await t.b.handleTelegramMessage("/mode", GROUP, GROUP_MSG);
		expect(sendCount()).toBe(afterHelp);
		const sends = bodies.filter((x) => x.url.includes("sendMessage"));
		expect(sends.length).toBeGreaterThan(0);
		for (const x of sends) {
			expect(String(x.body.chat_id)).toBe(String(GROUP));
			expect(x.body.reply_markup).toBeUndefined();
		}
		expect(t.applied()).toEqual([]);
	});

	test("S1: a group reply that finishes first neither speaks in place of the DM reply nor uses its arm", async () => {
		const said: string[] = [];
		const t = make({ sendVoiceNote: recorder(said) });
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f"); // arms the DM chat
		t.b.originChatId = String(GROUP); // an overlapping group turn is now the origin
		await t.b.maybeSpeak("Group answer. Details are on screen.");
		expect(said).toEqual([]);
		t.b.originChatId = String(JAMES); // the DM reply lands after
		await t.b.maybeSpeak("DM answer. Details are on screen.");
		expect(said.length).toBe(1);
		expect(said[0]).toContain("DM answer");
	});
	test("S2: a non-local runtime refuses the voice path: no transcription, no dispatch, one line", async () => {
		for (const env of [{ DEFAULT_RUNTIME: "openrouter" }, { DEFAULT_RUNTIME: "anthropic" }]) {
			bodies.length = 0;
			const t = make({ env });
			let transcribed = 0;
			t.b.transcribe = async () => {
				transcribed++;
				return CANARY;
			};
			await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
			expect(transcribed).toBe(0);
			expect(t.dispatched).toEqual([]);
			expect(bodies.map((x) => x.body.text)).toEqual([VOICE_NEEDS_LOCAL]);
		}
		expect(voicePathIsLocal({})).toBe(true);
		expect(voicePathIsLocal({ DEFAULT_RUNTIME: "ollama" })).toBe(true);
		expect(voicePathIsLocal({ DEFAULT_RUNTIME: "openrouter" })).toBe(false);
	});
});

describe("voice transcript passes the input gate before the judge model (#4530)", () => {
	test("a transcript that starts with a command never reaches the judge", async () => {
		const t = make({}, "/dj play something");
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.signals).toEqual([]);
	});
	test("an unknown slash transcript never reaches the judge either", async () => {
		const t = make({}, "/nosuchthing now");
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.signals).toEqual([]);
	});
	test("an ordinary transcript still reaches the judge", async () => {
		const t = make();
		await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
		await settle();
		expect(t.signals.length).toBe(1);
	});
	test("a slash transcript at the judge gate is refused without executing the command", async () => {
		const spawned: string[] = [];
		setDjTools({ mpv: "/usr/bin/mpv", ytdlp: "/usr/bin/yt-dlp" });
		setDjSpawn(((cmd: string) => {
			spawned.push(cmd);
			throw new Error("must not run");
		}) as never);
		try {
			const t = make({}, "/dj play something");
			await t.b.handleVoiceMessage(voice(JAMES, DM), "f");
			await settle();
			expect(spawned).toEqual([]);
			expect(t.signals).toEqual([]);
		} finally {
			setDjSpawn();
			setDjTools();
		}
	});
});
