/**
 * An empty final answer is a failed attempt, never a reply. Driven through the
 * production call shapes: retryPrompt arms the ladder, handleDaemonMessage
 * receives the daemon's final agent:stream frame.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFlowModeController } from "../flow/flow-mode";
import { TelegramDaemonBridge } from "./telegram-bridge";

const JAMES = 100000001;
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
});
afterEach(() => {
	globalThis.fetch = saved.fetch;
});

function make() {
	const b = new TelegramDaemonBridge({
		telegramToken: "tok",
		chatId: String(JAMES),
		daemonUrl: "ws://127.0.0.1:1",
		authorizedChatIds: [String(JAMES)],
		authorizedUserIds: [String(JAMES)],
		operatorUserIds: [String(JAMES)],
		env: {},
		flowController: createFlowModeController(),
	}) as any;
	b.voiceEnabled = false;
	const prompts: string[] = [];
	b.ws = {
		readyState: WebSocket.OPEN,
		send: (s: string) => {
			const m = JSON.parse(s);
			if (m.type === "prompt") prompts.push(m.text);
		},
	};
	b.freshSession = () => {};
	b.agentBusy = true;
	b.retryPrompt("what is the status", 1);
	return { b, prompts };
}
const final = (b: any, chunk: unknown) =>
	b.handleDaemonMessage({ type: "event", event: "agent:stream", payload: { final: true, chunk } });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("empty final answer", () => {
	for (const empty of ["", "   \n\t", "<think>reasoning that never closes", undefined]) {
		test(`${JSON.stringify(empty)} is not sent and advances to the next attempt`, async () => {
			const t = make();
			final(t.b, empty);
			await settle();
			expect(sent.some((s) => s.trim() === "")).toBe(false);
			// attempt 2: the simpler prompt went out, with its notice, and the turn is still open
			expect(t.prompts.length).toBe(2);
			expect(t.prompts[1]).toContain("Original question: what is the status");
			expect(sent).toEqual(["Taking a bit longer than expected. Trying a simpler approach..."]);
			expect(t.b.agentBusy).toBe(true);
			clearTimeout(t.b._retryTimer);
		});
	}

	test("empty answers on every attempt end in the fallback message, never a blank reply", async () => {
		const t = make();
		for (let i = 0; i < 3; i++) final(t.b, "");
		await settle();
		expect(sent.some((s) => s.trim() === "")).toBe(false);
		expect(sent[sent.length - 1]).toContain("couldn't complete this one");
		expect(t.b.agentBusy).toBe(false);
	});

	test("a real answer is still sent and ends the turn", async () => {
		const t = make();
		final(t.b, "Build is green.");
		await settle();
		expect(sent).toEqual(["Build is green."]);
		expect(t.prompts.length).toBe(1);
		expect(t.b.agentBusy).toBe(false);
		expect(t.b._retryTimer).toBeNull();
	});
});
