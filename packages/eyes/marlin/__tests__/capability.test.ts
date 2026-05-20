/**
 * Capability gate tests (VIDEO-INGESTION spec §11). The capability is OFF BY
 * DEFAULT; a fresh install carries no Python.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkVideoCapability } from "../capability.js";

const ENV_KEY = "EIGHT_VIDEO_INGESTION";
let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedEnv;
});

describe("checkVideoCapability", () => {
	test("is not installed by default (no flag, no venv)", () => {
		const cap = checkVideoCapability();
		expect(cap.installed).toBe(false);
		expect(cap.flagEnabled).toBe(false);
		expect(cap.reason).toBeDefined();
		expect(cap.reason).toContain("8gent vision install");
	});

	test("the env override flips the flag on, but the venv is still required", () => {
		process.env[ENV_KEY] = "1";
		const cap = checkVideoCapability();
		expect(cap.flagEnabled).toBe(true);
		// On a machine with no provisioned venv, `installed` stays false and
		// the reason points at the missing sidecar.
		if (!cap.venvPresent) {
			expect(cap.installed).toBe(false);
			expect(cap.reason).toContain("venv");
		}
	});
});
