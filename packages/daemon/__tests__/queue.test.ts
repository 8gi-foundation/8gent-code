/**
 * #4254: durable work queue in front of the session pool.
 *
 * Sessions get a stub runtime (a fake Agent whose chat() resolves on demand),
 * so no model, network or provider is touched. The queue file lives in a
 * temp data dir.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["EIGHT_WORK_QUEUE", "EIGHT_WORK_QUEUE_STARTS", "EIGHT_DATA_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;
let AgentPool: typeof import("../agent-pool").AgentPool;
let WorkQueue: typeof import("../queue").WorkQueue;
let bus: typeof import("../events").bus;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "workq-data-"));
	for (const k of KEYS) saved[k] = process.env[k];
	process.env.EIGHT_DATA_DIR = dataDir;
	({ AgentPool } = await import("../agent-pool"));
	({ WorkQueue } = await import("../queue"));
	({ bus } = await import("../events"));
});

afterEach(() => {
	delete process.env.EIGHT_WORK_QUEUE;
	delete process.env.EIGHT_WORK_QUEUE_STARTS;
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

/** A stub runtime shared by every session: chat() waits until released, FIFO. */
function stubRuntime() {
	const started: string[] = [];
	const pending: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const agent = {
		getRuntime: () => "ollama",
		getModel: () => "stub",
		abort() {},
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
		pending,
		/** Largest pool size seen right after any session was created. */
		maxPool: 0,
		get maxInFlight() {
			return maxInFlight;
		},
		/** Release waiting chats one at a time, oldest first, until none are left. */
		async drain(): Promise<void> {
			for (let guard = 0; guard < 1000; guard++) {
				await tick();
				const next = pending.shift();
				if (!next) {
					await tick();
					if (pending.length === 0) return;
					continue;
				}
				next();
			}
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A pool whose sessions all run on the stub runtime. */
function stubPool(
	stub: ReturnType<typeof stubRuntime>,
	options: { queue?: InstanceType<typeof WorkQueue> } = {},
) {
	class StubPool extends AgentPool {
		override createSession(...args: Parameters<InstanceType<typeof AgentPool>["createSession"]>) {
			super.createSession(...args);
			stub.maxPool = Math.max(stub.maxPool, this.size);
			// biome-ignore lint/suspicious/noExplicitAny: test swaps the private Agent for a stub
			(this as any).sessions.get(args[0]).agent = stub.agent;
		}
	}
	return new StubPool({ runtime: "ollama", model: "stub" }, options);
}

let n = 0;
const freshPath = () => join(dataDir, `queue-${++n}.jsonl`);

describe("work queue (#4254)", () => {
	test("15 prompts into a pool capped at 10: all complete in acceptance order, never more than 10 sessions, no eviction", async () => {
		const stub = stubRuntime();
		const queue = new WorkQueue(freshPath(), { maxSessions: 10, startLimit: 10 });
		const pool = stubPool(stub, { queue });
		const evictions: string[] = [];
		const onEnd = (e: { reason: string }) => {
			if (e.reason === "channel-cap-evict") evictions.push(e.reason);
		};
		const sub = bus.on("session:end", onEnd);
		const texts = Array.from({ length: 15 }, (_, i) => `p${i}`);
		for (const [i, t] of texts.entries()) pool.submit({ requestId: `r${i}`, text: t });
		expect(stub.started).toHaveLength(10);
		await stub.drain();
		bus.off(sub);
		expect(stub.started).toEqual(texts);
		expect(texts.map((_, i) => queue.status(`r${i}`))).toEqual(texts.map(() => "done"));
		expect(stub.maxPool).toBe(10);
		expect(stub.maxInFlight).toBe(10);
		expect(evictions).toHaveLength(0);
		expect(pool.size).toBe(0);
	});

	test("the start throttle caps concurrent starts and never exceeds MAX_SESSIONS", async () => {
		const stub = stubRuntime();
		const queue = new WorkQueue(freshPath(), { maxSessions: 10, startLimit: 3 });
		const pool = stubPool(stub, { queue });
		for (let i = 0; i < 7; i++) pool.submit({ requestId: `t${i}`, text: `t${i}` });
		expect(stub.started).toHaveLength(3);
		await stub.drain();
		expect(stub.maxInFlight).toBe(3);
		expect(stub.started).toHaveLength(7);
		expect(new WorkQueue(freshPath(), { maxSessions: 10, startLimit: 99 }).startLimit).toBe(10);
		process.env.EIGHT_WORK_QUEUE_STARTS = "64";
		expect(new WorkQueue(freshPath(), { maxSessions: 10 }).startLimit).toBe(10);
	});

	test("a repeated requestId returns the same receipt without a second run", async () => {
		const stub = stubRuntime();
		const queue = new WorkQueue(freshPath(), { maxSessions: 10, startLimit: 2 });
		const pool = stubPool(stub, { queue });
		const first = pool.submit({ requestId: "same", text: "once" });
		const again = pool.submit({ requestId: "same", text: "once" });
		expect(first.duplicate).toBe(false);
		expect(again.duplicate).toBe(true);
		expect(again.receipt).toEqual(first.receipt);
		await stub.drain();
		const late = pool.submit({ requestId: "same", text: "once" });
		await stub.drain();
		expect(late.receipt).toEqual(first.receipt);
		expect(stub.started).toEqual(["once"]);
	});

	test("the store is mode 0600 and survives a torn last line", () => {
		const path = freshPath();
		const q = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		q.enqueue({ requestId: "a", text: "x" });
		q.close();
		expect(statSync(path).mode & 0o777).toBe(0o600);
		appendFileSync(path, '{"op":"accept","requ');
		const again = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		expect(again.status("a")).toBe("queued");
	});

	test("simulated restart: queued items run exactly once, the in-flight item is unknown and never resent", async () => {
		const path = freshPath();
		const before = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		before.enqueue({ requestId: "inflight", text: "was running" });
		before.enqueue({ requestId: "q1", text: "waiting 1" });
		before.enqueue({ requestId: "q2", text: "waiting 2" });
		before.markStarted("inflight");
		before.close(); // the process dies here

		const stub = stubRuntime();
		const after = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		expect(after.status("inflight")).toBe("unknown");
		expect(after.unknownAfterRestart).toEqual(["inflight"]);
		const pool = stubPool(stub, { queue: after });
		await stub.drain();
		expect(stub.started).toEqual(["waiting 1", "waiting 2"]);
		const resend = pool.submit({ requestId: "inflight", text: "was running" });
		expect(resend.duplicate).toBe(true);
		await stub.drain();
		expect(stub.started).toEqual(["waiting 1", "waiting 2"]);
		after.close();

		// A second restart finds nothing left to run.
		const stub2 = stubRuntime();
		const third = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		stubPool(stub2, { queue: third });
		await stub2.drain();
		expect(stub2.started).toEqual([]);
		expect(third.status("q1")).toBe("done");
		expect(third.status("inflight")).toBe("unknown");
		expect(third.unknownAfterRestart).toEqual([]);
	});

	test("a torn tail with no newline does not swallow the next accept: it replays after a restart", () => {
		const path = freshPath();
		const q = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		q.enqueue({ requestId: "a", text: "x" });
		q.close();
		appendFileSync(path, '{"op":"accept","requ'); // crash mid-write, no trailing newline
		const second = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		second.enqueue({ requestId: "b", text: "after the tear" });
		second.close();
		const third = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		expect(third.status("a")).toBe("queued");
		expect(third.status("b")).toBe("queued");
		third.close();
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
	});

	test("single writer: a second queue on the same file is refused while the first holds the lock", () => {
		const path = freshPath();
		const first = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		expect(readFileSync(`${path}.lock`, "utf8").trim()).toBe(String(process.pid));
		expect(statSync(`${path}.lock`).mode & 0o777).toBe(0o600);
		expect(() => new WorkQueue(path, { maxSessions: 10, startLimit: 1 })).toThrow(
			/locked by pid \d+/,
		);
		first.close();
		expect(existsSync(`${path}.lock`)).toBe(false);
		const next = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		next.close();
	});

	test("single writer: a lock left by a dead process is taken over", () => {
		const path = freshPath();
		const dead = Bun.spawnSync(["true"]).pid;
		writeFileSync(`${path}.lock`, `${dead}\n`);
		const q = new WorkQueue(path, { maxSessions: 10, startLimit: 1 });
		expect(readFileSync(`${path}.lock`, "utf8").trim()).toBe(String(process.pid));
		q.close();
	});

	test("single writer: a second daemon on a locked data dir runs with the queue disabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "workq-locked-"));
		const prev = process.env.EIGHT_DATA_DIR;
		process.env.EIGHT_DATA_DIR = dir;
		process.env.EIGHT_WORK_QUEUE = "1";
		const holder = new WorkQueue(join(dir, "work-queue.jsonl"), { maxSessions: 10, startLimit: 1 });
		try {
			const pool = stubPool(stubRuntime());
			expect(() => pool.submit({ requestId: "x", text: "y" })).toThrow(/work queue is off/);
		} finally {
			holder.close();
			process.env.EIGHT_DATA_DIR = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing queue directory is created 0700; an existing one keeps its mode", () => {
		const fresh = join(dataDir, `newdir-${++n}`, "nested");
		const q = new WorkQueue(join(fresh, "q.jsonl"), { maxSessions: 10, startLimit: 1 });
		q.close();
		expect(statSync(fresh).mode & 0o777).toBe(0o700);
		const existing = join(dataDir, `olddir-${++n}`);
		mkdirSync(existing, { mode: 0o755 });
		const q2 = new WorkQueue(join(existing, "q.jsonl"), { maxSessions: 10, startLimit: 1 });
		q2.close();
		expect(statSync(existing).mode & 0o777).toBe(0o755);
	});

	test("flag off: no queue, and an eleventh session still evicts the oldest idle one", () => {
		const stub = stubRuntime();
		const pool = stubPool(stub);
		expect(() => pool.submit({ requestId: "x", text: "y" })).toThrow(/work queue is off/);
		const ended: string[] = [];
		const onEnd = (e: { sessionId: string; reason: string }) =>
			ended.push(`${e.sessionId}:${e.reason}`);
		const sub = bus.on("session:end", onEnd);
		for (let i = 0; i < 11; i++) pool.createSession(`off-${i}`, "api");
		bus.off(sub);
		expect(pool.size).toBe(10);
		expect(pool.hasSession("off-0")).toBe(false);
		expect(ended).toEqual(["off-0:channel-cap-evict"]);
		for (let i = 1; i < 11; i++) pool.destroySession(`off-${i}`);
	});

	test("flag on via env: the pool opens its queue under the data dir", () => {
		process.env.EIGHT_WORK_QUEUE = "1";
		const pool = stubPool(stubRuntime());
		const r = pool.submit({ requestId: "env-1", text: "hi" });
		expect(r.receipt.requestId).toBe("env-1");
		expect(statSync(join(dataDir, "work-queue.jsonl")).mode & 0o777).toBe(0o600);
	});
});
