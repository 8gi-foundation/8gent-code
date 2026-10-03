/**
 * QA tab must not hand apfel to a host that cannot run it (#3390).
 *
 * The settings default pins the QA tab to apfel / apple-foundationmodel, which
 * only exists on macOS with Apple Silicon. On Linux, activating the QA tab
 * swapped the session to that model and the first turn went to Ollama as
 * "apple-foundationmodel". resolveSpecForRole now returns null off darwin
 * arm64, which app.tsx treats as "keep the current provider and model".
 *
 * Runs against the temp $HOME from tests/preload-temp-home.ts, so the QA tab
 * spec comes from DEFAULT_SETTINGS, never this machine's settings file.
 */

import { describe, expect, test } from "bun:test";
import { resolveSpecForRole } from "./usePerTabAgents.js";

describe("resolveSpecForRole platform gate (#3390)", () => {
	test("linux x64: qa resolves to null", () => {
		expect(resolveSpecForRole("qa", { platform: "linux", arch: "x64" })).toBeNull();
	});

	test("darwin x64 (Intel Mac): qa resolves to null", () => {
		expect(resolveSpecForRole("qa", { platform: "darwin", arch: "x64" })).toBeNull();
	});

	test("darwin arm64: qa resolves to apfel / apple-foundationmodel", () => {
		expect(resolveSpecForRole("qa", { platform: "darwin", arch: "arm64" })).toEqual({
			provider: "apfel",
			model: "apple-foundationmodel",
			role: "qa",
		});
	});

	test("linux x64: a non-apfel role still resolves", () => {
		const spec = resolveSpecForRole("orchestrator", { platform: "linux", arch: "x64" });
		expect(spec?.provider).toBe("ollama");
	});
});
