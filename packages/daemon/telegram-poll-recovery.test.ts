/**
 * Telegram poll loop recovery (#3708).
 *
 * A fake Telegram API that hangs the first N getUpdates calls (so the client's
 * own abort fires) and then serves one update. The loop must back off, resume,
 * log one recovery line and deliver the update. A second case wedges the
 * handler and expects the watchdog to restart the loop.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetTelegramBridgeHealth, telegramBridgeHealth } from "./bridge-health";
import { TelegramDaemonBridge } from "./telegram-bridge";

let server: ReturnType<typeof Bun.serve>;
let getUpdatesCalls = 0;
let hangFirst = 3;
let offsets: string[] = [];
let served = false;

beforeEach(() => {
	getUpdatesCalls = 0;
	hangFirst = 3;
	offsets = [];
	served = false;
	resetTelegramBridgeHealth();
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (!url.pathname.endsWith("/getUpdates")) return Response.json({ ok: true, result: [] });
			getUpdatesCalls++;
			offsets.push(url.searchParams.get("offset") ?? "");
			if (getUpdatesCalls <= hangFirst) {
				await new Promise((r) => setTimeout(r, 5000)); // client aborts first
				return Response.json({ ok: true, result: [] });
			}
			if (!served) {
				served = true;
				return Response.json({
					ok: true,
					result: [
						{
							update_id: 7,
							message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hello" },
						},
					],
				});
			}
			await new Promise((r) => setTimeout(r, 50));
			return Response.json({ ok: true, result: [] });
		},
	});
});

afterEach(() => server.stop(true));

function makeBridge(extra: Record<string, unknown> = {}) {
	const bridge = new TelegramDaemonBridge({
		telegramToken: "123:fake",
		chatId: "42",
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: ["42"],
		telegramApiBase: `http://127.0.0.1:${server.port}/bot`,
		poll: { timeoutSec: 0, abortGraceMs: 60, backoffBaseMs: 10, backoffMaxMs: 40, ...extra },
	} as never);
	const delivered: string[] = [];
	(bridge as any).handleTelegramMessage = async (text: string) => {
		delivered.push(text);
	};
	return { bridge, delivered };
}

async function until(cond: () => boolean, ms = 4000) {
	const t = Date.now();
	while (!cond()) {
		if (Date.now() - t > ms) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe("telegram poll recovery", () => {
	it("survives N timeouts, logs one recovery line, delivers the next update", async () => {
		const logs: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		console.log = (...a: unknown[]) => void logs.push(a.join(" "));
		console.error = () => {};
		const { bridge, delivered } = makeBridge();
		try {
			bridge.startPolling();
			await until(() => delivered.length === 1);
		} finally {
			bridge.stop();
			console.log = origLog;
			console.error = origErr;
		}
		expect(delivered).toEqual(["hello"]);
		expect(getUpdatesCalls).toBeGreaterThan(3);
		expect(logs.filter((l) => l.includes("poll recovered")).length).toBe(1);
		const h = telegramBridgeHealth();
		expect(h?.lastSuccessfulPoll).not.toBeNull();
	});

	it("watchdog restarts a loop wedged on a handler that never returns", async () => {
		hangFirst = 0;
		const { bridge, delivered } = makeBridge({ watchdogMs: 150, watchdogCheckMs: 30 });
		(bridge as any).handleTelegramMessage = async (text: string) => {
			delivered.push(text);
			if (delivered.length === 1) await new Promise(() => {}); // wedge forever
		};
		const origErr = console.error;
		const origWarn = console.warn;
		const origLog = console.log;
		console.error = () => {};
		console.warn = () => {};
		console.log = () => {};
		try {
			bridge.startPolling();
			await until(() => delivered.length === 1);
			// Serve a second update after the wedge; only a restarted loop can take it.
			served = false;
			await until(() => delivered.length === 2);
		} finally {
			bridge.stop();
			console.error = origErr;
			console.warn = origWarn;
			console.log = origLog;
		}
		expect(delivered.length).toBe(2);
	});
});
