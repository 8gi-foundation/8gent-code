/**
 * #3621: the Telegram approval loop, end to end on one box.
 *
 * Real gateway on a loopback port, the real TelegramDaemonBridge connected to
 * it, the real permission gate (PermissionManager.requestPermission, headless)
 * and the real coordinator. The pool is a stand-in whose turn is one gated
 * shell command, bound the way AgentPool.chat binds a telegram turn. Telegram
 * itself is a stubbed fetch, so nothing leaves the box.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { PermissionManager } from "../permissions/index";
import { DaemonClient } from "../telegram-bot/daemon-client";
import type { AgentPool } from "./agent-pool";
import { withChannelApprovals } from "./channel-approvals";
import { startGateway } from "./gateway";
import { TelegramDaemonBridge } from "./telegram-bridge";

const JAMES = 5486040131;
const ARTALE = 8270920648;
const GROUP = -1001;

/** One turn = one dangerous shell command through the real gate. */
class GatedPool {
	live = new Map<string, string>();
	outcomes: Array<{ command: string; allowed: boolean }> = [];
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
	async chat(sessionId: string, command: string): Promise<string> {
		const allowed = await withChannelApprovals(sessionId, () =>
			this.pm.requestPermission(
				"Execute Shell Command",
				"This command may cause data loss.",
				command,
			),
		);
		this.outcomes.push({ command, allowed });
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
}

const pool = new GatedPool();
let server: ReturnType<typeof Bun.serve>;
let bridge: TelegramDaemonBridge;
let tg: TgCall[] = [];
let nextMessageId = 100;
const realFetch = globalThis.fetch;
const saved = {
	host: process.env.DAEMON_HOSTNAME,
	headless: process.env.EIGHT_HEADLESS,
	ttl: process.env.EIGHT_APPROVAL_TTL_MS,
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
const cards = () => tg.filter((c) => c.method === "sendMessage" && c.body.reply_markup);
const texts = () => tg.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
const button = (card: TgCall, label: string): string =>
	card.body.reply_markup.inline_keyboard.flat().find((b: TgButton) => b.text === label)
		.callback_data;

function prompt(command: string): void {
	priv().ws.send(JSON.stringify({ type: "prompt", text: command }));
}
function press(fromId: number, data: string, messageId?: number): Promise<void> {
	return priv().handleCallbackQuery({
		id: `q${Math.random()}`,
		from: { id: fromId, first_name: "x" },
		message: { message_id: messageId ?? 1, chat: { id: GROUP, type: "supergroup" } },
		data,
	});
}

beforeAll(async () => {
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
	process.env.EIGHT_HEADLESS = "1";
	globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
		const method = String(url).split("/").pop() as string;
		tg.push({ method, body: init?.body ? JSON.parse(init.body) : {} });
		return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
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
	for (const [k, v] of [
		["DAEMON_HOSTNAME", saved.host],
		["EIGHT_HEADLESS", saved.headless],
		["EIGHT_APPROVAL_TTL_MS", saved.ttl],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

beforeEach(() => {
	tg = [];
	pool.outcomes = [];
	pool.pm = new PermissionManager("/nonexistent/8gent-permissions.json");
	delete process.env.EIGHT_APPROVAL_TTL_MS;
});
afterEach(() => {
	priv().pendingApprovals.clear();
});

describe("Telegram approval loop (#3621)", () => {
	it("a gated command raises exactly one card, and Approve lets the turn continue", async () => {
		prompt("rm -rf ./build-a");
		await until(() => cards().length === 1);
		await settle();
		expect(pool.outcomes).toEqual([]); // the turn is waiting, not denied

		await press(JAMES, button(cards()[0], "Approve"));
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toEqual({ command: "rm -rf ./build-a", allowed: true });
		await settle();
		expect(cards().length).toBe(1); // the press drew no second card
	});

	it("a second press, and a replayed answer straight to the daemon, are refused", async () => {
		prompt("rm -rf ./build-b");
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

	it("a stale card expires after its TTL and fails closed", async () => {
		process.env.EIGHT_APPROVAL_TTL_MS = "150";
		prompt("rm -rf ./build-c");
		await until(() => cards().length === 1);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(false);

		await press(JAMES, button(cards()[0], "Approve"));
		await settle();
		expect(texts().some((t) => t.includes("no longer live"))).toBe(true);
		expect(pool.outcomes.length).toBe(1);
	});

	it("a new prompt in the session replaces the live one", async () => {
		prompt("rm -rf ./build-d1");
		await until(() => cards().length === 1);
		prompt("rm -rf ./build-d2");
		await until(() => cards().length === 2);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0]).toEqual({ command: "rm -rf ./build-d1", allowed: false });

		await press(JAMES, button(cards()[0], "Approve"));
		await settle();
		expect(pool.outcomes.length).toBe(1);
		await press(JAMES, button(cards()[1], "Approve"));
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1]).toEqual({ command: "rm -rf ./build-d2", allowed: true });
	});

	it("Allow in this chat skips the next identical prompt, not a different one", async () => {
		prompt("rm -rf ./build-e");
		await until(() => cards().length === 1);
		await press(JAMES, button(cards()[0], "Allow in this chat"));
		await until(() => pool.outcomes.length === 1);

		prompt("rm -rf ./build-e");
		await until(() => pool.outcomes.length === 2);
		expect(pool.outcomes[1]).toEqual({ command: "rm -rf ./build-e", allowed: true });
		expect(cards().length).toBe(1);

		prompt("rm -rf ./build-other");
		await until(() => cards().length === 2);
		await press(JAMES, button(cards()[1], "Deny"));
		await until(() => pool.outcomes.length === 3);
		expect(pool.outcomes[2]).toEqual({ command: "rm -rf ./build-other", allowed: false });
	});

	it("Artale's press is refused; only the operator resolves the card", async () => {
		prompt("rm -rf ./build-f");
		await until(() => cards().length === 1);
		const approve = button(cards()[0], "Approve");

		await press(ARTALE, approve);
		await settle();
		expect(pool.outcomes).toEqual([]);
		const alert = tg.find((c) => c.method === "answerCallbackQuery" && c.body.show_alert);
		expect(alert?.body.text).toBe("Only the operator can use these buttons.");

		await press(JAMES, approve);
		await until(() => pool.outcomes.length === 1);
		expect(pool.outcomes[0].allowed).toBe(true);
	});

	it("default (multi-step) mode: the card comes from the adapter's session and the answer goes back on it", async () => {
		const client = new DaemonClient({
			url: `ws://127.0.0.1:${server.port}`,
			channel: "telegram",
			reconnectDelayMs: 10,
		});
		await client.connect();
		priv().daemonClient = client;
		priv().watchAdapterApprovals(client);
		try {
			client.sendPrompt("rm -rf ./build-g");
			await until(() => cards().length === 1);
			await press(JAMES, button(cards()[0], "Approve"));
			await until(() => pool.outcomes.length === 1);
			expect(pool.outcomes[0]).toEqual({ command: "rm -rf ./build-g", allowed: true });
		} finally {
			priv().daemonClient = null;
			client.close();
		}
	});

	it("push to main is never offered for approval", async () => {
		const allowed = await withChannelApprovals("no-surface", () =>
			pool.pm.requestPermission("Execute Shell Command", "x", "git push origin main --force"),
		);
		expect(allowed).toBe(false);
		expect(cards().length).toBe(0);
	});
});
