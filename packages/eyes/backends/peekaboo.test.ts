/**
 * Peekaboo backend tests.
 *
 * Real subprocess tests gated on a local install. When `peekaboo` is on
 * PATH AND Screen Recording / Accessibility entitlements are granted, the
 * integration block runs end-to-end against the user's actual desktop.
 * Otherwise the block is skipped and a console note explains how to enable.
 *
 * Pure unit tests (descriptor shape, helper functions) always run.
 */

import { describe, expect, it } from "bun:test";
import { createPeekabooEyes, peekabooBackend, probePermissions } from "./peekaboo.js";

describe("peekabooBackend descriptor", () => {
	it("declares the right id and platforms", () => {
		expect(peekabooBackend.id).toBe("peekaboo");
		expect(peekabooBackend.platforms).toEqual(["darwin"]);
		expect(peekabooBackend.minOSVersion).toBe("15.0");
	});

	it("available() returns false on non-darwin", async () => {
		if (process.platform === "darwin") return; // skip on Mac
		expect(await peekabooBackend.available()).toBe(false);
	});

	it("available() returns boolean on darwin", async () => {
		if (process.platform !== "darwin") return;
		const result = await peekabooBackend.available();
		expect(typeof result).toBe("boolean");
	});

	it("create() returns an Eyes instance with expected shape", () => {
		const eyes = peekabooBackend.create();
		expect(eyes.id).toBe("peekaboo");
		expect(eyes.backend).toBe("peekaboo");
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

describe("integration - peekaboo subprocess", () => {
	it("end-to-end capture + annotate (skipped if peekaboo not installed)", async () => {
		const ok = await peekabooBackend.available();
		if (!ok) {
			console.log(
				"skip: peekaboo not installed or entitlements missing. Install with `brew install steipete/tap/peekaboo` and grant Screen Recording + Accessibility.",
			);
			return;
		}
		const eyes = peekabooBackend.create();
		const frame = await eyes.capture();
		expect(frame.platform).toBe("darwin");
		expect(frame.scale).toBeGreaterThan(0);
		expect(frame.width).toBeGreaterThan(0);
		expect(frame.height).toBeGreaterThan(0);

		const annotated = await eyes.annotate(frame);
		expect(Array.isArray(annotated.elements)).toBe(true);
		// On a real desktop we expect at least the menu bar to expose elements.
		expect(annotated.elements.length).toBeGreaterThan(0);
	}, 30_000);

	it("permission probe returns structured result", async () => {
		// probePermissions is a low-level helper; safe to call regardless of perms.
		const r = await probePermissions({});
		expect(typeof r.ok).toBe("boolean");
	});
});

describe("describe() - perception:remote tier wiring", () => {
	it("throws when no visionProvider injected", async () => {
		const eyes = peekabooBackend.create();
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
		const eyes = createPeekabooEyes({
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
		const eyes = createPeekabooEyes({
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
		const eyes = createPeekabooEyes({
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
