/**
 * #4834: the legacy bridge path posts a final reply to Telegram only for a turn
 * Telegram started. A TUI turn on the same session is shown in the TUI only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TelegramDaemonBridge } from "./telegram-bridge";

const JAMES = 5486040131;
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

function make() {
	const wire: Array<Record<string, unknown>> = [];
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(JAMES),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES)],
		authorizedUserIds: [String(JAMES)],
		operatorUserIds: [String(JAMES)],
		env: {},
	}) as any;
	b.multiStepEnabled = false;
	b.adapter = null;
	b.agentReady = true;
	b.sessionId = "s1";
	b.ws = { readyState: WebSocket.OPEN, send: (d: string) => wire.push(JSON.parse(d)) };
	return { b, wire };
}
const frame = (event: string, payload: Record<string, unknown>) => ({
	type: "event",
	event,
	payload: { sessionId: "s1", ...payload },
});
const sender = { chatType: "private", fromId: JAMES };
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("legacy bridge: whose reply is it", () => {
	test("a TUI turn's reply is not posted to the Telegram chat", async () => {
		const { b } = make();
		b.handleDaemonMessage(frame("user:message", { text: "from the tui", channel: "tui" }));
		b.handleDaemonMessage(frame("tool:start", { tool: "read_file" }));
		b.handleDaemonMessage(frame("agent:stream", { chunk: "reply for the tui", final: true }));
		b.handleDaemonMessage(frame("session:end", { reason: "turn-complete" }));
		await flush();
		expect(sent).toEqual([]);
	});

	test("a Telegram turn started through the real send path is answered in Telegram", async () => {
		const { b, wire } = make();
		await b.handleTelegramMessage("hello from telegram", JAMES, sender);
		expect(wire.some((f) => f.type === "prompt")).toBe(true);
		b.handleDaemonMessage(frame("agent:stream", { chunk: "answer for telegram", final: true }));
		await flush();
		expect(sent).toContain("answer for telegram");
	});

	test("the bridge is not left busy by a TUI turn finishing ahead of its own", async () => {
		const { b } = make();
		await b.handleTelegramMessage("hello", JAMES, sender);
		b.handleDaemonMessage(frame("user:message", { text: "tui", channel: "tui" }));
		// Daemon order: Telegram's turn first (queued before the echo), then the TUI's.
		b.handleDaemonMessage(frame("agent:stream", { chunk: "first, telegram", final: true }));
		b.handleDaemonMessage(frame("session:end", { reason: "turn-complete" }));
		b.handleDaemonMessage(frame("agent:stream", { chunk: "second, tui", final: true }));
		b.handleDaemonMessage(frame("session:end", { reason: "turn-complete" }));
		await flush();
		expect(sent).toContain("first, telegram");
		expect(sent).not.toContain("second, tui");
	});

	test("the legacy socket declares its session home, and a reconnect with the adapter running does not", () => {
		const { b, wire } = make();
		const open = (b2: any) => {
			// the handler the real socket installs: session:created resolves the connect
			b2.ws = { readyState: WebSocket.OPEN, send: (d: string) => wire.push(JSON.parse(d)) };
		};
		open(b);
		expect(wire.filter((f) => f.type === "home:declare")).toEqual([]);
		// Drive the real onmessage path.
		let handler: ((e: { data: string }) => void) | null = null;
		const orig = globalThis.WebSocket;
		(globalThis as any).WebSocket = class {
			static OPEN = 1;
			readyState = 1;
			send(d: string) {
				wire.push(JSON.parse(d));
			}
			set onmessage(f: (e: { data: string }) => void) {
				handler = f;
			}
			set onopen(_f: () => void) {}
			set onerror(_f: () => void) {}
			set onclose(_f: () => void) {}
			close() {}
		};
		try {
			void b.connectDaemon();
			handler!({ data: JSON.stringify({ type: "session:created", sessionId: "s9" }) });
			expect(wire.filter((f) => f.type === "home:declare").length).toBe(1);
			b.daemonClient = {}; // the adapter's own client now carries the conversation
			handler!({ data: JSON.stringify({ type: "session:resumed", sessionId: "s9" }) });
			expect(wire.filter((f) => f.type === "home:declare").length).toBe(1);
		} finally {
			(globalThis as any).WebSocket = orig;
		}
	});

	test("a reconnect in the middle of a TUI turn delivers nothing more of it, against a tagging daemon", async () => {
		const { b } = make();
		let handler: ((e: { data: string }) => void) | null = null;
		const orig = globalThis.WebSocket;
		(globalThis as any).WebSocket = class {
			static OPEN = 1;
			readyState = 1;
			send(_d: string) {}
			set onmessage(f: (e: { data: string }) => void) {
				handler = f;
			}
			set onopen(_f: () => void) {}
			set onerror(_f: () => void) {}
			set onclose(_f: () => void) {}
			close() {}
		};
		const caps = ["input-gate", "turn-origin"];
		try {
			void b.connectDaemon();
			handler!({
				data: JSON.stringify({ type: "session:created", sessionId: "s1", capabilities: caps }),
			});
			b.handleDaemonMessage(frame("tool:start", { tool: "read_file", origin: "tui" }));
			// the socket drops and resumes while the TUI's turn is still running
			handler!({
				data: JSON.stringify({ type: "session:resumed", sessionId: "s1", capabilities: caps }),
			});
			b.handleDaemonMessage(
				frame("agent:stream", { chunk: "rest of the tui turn", final: true, origin: "tui" }),
			);
			b.handleDaemonMessage(frame("session:end", { reason: "turn-complete", origin: "tui" }));
			b.handleDaemonMessage(frame("agent:stream", { chunk: "untagged", final: true }));
			b.handleDaemonMessage(
				frame("agent:stream", { chunk: "telegram's own reply", final: true, origin: "telegram" }),
			);
		} finally {
			(globalThis as any).WebSocket = orig;
		}
		await flush();
		expect(sent).toEqual(["telegram's own reply"]);
	});
});
