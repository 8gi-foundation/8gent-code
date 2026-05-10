/**
 * Hands queue tests per spec §5.1 (one-pointer serialisation) and §7.1
 * (mid-click animation handling).
 *
 * The queue is the runtime mechanism that prevents two motor calls from
 * stomping each other during a struggle session. Outside a session the agent
 * loop is sequential and bears its own serialisation responsibility, but
 * inside a session it is the queue that holds that contract.
 */

import { describe, expect, it } from "bun:test";
import { createHandsQueue } from "../hands-queue.js";

interface Recorder {
	clicks: Array<{ at: number; key: string; x: number; y: number }>;
	captures: number;
	diffs: number;
	relocates: number;
}

function fakeHands(rec: Recorder, opts: { clickDelayMs?: number } = {}) {
	const clickDelay = opts.clickDelayMs ?? 0;
	return {
		id: "fake-hands",
		available: true,
		capabilities: {} as never,
		click(p: { x: number; y: number }, _btn?: unknown, _count?: unknown) {
			const now = Date.now();
			// Simulate cliclick latency so the serialisation invariant has teeth.
			const start = now;
			while (Date.now() - start < clickDelay) {
				// busy-wait: bun:test does not have a sync sleep primitive
			}
			rec.clicks.push({ at: now, key: "", x: p.x, y: p.y });
			return { ok: true } as const;
		},
		type(_text: string) {
			return { ok: true } as const;
		},
		press() {
			return { ok: true } as const;
		},
		scroll() {
			return { ok: true } as const;
		},
		drag() {
			return { ok: true } as const;
		},
		hover() {
			return { ok: true } as const;
		},
		mousePosition() {
			return { ok: true, point: { x: 0, y: 0 } };
		},
		clipboardGet() {
			return { ok: true, text: "" };
		},
		clipboardSet() {
			return { ok: true } as const;
		},
		windowList() {
			return { ok: true, windows: [] };
		},
		screenshot() {
			return { ok: true, path: "/tmp/x.png" };
		},
	} as unknown as Parameters<typeof createHandsQueue>[0]["hands"];
}

interface FakeEyesOpts {
	similarity: number;
}

function fakeEyes(rec: Recorder, opts: FakeEyesOpts) {
	return {
		id: "fake-eyes",
		available: true,
		backend: "fake",
		async capture() {
			rec.captures += 1;
			return {
				id: `cap-${rec.captures}`,
				path: "",
				width: 100,
				height: 100,
				displayId: 1,
				capturedAt: 0,
				scale: 1,
				platform: "darwin",
			} as const;
		},
		async captureAll() {
			return [];
		},
		async annotate(f: unknown) {
			return f as never;
		},
		async locate() {
			return [];
		},
		async describe() {
			return { summary: "" };
		},
		async wait_for() {
			return { ok: true, elapsedMs: 0 } as never;
		},
		async diff(_a: unknown, _b: unknown) {
			rec.diffs += 1;
			return { similarity: opts.similarity, regions: [], pixelsDifferent: 0 } as const;
		},
		observe() {
			return { dispose: () => {} } as const;
		},
	} as unknown as Parameters<typeof createHandsQueue>[0]["eyes"];
}

