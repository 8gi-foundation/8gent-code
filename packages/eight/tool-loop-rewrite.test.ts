/**
 * #4537: a local model finished bowling.js correctly, then kept calling
 * write_file on it (36 tool calls, cosmetic changes, a check command between)
 * until the 1200 s turn timeout. The rewrite guard nudges, then stops the turn.
 */
import { describe, expect, test } from "bun:test";
import { ToolLoopDetector, writeLoopMaxFromEnv } from "./tool-loop-detector";

const w = (d: ToolLoopDetector, path: string, content: string) =>
	d.record("write_file", { path, content }, { succeeded: false });
const run = (d: ToolLoopDetector, cmd = "bun test") =>
	d.record("run_command", { command: cmd }, { succeeded: false });

describe("ToolLoopDetector: rewrite loop (#4537)", () => {
	test("identical content to the last write nudges and says the file is unchanged", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		w(d, "a.js", "x");
		run(d);
		w(d, "a.js", "x");
		const r = d.check();
		expect(r?.type).toBe("rewrite");
		expect(r?.recoverable).toBe(true);
		expect(r?.message).toContain("unchanged");
	});

	test("repeated identical rewrites with checks between end in a stop", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		let last = null;
		for (let i = 0; i < 6; i++) {
			w(d, "a.js", "x");
			last = d.check();
			if (last && !last.recoverable) break;
			run(d, `bun test ${i}`);
		}
		expect(last?.type).toBe("rewrite");
		expect(last?.recoverable).toBeUndefined();
		expect(last?.userMessage).toContain("a.js");
	});

	test("4 back-to-back writes to one path nudge, 6 stop", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		for (let i = 0; i < 3; i++) {
			w(d, "a.js", `v${i}`);
			expect(d.check()).toBeNull();
		}
		w(d, "a.js", "v3");
		expect(d.check()?.recoverable).toBe(true);
		w(d, "a.js", "v4");
		expect(d.check()?.recoverable).toBe(true);
		w(d, "a.js", "v5");
		const r = d.check();
		expect(r?.type).toBe("rewrite");
		expect(r?.recoverable).toBeUndefined();
	});

	test("the observed run: 8 distinct rewrites with a check between each stops the turn", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		const results: (boolean | undefined)[] = [];
		for (let i = 0; i < 10; i++) {
			w(d, "bowling.js", `// v${i}`);
			const r = d.check();
			results.push(r ? !r.recoverable : undefined);
			if (r && !r.recoverable) break;
			run(d, `bun test ./bowling.spec.js # ${i}`);
		}
		expect(results.at(-1)).toBe(true);
		expect(results.length).toBeLessThanOrEqual(10);
		expect(results.slice(0, 7).every((x) => x === undefined || x === false)).toBe(true);
	});

	test("normal edit, run, edit, run cadence does not trigger", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		for (let i = 0; i < 3; i++) {
			w(d, "a.js", `fix ${i}`);
			expect(d.check()).toBeNull();
			run(d, `bun test ${i}`);
			expect(d.check()).toBeNull();
		}
	});

	test("writing different files never trips it", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		for (let i = 0; i < 12; i++) {
			w(d, `f${i}.js`, "same");
			expect(d.check()).toBeNull();
		}
	});

	test("relative, ./ and absolute forms of one file share a counter", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4, workingDirectory: "/work" });
		const forms = ["bowling.js", "./bowling.js", "/work/bowling.js", "bowling.js"];
		forms.forEach((p, i) => {
			w(d, p, `v${i}`);
			if (i < 3) expect(d.check()).toBeNull();
		});
		expect(d.check()?.recoverable).toBe(true);
	});

	test("A,B alternation trips each file at N", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		for (let i = 0; i < 3; i++) {
			w(d, "a.js", `a${i}`);
			w(d, "b.js", `b${i}`);
			expect(d.check()).toBeNull();
		}
		w(d, "a.js", "a3");
		expect(d.check()?.recoverable).toBe(true);
		w(d, "b.js", "b3");
		expect(d.check()?.recoverable).toBe(true);
	});

	test("edit_file cadence between writes stays quiet", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		for (let i = 0; i < 6; i++) {
			w(d, "a.js", `v${i}`);
			expect(d.check()).toBeNull();
			d.record(
				"edit_file",
				{ path: "a.js", old_string: "x", new_string: "y" },
				{ succeeded: false },
			);
			run(d, `bun test ${i}`);
			expect(d.check()).toBeNull();
		}
	});

	test("reset() clears the streak between turns", () => {
		const d = new ToolLoopDetector({ writeLoopMax: 4 });
		for (let i = 0; i < 3; i++) w(d, "a.js", `v${i}`);
		d.reset();
		w(d, "a.js", "v3");
		expect(d.check()).toBeNull();
	});

	test("EIGHT_WRITE_LOOP_MAX: default 4, override honoured, junk ignored", () => {
		expect(writeLoopMaxFromEnv({})).toBe(4);
		expect(writeLoopMaxFromEnv({ EIGHT_WRITE_LOOP_MAX: "6" })).toBe(6);
		expect(writeLoopMaxFromEnv({ EIGHT_WRITE_LOOP_MAX: "abc" })).toBe(4);
		expect(writeLoopMaxFromEnv({ EIGHT_WRITE_LOOP_MAX: "0" })).toBe(4);
	});
});
