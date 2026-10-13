/**
 * #3550: verify-before-done gate. A turn that changed files and checked
 * nothing since gets one nudge; off by default.
 */

import { describe, expect, test } from "bun:test";
import {
	VERIFY_NUDGE_MESSAGE,
	isVerifyGateEnabled,
	needsVerification,
	verifyNudgeFor,
} from "./verify-gate";

const ok = (name: string) => ({ name, success: true });
const failed = (name: string) => ({ name, success: false });
const ON = { EIGHT_VERIFY_GATE: "1" };

describe("verify gate flag", () => {
	test("off by default", () => {
		expect(isVerifyGateEnabled({})).toBe(false);
		expect(isVerifyGateEnabled({ EIGHT_VERIFY_GATE: "0" })).toBe(false);
		expect(verifyNudgeFor([ok("write_file")], {})).toBeNull();
	});
	test("on with 1 or true", () => {
		expect(isVerifyGateEnabled({ EIGHT_VERIFY_GATE: "1" })).toBe(true);
		expect(isVerifyGateEnabled({ EIGHT_VERIFY_GATE: " TRUE " })).toBe(true);
	});
});

describe("needsVerification", () => {
	test("write then finish needs a check", () => {
		expect(needsVerification([ok("write_file")])).toBe(true);
		expect(needsVerification([ok("read_file"), ok("edit_file")])).toBe(true);
		expect(verifyNudgeFor([ok("edit_file")], ON)).toBe(VERIFY_NUDGE_MESSAGE);
	});
	test("write then test does not", () => {
		expect(needsVerification([ok("write_file"), ok("run_command")])).toBe(false);
		expect(needsVerification([ok("edit_file"), ok("read_file")])).toBe(false);
		expect(needsVerification([ok("delete_file"), ok("git_diff")])).toBe(false);
	});
	test("read-only turn does not", () => {
		expect(needsVerification([])).toBe(false);
		expect(needsVerification([ok("read_file"), ok("list_files")])).toBe(false);
		expect(needsVerification([ok("run_command")])).toBe(false);
	});
	test("a check before the last change does not count", () => {
		expect(needsVerification([ok("write_file"), ok("run_command"), ok("edit_file")])).toBe(true);
	});
	test("failed writes and failed checks are ignored", () => {
		expect(needsVerification([failed("write_file")])).toBe(false);
		expect(needsVerification([ok("write_file"), failed("run_command")])).toBe(true);
	});
});
