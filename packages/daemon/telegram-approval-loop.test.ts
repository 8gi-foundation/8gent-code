/**
 * #3621: the Telegram approval loop, end to end on one box.
 *
 * Real gateway on a loopback port, the real TelegramDaemonBridge connected to
 * it (registered as the approval bridge with the in-process secret), the real
 * permission gate (PermissionManager.requestPermission, headless) and the real
 * coordinator. The pool is a stand-in whose turn is one gated shell command,
 * bound exactly as AgentPool.chat binds a bridge turn. Telegram itself is a
 * stubbed fetch that refuses malformed text the way Telegram does.
 *
 * The "8SO" block ports Karen's exploit probes (E1-E4) from the review of
 * d6e00efc as regressions: each asserts the exploit no longer works.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, channelDenialMessage } from "../permissions/index";
import { DaemonClient } from "../telegram-bot/daemon-client";
import type { AgentPool } from "./agent-pool";
import {
	type ApprovalTurn,
	allowable,
	bridgeSecret,
	withChannelApprovals,
} from "./channel-approvals";
import { startGateway } from "./gateway";
import { TelegramDaemonBridge, visibleText } from "./telegram-bridge";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const GROUP = -1001;
const DEL = ["r", "m"].join("") + " -rf";
const CWD = "/work/repo";

/** One turn = one dangerous shell command through the real gate. */
class GatedPool {
	live = new Map<string, string>();
	outcomes: Array<{ command: string; allowed: boolean; note: string | null }> = [];
	size = 0;
	pm = new PermissionManager("/nonexistent/8gent-permissions.json");
	createSession(id: string, channel: string) {
		this.live.set(id, channel);
	}
	hasSession(id: string) {
		return this.live.has(id);
	}
	destroySession(id: string) {
		this.live.delete(id);
	}
	getActiveSessions() {
		return [];
	}
	getStatus() {
		return {};
	}
	async chat(sessionId: string, command: string, turn?: ApprovalTurn): Promise<string> {
		// The same two calls runCommand makes: the gate, then the refusal text.
		const run = async () => {
			const ok = await this.pm.requestPermission(
				"Execute Shell Command",
				"This command may cause data loss.",
				command,
			);
			return { allowed: ok, note: ok ? null : channelDenialMessage(command) };
		};
		const { allowed, note } = await (turn
			? withChannelApprovals(sessionId, turn, CWD, run)
			: run());
		this.outcomes.push({ command, allowed, note });
		return allowed ? "ran" : "declined";
	}
}

interface TgButton {
	text: string;
	callback_data: string;
}
interface TgCall {
	method: string;
	// biome-ignore lint/suspicious/noExplicitAny: recorded Telegram API bodies.
	body: Record<string, any>;
	accepted: boolean;
}

/**
 * Refuse text the way Telegram does: legacy Markdown with an unclosed `_`, `*`
 * or backtick, and HTML with a bare `<` or `&` that is not a supported tag or entity.
 */
function telegramRejects(body: Record<string, unknown>): boolean {
	const text = String(body.text ?? "");
	if (body.parse_mode === "Markdown") {
		return ["_", "*", "`"].some((m) => text.split(m).length % 2 === 0);
	}
	if (body.parse_mode === "HTML") {
		const stripped = text.replace(/<\/?(b|i|code|pre)>/g, "");
		return /</.test(stripped) || /&(?!(amp|lt|gt|quot);)/.test(stripped);
	}
	return false;
}
/** Test knobs: refuse every HTML card, or every card. */
const stub = { rejectHtml: false, rejectCards: false };

const pool = new GatedPool();
let server: ReturnType<typeof Bun.serve>;
let bridge: TelegramDaemonBridge;
let tg: TgCall[] = [];
let nextMessageId = 100;
let dataDir: string;
const realFetch = globalThis.fetch;
const saved = {
	host: process.env.DAEMON_HOSTNAME,
	headless: process.env.EIGHT_HEADLESS,
	ttl: process.env.EIGHT_APPROVAL_TTL_MS,
	allowTtl: process.env.EIGHT_APPROVAL_ALLOW_TTL_MS,
	data: process.env.EIGHT_DATA_DIR,
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}
const settle = () => new Promise((r) => setTimeout(r, 80));

