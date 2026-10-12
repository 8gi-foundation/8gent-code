import { describe, expect, test } from "bun:test";
import { parseTuiArgv } from "./tui-cli.js";

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