describe("hands queue", () => {
	it("serialises concurrent clicks (one mouse pointer constraint)", async () => {
		const rec: Recorder = { clicks: [], captures: 0, diffs: 0, relocates: 0 };
		const queue = createHandsQueue({
			hands: fakeHands(rec, { clickDelayMs: 10 }),
			eyes: fakeEyes(rec, { similarity: 1.0 }),
		});
		const t0 = Date.now();
		// Fire three clicks "in parallel". The queue must serialise them
		// (each click takes ~10ms, so total wall-clock should be >= 30ms).
		await Promise.all([
			queue.enqueueClick({ point: { x: 1, y: 1 }, key: "a" }),
			queue.enqueueClick({ point: { x: 2, y: 2 }, key: "b" }),
			queue.enqueueClick({ point: { x: 3, y: 3 }, key: "c" }),
		]);
		const elapsed = Date.now() - t0;
		expect(rec.clicks.length).toBe(3);
		expect(elapsed).toBeGreaterThanOrEqual(25);
		// Click order matches enqueue order.
		expect(rec.clicks.map((c) => c.x)).toEqual([1, 2, 3]);
	});

	it("does not relocate when the dispatch-time frame matches the locate frame", async () => {
		const rec: Recorder = { clicks: [], captures: 0, diffs: 0, relocates: 0 };
		const queue = createHandsQueue({
			hands: fakeHands(rec),
			eyes: fakeEyes(rec, { similarity: 1.0 }),
			relocate: async () => {
				rec.relocates += 1;
				return { x: 99, y: 99 };
			},
		});
		const out = await queue.enqueueClick({
			point: { x: 5, y: 5 },
			key: "k",
			locateFrame: {
				id: "f",
				path: "",
				width: 1,
				height: 1,
				displayId: 1,
				capturedAt: 0,
				scale: 1,
				platform: "darwin",
			} as never,
		});
		expect(out.ok).toBe(true);
		expect(rec.relocates).toBe(0);
		if (out.ok) expect(out.relocated).toBe(false);
	});

	it("re-locates when the dispatch-time frame diverges above the threshold", async () => {
		const rec: Recorder = { clicks: [], captures: 0, diffs: 0, relocates: 0 };
		const queue = createHandsQueue({
			hands: fakeHands(rec),
			eyes: fakeEyes(rec, { similarity: 0.5 }),
			relocate: async () => {
				rec.relocates += 1;
				return { x: 99, y: 99 };
			},
		});
		const out = await queue.enqueueClick({
			point: { x: 5, y: 5 },
			key: "k",
			locateFrame: {
				id: "f",
				path: "",
				width: 1,
				height: 1,
				displayId: 1,
				capturedAt: 0,
				scale: 1,
				platform: "darwin",
			} as never,
		});
		expect(out.ok).toBe(true);
		expect(rec.relocates).toBe(1);
		if (out.ok) {
			expect(out.relocated).toBe(true);
			expect(out.clickedAt).toEqual({ x: 99, y: 99 });
		}
	});

	it("returns no_match when relocate fails after divergence", async () => {
		const rec: Recorder = { clicks: [], captures: 0, diffs: 0, relocates: 0 };
		const queue = createHandsQueue({
			hands: fakeHands(rec),
			eyes: fakeEyes(rec, { similarity: 0.5 }),
			relocate: async () => null,
		});
		const out = await queue.enqueueClick({
			point: { x: 5, y: 5 },
			key: "k",
			locateFrame: {
				id: "f",
				path: "",
				width: 1,
				height: 1,
				displayId: 1,
				capturedAt: 0,
				scale: 1,
				platform: "darwin",
			} as never,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("no_match");
		expect(rec.clicks.length).toBe(0);
	});

	it("drain rejects new work and resolves once in-flight settles", async () => {
		const rec: Recorder = { clicks: [], captures: 0, diffs: 0, relocates: 0 };
		const queue = createHandsQueue({
			hands: fakeHands(rec, { clickDelayMs: 5 }),
			eyes: fakeEyes(rec, { similarity: 1.0 }),
		});
		const inflight = queue.enqueueClick({ point: { x: 1, y: 1 }, key: "a" });
		const drainPromise = queue.drain();
		await expect(
			queue.enqueueClick({ point: { x: 2, y: 2 }, key: "b" }),
		).rejects.toThrow("drained");
		await inflight;
		await drainPromise;
		expect(queue.draining).toBe(true);
	});

	it("a single failed call does not poison the queue", async () => {
		const rec: Recorder = { clicks: [], captures: 0, diffs: 0, relocates: 0 };
		const failingHands = {
			...(fakeHands(rec) as unknown as Record<string, unknown>),
			click: (p: { x: number; y: number }) => {
				if (p.x === 1) return { ok: false, error: "boom" } as const;
				rec.clicks.push({ at: Date.now(), key: "", x: p.x, y: p.y });
				return { ok: true } as const;
			},
		} as unknown as Parameters<typeof createHandsQueue>[0]["hands"];
		const queue = createHandsQueue({
			hands: failingHands,
			eyes: fakeEyes(rec, { similarity: 1.0 }),
		});
		const a = await queue.enqueueClick({ point: { x: 1, y: 1 }, key: "a" });
		const b = await queue.enqueueClick({ point: { x: 2, y: 2 }, key: "b" });
		expect(a.ok).toBe(false);
		expect(b.ok).toBe(true);
	});
});
