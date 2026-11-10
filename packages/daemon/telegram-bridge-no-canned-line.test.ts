import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFlowModeController } from "../flow/flow-mode";
import { COMPLETION_PHRASES, GREETINGS } from "../personality/voice";
import { TelegramDaemonBridge, needsToolWork, retryPlan } from "./telegram-bridge";

describe("retryPlan", () => {
	test("research keeps the prompt, tools and full timeout, one retry then stop", () => {
		const q = "Research the latest options for local speech models and compare them";
		expect(needsToolWork(q)).toBe(true);
		const p2 = retryPlan(q, 2);
		expect(p2.prompt).toBe(q);
		expect(p2.timeout).toBe(120_000);
		expect(p2.notice).toBe("No answer yet after 120 seconds. Still working.");
		expect(retryPlan(q, 3).final).toContain("No answer was produced");
	});
	test("one notice only, at the first retry", () => {
		const q = "hello there";
		expect(retryPlan(q, 1).notice).toBeUndefined();
		expect(retryPlan(q, 2).notice).toBeDefined();
		expect(retryPlan(q, 3).notice).toBeUndefined();
		expect(retryPlan(q, 4).notice).toBeUndefined();
	});
	test("small talk may still shrink", () => {
		expect(retryPlan("hello there", 2).prompt).toContain("Limit tool use");
		expect(retryPlan("hello there", 3).prompt).toContain("Do NOT use any tools");
	});
	test("final fallback is plain: no stock phrase, no done claim", () => {
		const f = retryPlan("hello there", 5).final as string;
		expect(f).toContain("timed out");
		for (const p of COMPLETION_PHRASES) expect(f).not.toContain(p);
		expect(f).not.toMatch(/\b(done|completed|accomplished)\b/i);
		expect(f).not.toContain("—");
	});
});

const JAMES = 100000001;
const realFetch = globalThis.fetch;
let sent: string[];

beforeEach(() => {
	sent = [];
	globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
		try {
			const b = init?.body ? JSON.parse(init.body) : {};
			if (typeof b.text === "string") sent.push(b.text);
		} catch {}
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
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

describe("empty final reply goes straight to the retry plan", () => {
	for (const empty of ["", "   \n\t", "<think>reasoning that never closes", undefined]) {
		test(`${JSON.stringify(empty)} is not sent and advances to the next attempt`, async () => {
			const t = make();
			final(t.b, empty);
			await settle();
			expect(sent.some((s) => s.trim() === "")).toBe(false);
			expect(t.prompts.length).toBe(2);
			expect(t.prompts[1]).toContain("Original question: what is the status");
			expect(sent).toEqual(["No answer yet after 120 seconds. Still working."]);
			expect(t.b.agentBusy).toBe(true);
			clearTimeout(t.b._retryTimer);
		});
	}

	test("empty replies on every attempt end in the plain final message, never a blank or a stock line", async () => {
		const t = make();
		for (let i = 0; i < 4; i++) final(t.b, "");
		await settle();
		expect(sent.some((s) => s.trim() === "")).toBe(false);
		expect(sent[sent.length - 1]).toContain("No answer was produced");
		for (const p of [...COMPLETION_PHRASES, ...GREETINGS]) expect(sent.join("\n")).not.toContain(p);
		expect(t.b.agentBusy).toBe(false);
	});

	test("a whitespace-only chunk with no retry armed posts nothing", async () => {
		const t = make();
		clearTimeout(t.b._retryTimer);
		t.b._retryTimer = null;
		final(t.b, "  \n ");
		await settle();
		expect(sent).toEqual([]);
	});
});

describe("bridge delivers the model reply byte-identical", () => {
	test("50 runs, no phrase from any list added", async () => {
		const reply = "Build is green.\n\nTwo files changed.";
		for (let i = 0; i < 50; i++) {
			sent.length = 0;
			const t = make();
			final(t.b, reply);
			await settle();
			expect(sent).toEqual([reply]);
			expect(t.b.agentBusy).toBe(false);
		}
	});
});
