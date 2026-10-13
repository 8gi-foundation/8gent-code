import { describe, expect, test } from "bun:test";
import { describeScope, nextModel, resolveScope } from "./scoped-models.js";

const AVAILABLE = ["qwen3:14b", "qwen3.5:latest", "devstral:latest", "eight-1.0-q3:14b"];

describe("/scoped-models (#3918 D3)", () => {
	test("exact ids and substrings build the scope in the order given", () => {
		const r = resolveScope(["devstral:latest", "qwen3"], AVAILABLE);
		expect(r.scope).toEqual(["devstral:latest", "qwen3:14b", "qwen3.5:latest"]);
		expect(r.unknown).toEqual([]);
	});

	test("an argument matching nothing is reported, the rest still apply", () => {
		const r = resolveScope(["nope", "eight"], AVAILABLE);
		expect(r.scope).toEqual(["eight-1.0-q3:14b"]);
		expect(r.unknown).toEqual(["nope"]);
	});

	test("clear empties the scope", () => {
		expect(resolveScope(["clear"], AVAILABLE)).toEqual({ scope: [], unknown: [] });
		expect(resolveScope(["qwen3", "all"], AVAILABLE).scope).toEqual([]);
	});

	test("the cycle wraps and starts at the first model when the current is not scoped", () => {
		expect(nextModel(["a", "b", "c"], "b")).toBe("c");
		expect(nextModel(["a", "b", "c"], "c")).toBe("a");
		expect(nextModel(["a", "b", "c"], "zzz")).toBe("a");
		expect(nextModel([], "a")).toBeNull();
	});

	test("the description names the scope or says there is none", () => {
		expect(describeScope([], AVAILABLE)).toContain("cycles all 4 listed models");
		expect(describeScope(["a", "b"], AVAILABLE)).toContain("  a\n  b");
	});
});
