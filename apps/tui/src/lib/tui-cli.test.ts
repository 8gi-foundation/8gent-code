import { describe, expect, test } from "bun:test";
import { durableDefault, parseTuiArgv } from "./tui-cli.js";

describe("--resume (#3918 E3)", () => {
	test("--resume <id> and --resume=<id> name the session", () => {
		expect(parseTuiArgv(["--resume", "abc123"]).sessionResume).toBe("abc123");
		expect(parseTuiArgv(["--resume=abc123"]).sessionResume).toBe("abc123");
	});

	test("a bare --resume asks for the picker: an empty id, not none", () => {
		expect(parseTuiArgv(["--resume"]).sessionResume).toBe("");
		expect(parseTuiArgv(["--resume", "--provider=ollama"]).sessionResume).toBe("");
		expect(parseTuiArgv([]).sessionResume).toBeUndefined();
	});
});

describe("--durable (docs/specs/DURABLE-TURNS.md)", () => {
	test("turns durable turns on and is not a positional", () => {
		const p = parseTuiArgv(["--durable", "--resume=abc123"]);
		expect(p.durable).toBe(true);
		expect(p.sessionResume).toBe("abc123");
		expect(p.positional).toEqual([]);
		expect(parseTuiArgv([]).durable).toBeUndefined();
	});
});

describe("durable default (slice 2, Pi Durable parity)", () => {
	test("on in the TUI unless --no-durable or EIGHT_DURABLE=0; the flag wins", () => {
		expect(parseTuiArgv(["--no-durable"]).durable).toBe(false);
		expect(durableDefault(undefined, undefined)).toBe(true);
		expect(durableDefault(undefined, "0")).toBe(false);
		expect(durableDefault(false, undefined)).toBe(false);
		expect(durableDefault(true, "0")).toBe(true);
	});
});
