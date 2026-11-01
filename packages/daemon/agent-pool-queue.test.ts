/**
 * #3554: a busy session queues messages instead of refusing them.
 *
 * Behind EIGHT_SESSION_QUEUE=1 a per-session FIFO (bounded by
 * EIGHT_SESSION_QUEUE_MAX, default 32) holds messages that arrive while the
 * agent is busy, and runs them in arrival order. A full queue is a clear
 * error, and destroying the session drops whatever is still waiting.
 * With the flag unset the old "[error] agent is busy" refusal is unchanged.
 *
 * The session's Agent is swapped for a fake whose chat() resolves on demand,
 * so no model, network or provider is touched.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["EIGHT_SESSION_QUEUE", "EIGHT_SESSION_QUEUE_MAX", "EIGHT_DATA_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;
let AgentPool: typeof import("./agent-pool").AgentPool;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "pool3554-data-"));
	for (const k of KEYS) saved[k] = process.env[k];
	process.env.EIGHT_DATA_DIR = dataDir;
	({ AgentPool } = await import("./agent-pool"));
});

afterEach(() => {
	delete process.env.EIGHT_SESSION_QUEUE;
	delete process.env.EIGHT_SESSION_QUEUE_MAX;
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

/** A fake agent: each chat() waits until release() is called, and logs order. */
function fakeAgent() {
	const started: string[] = [];
	const pending: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const agent = {
		getRuntime: () => "ollama",
		getModel: () => "fake",
		async chat(text: string): Promise<string> {
			started.push(text);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((r) => pending.push(r));
			inFlight--;
			return `done:${text}`;
		},
	};
	return {
		agent,
		started,
		get maxInFlight() {
			return maxInFlight;
		},
		/** Release every chat() currently waiting, then let microtasks settle. */
		async drain(): Promise<void> {
			for (let guard = 0; guard < 1000; guard++) {
				const next = pending.shift();
				if (!next) {
					await new Promise((r) => setTimeout(r, 0));
					if (pending.length === 0) return;
					continue;
				}
				next();
				await new Promise((r) => setTimeout(r, 0));
			}
		},
	};
}

function poolWithFake(id: string) {
	const pool = new AgentPool({ runtime: "ollama", model: "fake" });
	pool.createSession(id, "api");
	const fake = fakeAgent();
	// biome-ignore lint/suspicious/noExplicitAny: test swaps the private Agent for a fake
	(pool as any).sessions.get(id).agent = fake.agent;
	return { pool, fake };
}

const BURST = 20;
const msgs = Array.from({ length: BURST }, (_, i) => `m${i}`);

describe("per-session queue (#3554)", () => {
	test("flag off: a burst of 20 gets 19 busy refusals (unchanged default)", async () => {
		const { pool, fake } = poolWithFake("off-1");
		const replies = msgs.map((m) => pool.chat("off-1", m));
		await fake.drain();
		const out = await Promise.all(replies);
		expect(out.filter((r) => r === "[error] agent is busy")).toHaveLength(BURST - 1);
		expect(out[0]).toBe("done:m0");
		pool.destroySession("off-1");
	});

	test("flag on: a burst of 20 gets 0 refusals, served one at a time in order", async () => {
		process.env.EIGHT_SESSION_QUEUE = "1";
		const { pool, fake } = poolWithFake("on-1");
		const replies = msgs.map((m) => pool.chat("on-1", m));
		await fake.drain();
		const out = await Promise.all(replies);
		expect(out).toEqual(msgs.map((m) => `done:${m}`));
		expect(fake.started).toEqual(msgs);
		expect(fake.maxInFlight).toBe(1);
		expect(pool.getSessionInfo("on-1")?.busy).toBe(false);
		expect(pool.getSessionInfo("on-1")?.messageCount).toBe(BURST);
		pool.destroySession("on-1");
	});

	test("flag on: a full queue is a clear error, not a silent drop", async () => {
		process.env.EIGHT_SESSION_QUEUE = "1";
		process.env.EIGHT_SESSION_QUEUE_MAX = "3";
		const { pool, fake } = poolWithFake("full-1");
		// 1 running + 3 queued; the 5th and 6th are refused.
		const replies = msgs.slice(0, 6).map((m) => pool.chat("full-1", m));
		await fake.drain();
		const out = await Promise.all(replies);
		expect(out.slice(0, 4)).toEqual(["done:m0", "done:m1", "done:m2", "done:m3"]);
		expect(out.slice(4)).toEqual(["[error] session queue full", "[error] session queue full"]);
		pool.destroySession("full-1");
	});

	test("flag on: an invalid max falls back to 32 waiting, and 0 means no waiting line", async () => {
		process.env.EIGHT_SESSION_QUEUE = "1";
		for (const bad of ["abc", "-1", "2.5"]) {
			process.env.EIGHT_SESSION_QUEUE_MAX = bad;
			const id = `max-${bad}`;
			const { pool, fake } = poolWithFake(id);
			// 1 running + 32 waiting; the 34th is refused.
			const many = Array.from({ length: 34 }, (_, i) => `x${i}`);
			const replies = many.map((m) => pool.chat(id, m));
			await fake.drain();
			const out = await Promise.all(replies);
			expect(out.slice(0, 33)).toEqual(many.slice(0, 33).map((m) => `done:${m}`));
			expect(out[33]).toBe("[error] session queue full");
			pool.destroySession(id);
		}
		process.env.EIGHT_SESSION_QUEUE_MAX = "0";
		const { pool, fake } = poolWithFake("max-0");
		const replies = msgs.slice(0, 3).map((m) => pool.chat("max-0", m));
		await fake.drain();
		const out = await Promise.all(replies);
		expect(out).toEqual(["done:m0", "[error] session queue full", "[error] session queue full"]);
		pool.destroySession("max-0");
	});

	test("flag on: destroying the session drops queued messages", async () => {
		process.env.EIGHT_SESSION_QUEUE = "1";
		const { pool, fake } = poolWithFake("end-1");
		const replies = msgs.slice(0, 4).map((m) => pool.chat("end-1", m));
		await new Promise((r) => setTimeout(r, 0));
		pool.destroySession("end-1");
		await fake.drain();
		const out = await Promise.all(replies);
		expect(out[0]).toBe("done:m0");
		expect(out.slice(1)).toEqual([
			"[error] session ended",
			"[error] session ended",
			"[error] session ended",
		]);
		expect(fake.started).toEqual(["m0"]);
	});
});
