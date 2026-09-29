import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markIntroSeen, readSeenVersion, shouldShowIntro } from "./intro-gate.js";

describe("when the launch splash shows", () => {
	const base = { setting: "auto" as const, env: {}, version: "0.18.0" };

	test("first run shows it", () => {
		expect(shouldShowIntro({ ...base, seenVersion: null })).toBe(true);
	});

	test("a later launch of the same version does not", () => {
		expect(shouldShowIntro({ ...base, seenVersion: "0.18.0" })).toBe(false);
	});

	test("the first launch after an update shows it once more", () => {
		expect(shouldShowIntro({ ...base, seenVersion: "0.17.3" })).toBe(true);
	});

	test("opt-outs win over a new version, and the setting wins over everything", () => {
		expect(shouldShowIntro({ ...base, seenVersion: null, env: { "8GENT_NO_INTRO": "1" } })).toBe(false);
		expect(shouldShowIntro({ ...base, seenVersion: null, env: { "8GENT_LITE": "1" } })).toBe(false);
		expect(shouldShowIntro({ ...base, seenVersion: null, setting: "off" })).toBe(false);
		expect(shouldShowIntro({ ...base, seenVersion: "0.18.0", setting: "on" })).toBe(true);
	});

	test("the seen version round-trips through ~/.8gent/intro-seen", () => {
		const home = mkdtempSync(join(tmpdir(), "intro-gate-"));
		expect(readSeenVersion(home)).toBeNull();
		markIntroSeen("0.18.0", home);
		expect(readSeenVersion(home)).toBe("0.18.0");
	});
});
