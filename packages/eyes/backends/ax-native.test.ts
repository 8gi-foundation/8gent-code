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

import { describe, expect, it } from "bun:test";
import { axNativeBackend, createAxNativeEyes, probePermissions } from "./ax-native.js";

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
