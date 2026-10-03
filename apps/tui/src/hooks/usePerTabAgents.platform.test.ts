/**
 * QA tab must not hand apfel to a host that cannot run it (#3390).
 *
 * The settings default pins the QA tab to apfel / apple-foundationmodel, which
 * only exists on macOS with Apple Silicon. On Linux, activating the QA tab
 * swapped the session to that model and the first turn went to Ollama as
 * "apple-foundationmodel". resolveSpecForRole now returns null off darwin
 * arm64, which app.tsx treats as "keep the current provider and model".
 *
 * Isolation: every call injects both the host (platform, arch) and the
 * settings loader. The loader returns a clone of DEFAULT_SETTINGS, or an
 * explicit override built from it, so no case reads this machine's
 * ~/.8gent/settings.json. The temp $HOME preload now covers that file too
 * (packages/settings/store.ts resolves it through resolveHome() since #3391);
 * the injected loader keeps each case independent of any settings on disk.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../../../packages/settings/index.js";
import type { Settings } from "../../../../packages/settings/index.js";
import { resolveSpecForRole } from "./usePerTabAgents.js";

const defaults = (): Settings => structuredClone(DEFAULT_SETTINGS);

/** DEFAULT_SETTINGS with the QA tab overridden to the given provider and model. */
const withQaTab = (provider: string, model: string) => (): Settings => {
	const s = defaults();
	s.models.tabs.qa = { provider, model };
	return s;
};

const LINUX = { platform: "linux", arch: "x64" };
const INTEL_MAC = { platform: "darwin", arch: "x64" };
const APPLE_SILICON = { platform: "darwin", arch: "arm64" };

describe("resolveSpecForRole platform gate (#3390)", () => {
	test("linux x64: qa resolves to null", () => {
		expect(resolveSpecForRole("qa", LINUX, defaults)).toBeNull();
	});

	test("darwin x64 (Intel Mac): qa resolves to null", () => {
		expect(resolveSpecForRole("qa", INTEL_MAC, defaults)).toBeNull();
	});

	test("darwin arm64: qa resolves to apfel / apple-foundationmodel", () => {
		expect(resolveSpecForRole("qa", APPLE_SILICON, defaults)).toEqual({
			provider: "apfel",
			model: "apple-foundationmodel",
			role: "qa",
		});
	});

	test("linux x64: a non-apfel role still resolves", () => {
		const spec = resolveSpecForRole("orchestrator", LINUX, defaults);
		expect(spec?.provider).toBe("ollama");
	});

	test("settings override to apfel: gated on linux, returned on darwin arm64", () => {
		const load = withQaTab("apfel", "custom-apfel-model");
		expect(resolveSpecForRole("qa", LINUX, load)).toBeNull();
		expect(resolveSpecForRole("qa", APPLE_SILICON, load)).toEqual({
			provider: "apfel",
			model: "custom-apfel-model",
			role: "qa",
		});
	});

	test('hand-edited " Apfel " provider is still gated on linux', () => {
		expect(resolveSpecForRole("qa", LINUX, withQaTab(" Apfel ", "apple-foundationmodel"))).toBeNull();
	});
});