// biome-ignore lint/suspicious/noExplicitAny: private bridge surface under test.
const priv = () => bridge as any;
const cards = () =>
	tg.filter((c) => c.method === "sendMessage" && c.body.reply_markup && c.accepted);
const texts = () => tg.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
const edits = () =>
	tg.filter((c) => c.method === "editMessageText" && c.accepted).map((c) => String(c.body.text));
const labels = (card: TgCall): string[] =>
	card.body.reply_markup.inline_keyboard.flat().map((b: TgButton) => b.text);
const button = (card: TgCall, label: string): string =>
	card.body.reply_markup.inline_keyboard.flat().find((b: TgButton) => b.text === label)
		.callback_data;

const OPERATOR_DM: ApprovalTurn = { chatId: String(JAMES), operator: true };

/** Exactly what the bridge sends for a turn it started. */
function prompt(command: string, turn: ApprovalTurn = OPERATOR_DM): void {
	priv().ws.send(JSON.stringify({ type: "prompt", text: command, turn }));
}
/** A tap in a chat; by default James in his DM with the bot, where cards land. */
function press(
	fromId: number,
	data: string,
	chat: { id: number; type: string } = { id: fromId, type: "private" },
): Promise<void> {
	return priv().handleCallbackQuery({
		id: `q${Math.random()}`,
		from: { id: fromId, first_name: "x" },
		message: { message_id: 1, chat },
		data,
	});
}
function rogueSocket(): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
	const frames: Array<Record<string, unknown>> = [];
	ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
	return new Promise((r) => {
		ws.onopen = () => r({ ws, frames });
	});
}
function auditLines(): Array<Record<string, unknown>> {
	try {
		return readFileSync(join(dataDir, "approvals-audit.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

beforeAll(async () => {
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	process.env.EIGHT_HEADLESS = "1";
	dataDir = mkdtempSync(join(tmpdir(), "approval-audit-"));
	process.env.EIGHT_DATA_DIR = dataDir;
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		const method = String(url).split("/").pop() as string;
		const body = init?.body ? JSON.parse(init.body) : {};
		const refused =
			telegramRejects(body) ||
			(body.reply_markup && (stub.rejectCards || (stub.rejectHtml && body.parse_mode === "HTML")));
		tg.push({ method, body, accepted: !refused });
		if (refused) {
			return new Response(
				JSON.stringify({
					ok: false,
					error_code: 400,
					description: "Bad Request: can't parse entities",
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	// A gateway started and stopped earlier in the process (as another test
	// file does on Linux CI) must not make this one deliver events twice.
	startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool }).stop(true);
	server = startGateway({ port: 0, authToken: null, pool: pool as unknown as AgentPool });
	bridge = new TelegramDaemonBridge({
		telegramToken: "test-token",
		chatId: String(GROUP),
		daemonUrl: `ws://127.0.0.1:${server.port}`,
		authorizedChatIds: [String(GROUP)],
		authorizedUserIds: [String(JAMES), String(ARTALE)],
		operatorUserIds: [String(JAMES)],
	});
	priv().multiStepEnabled = false;
	await priv().connectDaemon();
});

afterAll(() => {
	priv().polling = false;
	priv().ws.onclose = null;
	priv().ws.close();
	server.stop(true);
	globalThis.fetch = realFetch;
	rmSync(dataDir, { recursive: true, force: true });
	for (const [k, v] of [
		["DAEMON_HOSTNAME", saved.host],
		["EIGHT_HEADLESS", saved.headless],
		["EIGHT_APPROVAL_TTL_MS", saved.ttl],
		["EIGHT_APPROVAL_ALLOW_TTL_MS", saved.allowTtl],
		["EIGHT_DATA_DIR", saved.data],
	] as const) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
});

beforeEach(() => {
	tg = [];
	pool.outcomes = [];
	stub.rejectHtml = false;
	stub.rejectCards = false;
	pool.pm = new PermissionManager("/nonexistent/8gent-permissions.json");
	Reflect.deleteProperty(process.env, "EIGHT_APPROVAL_TTL_MS");
	Reflect.deleteProperty(process.env, "EIGHT_APPROVAL_ALLOW_TTL_MS");
});
afterEach(() => {
	priv().pendingApprovals.clear();
	priv().awaitingAck.clear();
});

describe("Telegram approval loop (#3621)", () => {
	it("a gated command raises exactly one card, and Approve lets the turn continue", async () => {
		prompt(`${DEL} ./build-a`);
		await until(() => cards().length === 1);
		await settle();
		expect(pool.outcomes).toEqual([]); // the turn is waiting, not denied

		await press(JAMES, button(cards()[0], "Approve"));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toMatchObject({ command: `${DEL} ./build-a`, allowed: true });
		await until(() => edits().includes(`Approved: ${DEL} ./build-a`));
		expect(cards().length).toBe(1); // the press drew no second card
	});

	it("a second press, and a replayed answer straight to the daemon, are refused", async () => {
		prompt(`${DEL} ./build-b`);
		await until(() => cards().length === 1);
		const approve = button(cards()[0], "Approve");
		await press(JAMES, approve);
		await until(() => pool.outcomes.length === 1);

		await press(JAMES, approve);
		const requestId = approve.split(":")[1];
		priv().ws.send(JSON.stringify({ type: "approval:response", requestId, approved: true }));
		await until(() => texts().filter((t) => t.includes("no longer live")).length === 2);
		expect(pool.outcomes.length).toBe(1);
		expect(cards().length).toBe(1);
	});

	it("a stale card expires after its TTL, is edited, and the model hears 'expired'", async () => {
		process.env.EIGHT_APPROVAL_TTL_MS = "150";
		prompt(`${DEL} ./build-c`);
		await until(() => cards().length === 1);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toMatchObject({ allowed: false });
		expect(pool.outcomes[0].note).toContain("Approval expired");
		await until(() => edits().includes(`Expired. Nothing ran: ${DEL} ./build-c`));

		await press(JAMES, button(cards()[0], "Approve"));
		await settle();
		expect(texts().some((t) => t.includes("no longer live"))).toBe(true);
		expect(pool.outcomes.length).toBe(1);
	});

	it("a new prompt replaces the live one: old card edited, model hears 'replaced'", async () => {
		prompt(`${DEL} ./build-d1`);
		await until(() => cards().length === 1);
		prompt(`${DEL} ./build-d2`);
		await until(() => cards().length === 2);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toMatchObject({ command: `${DEL} ./build-d1`, allowed: false });
		expect(pool.outcomes[0].note).toContain("Approval replaced");
		await until(() =>
			edits().includes(`Replaced by a newer request. Nothing ran: ${DEL} ./build-d1`),
		);

		await press(JAMES, button(cards()[0], "Approve"));
		await settle();
		expect(pool.outcomes.length).toBe(1);
		await press(JAMES, button(cards()[1], "Approve"));
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1]).toMatchObject({ command: `${DEL} ./build-d2`, allowed: true });
	});

	it("Deny posts a fixed line, the card keeps the command, the model hears no excuse", async () => {
		prompt(`${DEL} ./build-j`);
		await until(() => cards().length === 1);
		await press(JAMES, button(cards()[0], "Deny"));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toMatchObject({ allowed: false, note: null });
		await until(() => texts().includes("Denied. Nothing ran."));
		expect(edits()).toContain(`Denied. Nothing ran: ${DEL} ./build-j`);
	});

	it("Artale's tap is refused; only the operator resolves the card", async () => {
		prompt(`${DEL} ./build-f`);
		await until(() => cards().length === 1);
		const approve = button(cards()[0], "Approve");

		await press(ARTALE, approve, { id: GROUP, type: "supergroup" });
		await press(ARTALE, approve);
		await settle();
		expect(pool.outcomes).toEqual([]);
		const alert = tg.find((c) => c.method === "answerCallbackQuery" && c.body.show_alert);
		expect(alert?.body.text).toBe("Only the operator can use these buttons.");

		await press(JAMES, approve);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(true);
	});

	it("a group turn puts a short note in the group and the full card in James's DM", async () => {
		prompt(`${DEL} ./build-m`, { chatId: String(GROUP), operator: true });
		await until(() => cards().length === 1);
		expect(cards()[0].body.chat_id).toBe(String(JAMES));
		expect(
			tg.some(
				(c) =>
					c.method === "sendMessage" &&
					c.body.chat_id === String(GROUP) &&
					c.body.text === "Approval needed, check your DM.",
			),
		).toBe(true);
		expect(tg.some((c) => c.body.chat_id === String(GROUP) && c.body.reply_markup)).toBe(false);
		await press(JAMES, button(cards()[0], "Approve"));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(true);
	});

	it("the card changes only after the daemon confirms the answer counted", async () => {
		// A card the bridge still shows but the daemon no longer holds.
		priv().pendingApprovals.set("feedf00d", {
			tool: "run_command",
			input: { command: `${DEL} ./ghost` },
			chatId: String(JAMES),
			sessionId: priv().sessionId,
			expiresAt: Date.now() + 60_000,
			messageId: 7,
			via: "ws",
		});
		await press(JAMES, "approve:feedf00d");
		await until(() => edits().includes(`No longer live. Nothing ran: ${DEL} ./ghost`));
		expect(edits().some((t) => t.startsWith("Approved"))).toBe(false);
		expect(texts().some((t) => t.includes("no longer live"))).toBe(true);
	});

	it("default (multi-step) mode: the adapter's socket carries the card, the answer and refusals", async () => {
		const client = new DaemonClient({
			url: `ws://127.0.0.1:${server.port}`,
			channel: "telegram",
			reconnectDelayMs: 10,
			approvalSecret: bridgeSecret(),
		});
		await client.connect();
		client.turn = OPERATOR_DM;
		priv().daemonClient = client;
		priv().watchAdapterApprovals(client);
		try {
			client.sendPrompt(`${DEL} ./build-g`);
			await until(() => cards().length === 1);
			await press(JAMES, button(cards()[0], "Approve"));
			await until(() => pool.outcomes.length === 1);
			expect(pool.outcomes[0]).toMatchObject({ command: `${DEL} ./build-g`, allowed: true });
			await until(() => edits().includes(`Approved: ${DEL} ./build-g`));

			client.respondApproval("deadbeef", true);
			await until(() => texts().some((t) => t.includes("no longer live")));
		} finally {
			priv().daemonClient = null;
			client.close();
		}
	});

	it("push to main is never offered for approval", async () => {
		const allowed = await withChannelApprovals("no-surface", OPERATOR_DM, CWD, () =>
			pool.pm.requestPermission("Execute Shell Command", "x", "git push origin main --force"),
		);
		expect(allowed).toBe(false);
		expect(cards().length).toBe(0);
	});
});

describe("card rendering (8PO item 1, 8SO HIGH-2)", () => {
	it("a command full of _ * ` < > & renders whole, with Command, In and Why lines", async () => {
		const command = `${DEL} node_modules/a_tmp && echo \`id\` <in >out & echo a_b`;
		prompt(command);
		await until(() => cards().length === 1);
		const text = String(cards()[0].body.text);
		expect(cards()[0].body.parse_mode).toBe("HTML");
		expect(text).toContain(
			`Command: <code>${DEL} node_modules/a_tmp &amp;&amp; echo \`id\` &lt;in &gt;out &amp; echo a_b</code>`,
		);
		expect(text).toContain(`\nIn: <code>${CWD}</code>`);
		expect(text).toContain("\nWhy: This command may cause data loss.");
		await press(JAMES, button(cards()[0], "Approve"));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toMatchObject({ command, allowed: true });
		await until(() => edits().includes(`Approved: ${command}`));
	});

	it("a refused HTML card is retried once as plain text", async () => {
		stub.rejectHtml = true;
		prompt(`${DEL} ./build-h`);
		await until(() => cards().length === 1);
		expect(cards()[0].body.parse_mode).toBeUndefined();
		expect(String(cards()[0].body.text)).toContain(`Command: ${DEL} ./build-h`);
		await press(JAMES, button(cards()[0], "Approve"));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(true);
	});

	it("a card Telegram will not show denies at once, says so, and tells the model why", async () => {
		stub.rejectCards = true;
		const started = Date.now();
		prompt(`${DEL} ./build-i`);
		await until(() => pool.outcomes.length === 1);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(pool.outcomes[0]).toMatchObject({ allowed: false });
		expect(pool.outcomes[0].note).toContain("could not be shown");
		expect(texts().some((t) => t.includes("Could not show an approval card"))).toBe(true);
	});

	it("invisible characters are shown as escapes", () => {
		expect(visibleText("a‮b​c\nd e")).toBe("a\\u{202e}b\\u{200b}c\\u{a}d\\u{a0}e");
	});
});

describe("allow in this chat (8SO HIGH-3)", () => {
	it("skips the next identical prompt in the same chat, not a different command", async () => {
		prompt(`${DEL} ./build-e`);
		await until(() => cards().length === 1);
		await press(JAMES, button(cards()[0], "Allow this command in this chat"));
		await until(() => pool.outcomes.length === 1);
		await until(() => edits().includes(`Allowed this command in this chat: ${DEL} ./build-e`));

		prompt(`${DEL} ./build-e`);
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1]).toMatchObject({ allowed: true });
		expect(cards().length).toBe(1);

		prompt(`${DEL} ./build-other`);
		await until(() => cards().length === 2);
		await press(JAMES, button(cards()[1], "Deny"));
		await until(() => pool.outcomes.length === 3);
		expect(pool.outcomes[2]).toMatchObject({ allowed: false });
	});

	it("does not carry to another chat, or to a turn the operator did not start", async () => {
		prompt(`${DEL} ./build-n`);
		await until(() => cards().length === 1);
		await press(JAMES, button(cards()[0], "Allow this command in this chat"));
		await until(() => pool.outcomes.length === 1);

		prompt(`${DEL} ./build-n`, { chatId: String(GROUP), operator: true });
		await until(() => cards().length === 2);
		await press(JAMES, button(cards()[1], "Deny"));
		await until(() => pool.outcomes.length === 2);

		prompt(`${DEL} ./build-n`, { chatId: String(JAMES), operator: false });
		await until(() => cards().length === 3);
		await press(JAMES, button(cards()[2], "Deny"));
		await until(() => pool.outcomes.length === 3);
		expect(pool.outcomes.map((o) => o.allowed)).toEqual([true, false, false]);
	});

	it("expires after its TTL", async () => {
		process.env.EIGHT_APPROVAL_ALLOW_TTL_MS = "100";
		prompt(`${DEL} ./build-o`);
		await until(() => cards().length === 1);
		await press(JAMES, button(cards()[0], "Allow this command in this chat"));
		await until(() => pool.outcomes.length === 1);
		await new Promise((r) => setTimeout(r, 150));
		prompt(`${DEL} ./build-o`);
		await until(() => cards().length === 2);
		await press(JAMES, button(cards()[1], "Deny"));
		await until(() => pool.outcomes.length === 2);
	});

	it("is never offered for scripts, interpreters or expanding commands, and a forged allow is one approve", async () => {
		for (const c of [
			"bash ./x.sh",
			"python3 tool.py",
			`${DEL} $HOME/x`,
			`${DEL} ./*.log`,
			`${DEL} ~/x`,
			`${DEL} \`pwd\`/x`,
		]) {
			expect(allowable(c)).toBe(false);
		}
		expect(allowable(`${DEL} ./build`)).toBe(true);

		const command = `${DEL} ./*.tmp`;
		prompt(command);
		await until(() => cards().length === 1);
		expect(labels(cards()[0])).toEqual(["Approve", "Deny"]);
		const id = button(cards()[0], "Approve").split(":")[1];
		await press(JAMES, `allowchat:${id}`);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(true);

		prompt(command);
		await until(() => cards().length === 2);
		await press(JAMES, button(cards()[1], "Deny"));
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1].allowed).toBe(false);
	});
});

