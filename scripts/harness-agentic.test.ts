/**
 * The tool surface has to accept what a model actually writes.
 *
 * These cases are not invented. The first agentic run failed a task because
 * ornith-1.0-9b emitted
 *
 *   >grep -r "localhost\|127\.0\.0\.1" packages/eight/clients/*.ts | head -30
 *
 * which is correct grep by every convention it has ever been trained on. The
 * parser took the flags, the glob and the pipe as part of one regex, matched
 * nothing, and the run scored it as a model failure. It was a harness failure.
 *
 * A tool surface narrower than the model's habits measures the surface, not the
 * model - so these stay as tests rather than as a comment nobody runs.
 */
import { describe, expect, test } from "bun:test";
import { normalisePattern } from "./harness-agentic";

describe("normalisePattern", () => {
	test("the exact line that broke the first run", () => {
		expect(
			normalisePattern(String.raw`-r "localhost\|127\.0\.0\.1" packages/eight/clients/*.ts | head -30`),
		).toBe(String.raw`localhost\|127\.0\.0\.1`);
	});

	test("a bare identifier is left alone", () => {
		expect(normalisePattern("BOARD_CONTEXT_CAP")).toBe("BOARD_CONTEXT_CAP");
	});

	test("short flags are stripped", () => {
		expect(normalisePattern(`-n "CLAMP_MIN_MS"`)).toBe("CLAMP_MIN_MS");
		expect(normalisePattern(`-r -i 'anonymizeOutbound'`)).toBe("anonymizeOutbound");
	});

	test("long flags with values are stripped", () => {
		// This one shipped broken: the --flag=value form sailed through into the
		// regex and matched nothing.
		expect(normalisePattern(`--include=*.ts 'DEFAULT_TURN_TIMEOUT'`)).toBe("DEFAULT_TURN_TIMEOUT");
	});

	test("a trailing path or glob argument is dropped", () => {
		expect(normalisePattern("anonymizeOutbound packages/eight/clients/*.ts")).toBe("anonymizeOutbound");
	});

	test("a pipe into a pager or counter is dropped", () => {
		expect(normalisePattern("CLAMP_MIN_MS | wc -l")).toBe("CLAMP_MIN_MS");
		expect(normalisePattern("PROVIDER | head -5")).toBe("PROVIDER");
	});

	test("an alternation the model meant as regex survives", () => {
		// A bare pipe that is NOT feeding a shell tool is a regex alternation and
		// must be preserved, or every either/or search silently breaks.
		expect(normalisePattern("CLAMP_MIN_MS|CLAMP_MAX_MS")).toBe("CLAMP_MIN_MS|CLAMP_MAX_MS");
	});

	test("quoted patterns keep their internal spaces", () => {
		expect(normalisePattern(`"export function anonymize"`)).toBe("export function anonymize");
	});
});
