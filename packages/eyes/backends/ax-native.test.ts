/**
 * Native AX backend tests.
 *
 * Real subprocess tests gated on a local install. When the bundled
 * 8gent-ax-bridge binary exists AND Screen Recording / Accessibility
 * entitlements are granted, the integration block runs end-to-end against
 * the user's actual desktop. Otherwise the block is skipped and a console
 * note explains how to enable.
 *
 * Pure unit tests (descriptor shape, helper functions, perception:remote
 * tier wiring) always run.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Frame, ObservationEvent } from "../index.js";
import { axNativeBackend, createAxNativeEyes, probePermissions } from "./ax-native.js";

const TMP_ROOT = join(tmpdir(), `8gent-eyes-axnative-${Date.now()}`);
mkdirSync(TMP_ROOT, { recursive: true });

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function makePng(w: number, h: number, fill: { r: number; g: number; b: number }): Buffer {
	const png = new PNG({ width: w, height: h, colorType: 6 });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const idx = (y * w + x) * 4;
			png.data[idx] = fill.r;
			png.data[idx + 1] = fill.g;
			png.data[idx + 2] = fill.b;
			png.data[idx + 3] = 255;
		}
	}
	return PNG.sync.write(png);
}

function writePng(name: string, buf: Buffer): string {
	const path = join(TMP_ROOT, name);
	writeFileSync(path, buf);
	return path;
}

function makeFrame(path: string, w: number, h: number): Frame {
	return {
		id: `frm_${Math.random().toString(36).slice(2, 10)}`,
		path,
		width: w,
		height: h,
		displayId: 0,
		capturedAt: Date.now(),
		scale: 1,
		platform: "darwin",
	};
}

describe("axNativeBackend descriptor", () => {
	it("declares the right id and platforms", () => {
		expect(axNativeBackend.id).toBe("ax-native");
		expect(axNativeBackend.platforms).toEqual(["darwin"]);
		expect(axNativeBackend.minOSVersion).toBe("13.0");
	});

	it("available() returns false on non-darwin", async () => {
		if (process.platform === "darwin") return;
		expect(await axNativeBackend.available()).toBe(false);
	});

	it("available() returns boolean on darwin", async () => {
		if (process.platform !== "darwin") return;
		const result = await axNativeBackend.available();
		expect(typeof result).toBe("boolean");
	});

	it("create() returns an Eyes instance with expected shape", () => {
		const eyes = axNativeBackend.create();
		expect(eyes.id).toBe("ax-native");
		expect(eyes.backend).toBe("ax-native");
		expect(typeof eyes.capture).toBe("function");
		expect(typeof eyes.captureAll).toBe("function");
		expect(typeof eyes.annotate).toBe("function");
		expect(typeof eyes.locate).toBe("function");
		expect(typeof eyes.describe).toBe("function");
		expect(typeof eyes.wait_for).toBe("function");
		expect(typeof eyes.diff).toBe("function");
		expect(typeof eyes.observe).toBe("function");
	});
});

describe("integration - 8gent-ax-bridge subprocess", () => {
	it("end-to-end capture + annotate (skipped if bridge not installed)", async () => {
		const ok = await axNativeBackend.available();
		if (!ok) {
			console.log(
				"skip: 8gent-ax-bridge not built or entitlements missing. Build with `bash packages/eyes/native/build.sh` and grant Screen Recording + Accessibility.",
			);
			return;
		}
		const eyes = axNativeBackend.create();
		const frame = await eyes.capture();
		expect(frame.platform).toBe("darwin");
		expect(frame.scale).toBeGreaterThan(0);
		expect(frame.width).toBeGreaterThan(0);
		expect(frame.height).toBeGreaterThan(0);

		const annotated = await eyes.annotate(frame);
		expect(Array.isArray(annotated.elements)).toBe(true);
		// On a real desktop with AX granted we expect at least the menu bar
		// to expose elements; if AX is not granted, length may be 0 and the
		// bridge will emit a PERM_AX failure on annotate (not capture).
	}, 30_000);

	it("permission probe returns structured result", async () => {
		// probePermissions is a low-level helper; safe to call regardless of perms.
		const r = await probePermissions({});
		expect(typeof r.ok).toBe("boolean");
	});
});

describe("diff() - thresholdDelta / thresholdPx aliasing", () => {
	it("thresholdDelta is honored as the canonical name", async () => {
		const a = writePng("td-a.png", makePng(64, 64, { r: 100, g: 100, b: 100 }));
		// Make B differ by 20/255 per channel - below default threshold 30,
		// so default returns similarity=1; with thresholdDelta=10 we get <1.
		const b = writePng("td-b.png", makePng(64, 64, { r: 120, g: 120, b: 120 }));
		const eyes = axNativeBackend.create();
		const fa = makeFrame(a, 64, 64);
		const fb = makeFrame(b, 64, 64);

		const def = await eyes.diff(fa, fb);
		const sensitive = await eyes.diff(fa, fb, { thresholdDelta: 10 });

		expect(def.similarity).toBe(1);
		expect(sensitive.similarity).toBeLessThan(1);
	});

	it("thresholdPx still works as a deprecated alias", async () => {
		const a = writePng("tp-a.png", makePng(64, 64, { r: 100, g: 100, b: 100 }));
		const b = writePng("tp-b.png", makePng(64, 64, { r: 120, g: 120, b: 120 }));
		const eyes = axNativeBackend.create();
		const fa = makeFrame(a, 64, 64);
		const fb = makeFrame(b, 64, 64);

		const sensitive = await eyes.diff(fa, fb, { thresholdPx: 10 });
		expect(sensitive.similarity).toBeLessThan(1);
	});

	it("thresholdDelta wins when both are set", async () => {
		// thresholdDelta=100 (very loose): everything is "same" -> similarity=1
		// thresholdPx=5 (very tight) is ignored.
		const a = writePng("both-a.png", makePng(64, 64, { r: 100, g: 100, b: 100 }));
		const b = writePng("both-b.png", makePng(64, 64, { r: 130, g: 130, b: 130 }));
		const eyes = axNativeBackend.create();
		const fa = makeFrame(a, 64, 64);
		const fb = makeFrame(b, 64, 64);

		const r = await eyes.diff(fa, fb, { thresholdDelta: 100, thresholdPx: 5 });
		expect(r.similarity).toBe(1);
	});
});

describe("observe() - parse-error handling (closes #2530)", () => {
	it("disposes after 3 consecutive png-parse failures and surfaces a structured event", async () => {
		// Arrange a deterministic stub that always throws a "png parse failed"
		// error from diff(). capture() returns synthetic frames so the loop
		// gets past the first tick (which has no prev) and into diff() each
		// subsequent tick.
		const events: ObservationEvent[] = [];
		const eyes = axNativeBackend.create() as unknown as {
			capture: (opts?: unknown) => Promise<Frame>;
			diff: (a: Frame, b: Frame) => Promise<unknown>;
			observe: (h: (e: ObservationEvent) => void, o?: { intervalMs?: number }) => { dispose: () => void };
		};

		let captureCount = 0;
		eyes.capture = async () => {
			captureCount++;
			return makeFrame(`/tmp/synthetic-${captureCount}.png`, 8, 8);
		};
		eyes.diff = async () => {
			throw new Error("perceptualDiff: png parse failed for synthetic: corrupt header");
		};

		const handle = eyes.observe((e) => events.push(e), { intervalMs: 5 });

		// Wait long enough for >3 ticks (6 ticks budget).
		await new Promise((r) => setTimeout(r, 80));
		handle.dispose();

		// At least one structured "abort" event should have been surfaced
		// (similarity=0, regions=[], pixelsDifferent=0).
		const abortEvents = events.filter(
			(e) => e.diff.similarity === 0 && e.diff.regions.length === 0 && e.diff.pixelsDifferent === 0,
		);
		expect(abortEvents.length).toBeGreaterThanOrEqual(1);
	}, 5_000);

	it("non-parse failures do not trip the 3-strike abort", async () => {
		const events: ObservationEvent[] = [];
		const eyes = axNativeBackend.create() as unknown as {
			capture: (opts?: unknown) => Promise<Frame>;
			diff: (a: Frame, b: Frame) => Promise<unknown>;
			observe: (h: (e: ObservationEvent) => void, o?: { intervalMs?: number }) => { dispose: () => void };
		};

		eyes.capture = async () => {
			throw new Error("transient capture flake");
		};
		eyes.diff = async () => {
			throw new Error("should not be reached");
		};

		const handle = eyes.observe((e) => events.push(e), { intervalMs: 5 });
		await new Promise((r) => setTimeout(r, 60));
		handle.dispose();

		// No abort event should be surfaced for non-parse errors.
		expect(events.length).toBe(0);
	}, 5_000);
});

describe("describe() - perception:remote tier wiring", () => {
	it("throws when no visionProvider injected", async () => {
		const eyes = axNativeBackend.create();
		const frame = {
			id: "frm_test",
			path: "/tmp/none.png",
			width: 100,
			height: 100,
			displayId: 0,
			capturedAt: 0,
			scale: 1,
			platform: "darwin" as const,
		};
		await expect(eyes.describe(frame)).rejects.toThrow(/visionProvider/);
	});

	it("blocks when provider resolves remote without grant", async () => {
		const eyes = createAxNativeEyes({
			visionProvider: {
				resolveProviderId: async () => "openrouter",
				describe: async () => ({
					provider: "openrouter",
					model: "vision-test",
					text: "irrelevant",
				}),
			},
			sessionId: "test-s",
		});
		const frame = {
			id: "frm_test",
			path: "/tmp/none.png",
			width: 100,
			height: 100,
			displayId: 0,
			capturedAt: 0,
			scale: 1,
			platform: "darwin" as const,
		};
		await expect(eyes.describe(frame)).rejects.toThrow(/perception:remote/);
	});

	it("does NOT call describe() when remote tier denies - closes #2508 privacy bug", async () => {
		let inferenceCalls = 0;
		const eyes = createAxNativeEyes({
			visionProvider: {
				resolveProviderId: async () => "openrouter",
				describe: async () => {
					inferenceCalls++;
					return { provider: "openrouter", model: "vision-test", text: "frame leaked" };
				},
			},
			sessionId: "privacy-test",
		});
		const frame = {
			id: "frm_priv",
			path: "/tmp/none.png",
			width: 100,
			height: 100,
			displayId: 0,
			capturedAt: 0,
			scale: 1,
			platform: "darwin" as const,
		};
		await expect(eyes.describe(frame)).rejects.toThrow(/perception:remote/);
		expect(inferenceCalls).toBe(0);
	});

	it("allows local-resolved provider with no grant required", async () => {
		const eyes = createAxNativeEyes({
			visionProvider: {
				resolveProviderId: async () => "ollama",
				describe: async () => ({
					provider: "ollama",
					model: "qwen2.5-vl",
					text: "a screen",
				}),
			},
			sessionId: "test-s",
		});
		const frame = {
			id: "frm_test",
			path: "/tmp/none.png",
			width: 100,
			height: 100,
			displayId: 0,
			capturedAt: 0,
			scale: 1,
			platform: "darwin" as const,
		};
		const desc = await eyes.describe(frame);
		expect(desc.summary).toBe("a screen");
		expect(desc.model).toContain("ollama");
	});
});