describe("audit log (8SO MEDIUM-5)", () => {
	it("records every decision and auto-pass with who, where and what, in a 0600 file", async () => {
		prompt(`${DEL} ./build-p`);
		await until(() => cards().length === 1);
		await press(JAMES, button(cards()[0], "Allow this command in this chat"));
		await until(() => pool.outcomes.length === 1);
		prompt(`${DEL} ./build-p`);
		await until(() => pool.outcomes.length === 2);

		const lines = auditLines().filter((l) => l.command === `${DEL} ./build-p`);
		expect(lines.map((l) => l.decision)).toEqual(["allow_chat", "auto-allow"]);
		expect(lines[0]).toMatchObject({ approver: String(JAMES), chat: String(JAMES) });
		expect(typeof lines[0].requestId).toBe("string");
		expect(typeof lines[0].ts).toBe("string");
		expect(statSync(join(dataDir, "approvals-audit.jsonl")).mode & 0o777).toBe(0o600);
	});
});

describe("8SO exploit probes, as regressions (#3624 review)", () => {
	it("E1: a second loopback client on the bridge's session cannot see, answer, or raise approvals", async () => {
		const sid = priv().sessionId as string;
		const rogue = await rogueSocket();
		rogue.ws.send(JSON.stringify({ type: "session:resume", sessionId: sid, channel: "telegram" }));
		await settle();

		prompt(`${DEL} ./e1`);
		await until(() => cards().length === 1);
		await settle();
		expect(rogue.frames.some((f) => String(f.event ?? "").startsWith("approval:"))).toBe(false);

		// Even holding the id (read off the card), its answer is refused.
		const id = button(cards()[0], "Approve").split(":")[1];
		rogue.ws.send(
			JSON.stringify({ type: "approval:response", requestId: id, approved: true, scope: "chat" }),
		);
		await until(() => rogue.frames.some((f) => f.type === "approval:resolved"));
		expect(rogue.frames.find((f) => f.type === "approval:resolved")).toMatchObject({
			ok: false,
			reason: "not-bridge",
		});
		expect(pool.outcomes).toEqual([]);

		// A forged registration fails, and a turn it claims raises no card: flat deny.
		rogue.ws.send(JSON.stringify({ type: "approvals:register", secret: "guess" }));
		rogue.ws.send(JSON.stringify({ type: "prompt", text: `${DEL} ./e1-rogue`, turn: OPERATOR_DM }));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toMatchObject({ command: `${DEL} ./e1-rogue`, allowed: false });
		expect(rogue.frames.find((f) => f.type === "approvals:registered")).toMatchObject({
			ok: false,
		});

		// L8: the rogue leaving does not cancel the bridge's live prompt.
		rogue.ws.close();
		await settle();
		await press(JAMES, button(cards()[0], "Deny"));
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1]).toMatchObject({ command: `${DEL} ./e1`, allowed: false, note: null });
	});

	it("E2: the card shows the whole command; one too long to show is never offered", async () => {
		const cmd = `${DEL} ./build ./${"a".repeat(190)} ~/important`;
		prompt(cmd);
		await until(() => cards().length === 1);
		expect(String(cards()[0].body.text)).toContain("~/important</code>");
		await press(JAMES, button(cards()[0], "Deny"));
		await until(() => pool.outcomes.length === 1);

		const huge = `${DEL} ./${"b".repeat(3100)} ~/important`;
		prompt(huge);
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1].allowed).toBe(false);
		expect(pool.outcomes[1].note).toContain("too long to show");
		expect(cards().length).toBe(1);
	});

	it("E3: bidi and zero-width characters reach the card as visible escapes", async () => {
		const cmd = `${DEL} ./safe‮etadpu​`;
		prompt(cmd);
		await until(() => cards().length === 1);
		const text = String(cards()[0].body.text);
		expect(text.includes("‮")).toBe(false);
		expect(text.includes("​")).toBe(false);
		expect(text).toContain("safe\\u{202e}etadpu\\u{200b}");
		await press(JAMES, button(cards()[0], "Deny"));
		await until(() => pool.outcomes.length === 1);
	});

	it("E4: an always-blocked catastrophic command is denied flat, never offered", async () => {
		prompt(`${DEL} /*`);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(false);
		expect(cards().length).toBe(0);
		const pm = new PermissionManager("/nonexistent/8gent-permissions.json");
		expect(withChannelApprovals("s", OPERATOR_DM, CWD, () => pm.checkPermission(`${DEL} /*`))).toBe(
			"denied",
		);
	});
});
