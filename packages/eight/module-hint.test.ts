import { describe, expect, test } from "bun:test";
import { moduleHint } from "./module-hint";

const onPath =
	(...bins: string[]) =>
	(b: string) =>
		bins.includes(b) ? `/usr/bin/${b}` : null;
const err = "/usr/bin/python3: No module named pytest";

describe("moduleHint", () => {
	test("module missing, binary present: hint carries the args", () => {
		expect(moduleHint("python3 -m pytest forth_test.py", err, onPath("pytest"))).toBe(
			"hint: pytest is not installed for this python, but `pytest` is on PATH; run `pytest forth_test.py` as one command.",
		);
	});
	test("module missing, binary absent: no hint", () => {
		expect(moduleHint("python3 -m pytest x.py", err, onPath())).toBeNull();
	});
	test("unrelated stderr: no hint", () => {
		expect(moduleHint("python3 -m pytest x.py", "AssertionError", onPath("pytest"))).toBeNull();
	});
	test("pip resolves to pip3", () => {
		expect(moduleHint("python3 -m pip list", "No module named pip", onPath("pip3"))).toBe(
			"hint: pip is not installed for this python, but `pip3` is on PATH; run `pip3 list` as one command.",
		);
	});
});
