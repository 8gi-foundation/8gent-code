import { describe, expect, test } from "bun:test";
import { parseMarkers } from "../marker";

describe("parseMarkers", () => {
	test("parses a well-formed claim with id, src, args and expect", () => {
		const { claims } = parseMarkers(
			"HEAD is [[CLAIM id=c1 src=git.head repo=~/8gent-code expect=abc123]] today.",
		);
		expect(claims).toHaveLength(1);
		expect(claims[0].id).toBe("c1");
		expect(claims[0].src).toBe("git.head");
		expect(claims[0].args).toEqual({ repo: "~/8gent-code" });
		expect(claims[0].expect).toBe("abc123");
	});

	test("assigns ids when the officer omits them", () => {
		const { claims } = parseMarkers(
			"[[CLAIM src=file.lines path=a.ts]] and [[CLAIM src=file.lines path=b.ts]]",
		);
		expect(claims.map((c) => c.id)).toEqual(["c1", "c2"]);
	});

	test("auto ids never collide with officer-chosen ids", () => {
		// The un-id'd marker comes FIRST but must not take c2, which the
		// officer chose for the second marker. Caught live in the demo:
		// the collision silently rebound a derivation input.
		const { claims } = parseMarkers(
			"[[CLAIM src=git.branch repo=~/x]] [[CLAIM id=c2 src=file.lines path=a.ts]] [[CLAIM id=c1 src=file.lines path=b.ts]]",
		);
		expect(claims.map((c) => c.id)).toEqual(["c3", "c2", "c1"]);
	});

	test("salvages a truncated marker (model never wrote ]])", () => {
		const { claims } = parseMarkers("count: [[CLAIM src=git.count repo=~/x range=main..HEAD");
		expect(claims).toHaveLength(1);
		expect(claims[0].args.range).toBe("main..HEAD");
	});

	test("strips an early-closed bracket from a value", () => {
		const { claims } = parseMarkers("[[CLAIM src=file.lines path=a.ts]]]");
		expect(claims[0].args.path).toBe("a.ts");
	});

	test("a marker with no src parses with src empty (stripped later, not lost)", () => {
		const { claims } = parseMarkers("[[CLAIM path=a.ts]]");
		expect(claims).toHaveLength(1);
		expect(claims[0].src).toBe("");
	});

	test("parses derivations with input ids", () => {
		const { derivations } = parseMarkers("[[DERIVE id=d1 op=ratio of=c1,c2 expect=0.5]]");
		expect(derivations).toHaveLength(1);
		expect(derivations[0].op).toBe("ratio");
		expect(derivations[0].of).toEqual(["c1", "c2"]);
		expect(derivations[0].expect).toBe("0.5");
	});

	test("plain prose yields no markers", () => {
		const parsed = parseMarkers("no markers here, just words and [[not a marker]]");
		expect(parsed.claims).toHaveLength(0);
		expect(parsed.derivations).toHaveLength(0);
	});
});
