import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFlowModeController } from "../flow/flow-mode";
import { COMPLETION_PHRASES, GREETINGS } from "../personality/voice";
import { TelegramDaemonBridge, needsToolWork, retryPlan } from "./telegram-bridge";

/** Prompts each attempt sends until the plan returns the final fallback. */
function promptsSent(q: string): number {
	let n = 0;
	for (let a = 1; a < 10; a++) {
		if (retryPlan(q, a, { reason: "timeout", elapsedMs: 1 }).final) break;
		n++;
	}
	return n;
}
/** main sent 3 prompts for every message, then the fallback at attempt 4 with no prompt. */
const MAIN_PROMPTS = 3;

describe("retryPlan", () => {
	const research = "Research the latest options for local speech models and compare them";
	const ordinary = "hello there";

	test("research keeps the prompt, tools and full timeout, one retry then stop", () => {
		expect(needsToolWork(research)).toBe(true);
		const p2 = retryPlan(research, 2, { reason: "timeout", elapsedMs: 120_000 });
		expect(p2.prompt).toBe(research);
		expect(p2.timeout).toBe(120_000);
		expect(retryPlan(research, 3, { reason: "timeout", elapsedMs: 240_000 }).final).toContain(
			"No answer was produced",
		);
	});
	test("an ordinary message: attempt 4 is the final fallback and sends no prompt", () => {
		expect(needsToolWork(ordinary)).toBe(false);
		expect(retryPlan(ordinary, 3, { reason: "timeout", elapsedMs: 1 }).final).toBeUndefined();
		const p4 = retryPlan(ordinary, 4, { reason: "timeout", elapsedMs: 1 });
		expect(p4.final).toBeDefined();
		expect(p4.timeout).toBe(0);
	});
	test("total prompts never exceed main for either kind of message", () => {
		expect(promptsSent(ordinary)).toBe(3);
		expect(promptsSent(research)).toBe(2);
		for (const q of [ordinary, research]) expect(promptsSent(q)).toBeLessThanOrEqual(MAIN_PROMPTS);
	});
	test("one notice only, at the first retry", () => {
		const e = { reason: "timeout" as const, elapsedMs: 120_000 };
		expect(retryPlan(ordinary, 1).notice).toBeUndefined();
		expect(retryPlan(ordinary, 2, e).notice).toBeDefined();
		expect(retryPlan(ordinary, 3, e).notice).toBeUndefined();
	});
	test("small talk may still shrink", () => {
		const e = { reason: "timeout" as const, elapsedMs: 1 };
		expect(retryPlan(ordinary, 2, e).prompt).toContain("Limit tool use");
		expect(retryPlan(ordinary, 3, e).prompt).toContain("Do NOT use any tools");
	});

	describe("the notice and fallback state the real reason and measured time", () => {
		test("timeout: says it ran out of time, with the measured seconds", () => {
			expect(retryPlan(ordinary, 2, { reason: "timeout", elapsedMs: 121_400 }).notice).toBe(
				"No answer yet after 121 seconds. Still working.",
			);
			expect(retryPlan(ordinary, 4, { reason: "timeout", elapsedMs: 271_000 }).final).toBe(
				"No answer was produced after 3 tries in 271 seconds; the last one ran out of time. Send it again or break it into a smaller task.",
			);
		});
		test("empty reply: says it came back empty, never that it timed out or waited 120 seconds", () => {
			const n = retryPlan(ordinary, 2, { reason: "empty", elapsedMs: 3_200 }).notice as string;
			expect(n).toBe("The first try came back empty after 3 seconds. Trying again.");
			const f = retryPlan(research, 3, { reason: "empty", elapsedMs: 400 }).final as string;
			expect(f).toBe(
				"No answer was produced after 2 tries in less than a second; the last one came back empty. Send it again or break it into a smaller task.",
			);
			for (const t of [n, f]) {
				expect(t).not.toMatch(/timed out|ran out of time|120/);
			}
		});
	});

	test("final fallback is plain: no stock phrase, no done claim", () => {
		for (const reason of ["timeout", "empty"] as const) {
			const f = retryPlan(ordinary, 4, { reason, elapsedMs: 5_000 }).final as string;
			for (const p of COMPLETION_PHRASES) expect(f).not.toContain(p);
			expect(f).not.toMatch(/\b(done|completed|accomplished)\b/i);
			expect(f).not.toContain("\u2014");
		}
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
			expect(sent).toEqual([
				"The first try came back empty after less than a second. Trying again.",
			]);
			expect(t.b.agentBusy).toBe(true);
			clearTimeout(t.b._retryTimer);
		});
	}

	test("empty replies on every attempt end in the plain final message, never a blank or a stock line", async () => {
		const t = make();
		for (let i = 0; i < 4; i++) final(t.b, "");
		await settle();
		expect(sent.some((s) => s.trim() === "")).toBe(false);
		// Three prompts, the same as main, then the fallback with no fourth prompt.
		expect(t.prompts.length).toBe(3);
		expect(sent[sent.length - 1]).toBe(
			"No answer was produced after 3 tries in less than a second; the last one came back empty. Send it again or break it into a smaller task.",
		);
		expect(sent.join("\n")).not.toMatch(/timed out|120 seconds/);
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
