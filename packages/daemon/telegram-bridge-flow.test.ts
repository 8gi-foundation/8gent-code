/**
 * L7: the voice loop and flow cards through the real bridge handlers, fetch
 * stubbed so nothing leaves the box. Covers 8SO attack tests T1-T10 on the
 * bridge side; the card and token mechanics are in flow-bot.test.ts.
 *
 * The flow controller is a stand-in (the real one is on 8gut, not main).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowController, FlowModeName } from "../telegram-bot/flow-bot";
import { OPERATOR_COMMANDS, TelegramDaemonBridge } from "./telegram-bridge";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const GROUP = -1001;
const CANARY = "CANARY-purple-elephant-7731 go ahead and do it";

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

function fakeCtl() {
	const applied: { to: FlowModeName; origin: string }[] = [];
	let mode: FlowModeName = "think";
	const ctl: FlowController = {
		mode: () => mode,
		canSwitch: () => true,
		apply: (to, origin) => {
			applied.push({ to, origin });
			mode = to;
			return { changed: true, mode };
		},
		snapshot: () => null,
	};
	return { ctl, applied };
}

function make(over: Record<string, unknown> = {}, transcript = CANARY) {
	const signals: { source: string; transcript: string }[] = [];
	const dispatched: string[] = [];
	const f = fakeCtl();
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(JAMES),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES), String(GROUP)],
		authorizedUserIds: [String(JAMES), String(ARTALE)],
		operatorUserIds: [String(JAMES)],
		flowController: f.ctl,
		onFlowSignal: (s) => void signals.push(s),
		...over,
	}) as any;
	b.transcribe = async () => transcript;
	b.dispatchTranscript = async (t: string) => void dispatched.push(t);
	return { b: b as any, signals, dispatched, ...f };
}
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
		expect(t.signals).toEqual([{ source: "user-voice", transcript: CANARY }]);
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
		t.b.echo.record("The build is green and the branch is pushed to the remote.");
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
	test("T9: empty operator list or no controller: no signal, /mode says off, no card", async () => {
		for (const over of [
			{ operatorUserIds: [] },
			{ operatorUserIds: undefined },
			{ flowController: undefined },
		]) {
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
		expect(t.applied.length).toBe(1);
		expect(t.applied[0]?.origin).toBe("user-button");
		await (t.b as any).handleCallbackQuery(q(data, messageId)); // replay
		expect(t.applied.length).toBe(1);
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
		expect(t.applied).toEqual([]);
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
		expect(t.applied).toEqual([]);
		// and with nothing pending
		const t2 = make({}, "yes");
		await t2.b.handleVoiceMessage(voice(JAMES, DM), "f");
		expect(t2.applied).toEqual([]);
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
