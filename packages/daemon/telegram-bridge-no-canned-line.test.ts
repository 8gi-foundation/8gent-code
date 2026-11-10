import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isFlavorExempt, isPlainReplyChannel } from "../eight/agent-scopes";
import { COMPLETION_PHRASES, flavorResponse } from "../personality/voice";
import { TelegramDaemonBridge, needsToolWork, retryPlan } from "./telegram-bridge";

describe("flavorResponse on an empty reply", () => {
	test("no completion phrase on empty or whitespace content", () => {
		for (const c of ["", "   ", "\n\t"]) {
			const out = flavorResponse(c, { style: "completion", suffix: COMPLETION_PHRASES[0] });
			expect(out).toBe(c);
			for (const p of COMPLETION_PHRASES) expect(out).not.toContain(p);
		}
	});
	test("a real reply is still flavored", () => {
		expect(flavorResponse("done", { style: "completion", suffix: "x" })).toBe("done\n\nx");
	});
});

describe("isFlavorExempt", () => {
	test("table, classroom and plainReplies are exempt; the local app is not", () => {
		expect(isFlavorExempt({ agentScope: "__table__" })).toBe(true);
		expect(isFlavorExempt({ agentScope: "__classroom__" })).toBe(true);
		expect(isFlavorExempt({ plainReplies: true })).toBe(true);
		expect(isFlavorExempt({})).toBe(false);
		expect(isFlavorExempt({ plainReplies: false })).toBe(false);
	});
	test("telegram is a plain-reply channel, the app is not", () => {
		expect(isPlainReplyChannel("telegram")).toBe(true);
		expect(isPlainReplyChannel("tui")).toBe(false);
		expect(isPlainReplyChannel(undefined)).toBe(false);
	});
});

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

describe("bridge turn with an empty model reply", () => {
	const sent: string[] = [];
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		sent.length = 0;
		globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
			sent.push(init?.body ?? "");
			return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
		}) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("nothing sent claims completion", async () => {
		const b = new TelegramDaemonBridge({
			telegramToken: "tok",
			chatId: "1",
			daemonUrl: "ws://127.0.0.1:1",
			env: {},
		}) as any;
		b.sessionId = "s1";
		b.agentBusy = true;
		b.handleDaemonMessage({
			type: "event",
			event: "agent:stream",
			payload: {
				sessionId: "s1",
				final: true,
				chunk: flavorResponse("", { style: "completion", suffix: COMPLETION_PHRASES[0] }),
			},
		});
		await new Promise((r) => setTimeout(r, 20));
		const all = sent.join("\n");
		expect(all).not.toContain("Mission accomplished");
		for (const p of COMPLETION_PHRASES) expect(all).not.toContain(p);
		expect(retryPlan("research this", 3).final ?? "").not.toContain("Mission accomplished");
	});
});
