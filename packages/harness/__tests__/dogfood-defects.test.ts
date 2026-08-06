/**
 * Regression tests for the meta-harness dogfood defects (#2803, #2804, #2805).
 *
 * #2803: an empty/blank prompt must never reach the underlying engine at all.
 *        The observed failure was the local model hallucinating a user "fact"
 *        from an empty prompt and permanently writing it to the REAL global
 *        memory store (~/.8gent/memory/memory.db). Two layers guard this now:
 *        LocalHarness.run rejects degenerate prompts before creating an engine,
 *        and HarnessRunner.start refuses to mint a task for them. A third
 *        guard (assertIsolatedDataDir) makes the default REAL-Agent factory
 *        refuse to run under a test/dogfood environment unless EIGHT_DATA_DIR
 *        points at an isolated store outside the global ~/.8gent.
 *
 * #2804: an unparsed/unexecuted `tool_call` protocol block must never leak
 *        verbatim into a `done` StatusEvent's output. Protocol-only output is
 *        a failed turn -> state "error".
 *
 * #2805: real token usage flows through onStepFinish (endpoint-side test lives
 *        in packages/ai/text-tool-endpoint.test.ts); the bridge is covered by
 *        local.test.ts. Here we only pin that nothing fabricates tokens.
 */

import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { StatusEvent } from "../index";
import { HarnessRunner } from "../runner";
import { LocalHarness, assertIsolatedDataDir } from "../local";
import { sanitizeFinalOutput } from "../sanitize";

async function collect(iter: AsyncIterable<StatusEvent>): Promise<StatusEvent[]> {
	const out: StatusEvent[] = [];
	for await (const e of iter) out.push(e);
	return out;
}

describe("#2803 empty prompt guard", () => {
	it("LocalHarness.run rejects an empty prompt without ever creating an engine", async () => {
		let engineCreated = false;
		const harness = new LocalHarness({
			createEngine: () => {
				engineCreated = true;
				return { chat: async () => "should never run" };
			},
		});
		const events = await collect(harness.run({ id: "e1", prompt: "" }));

		expect(engineCreated).toBe(false);
		expect(events.length).toBe(1);
		expect(events[0]?.state).toBe("error");
		expect(events[0]?.output).toContain("prompt");
		expect(events.some((e) => e.state === "done")).toBe(false);
	});

	it("LocalHarness.run rejects a whitespace-only prompt the same way", async () => {
		let engineCreated = false;
		const harness = new LocalHarness({
			createEngine: () => {
				engineCreated = true;
				return { chat: async () => "nope" };
			},
		});
		const events = await collect(harness.run({ id: "e2", prompt: "  \n\t " }));

		expect(engineCreated).toBe(false);
		expect(events.length).toBe(1);
		expect(events[0]?.state).toBe("error");
	});

	it("HarnessRunner.start throws on an empty prompt instead of minting a task", () => {
		const runner = new HarnessRunner();
		expect(() => runner.start({ prompt: "" })).toThrow(/prompt/i);
		expect(() => runner.start({ prompt: "   " })).toThrow(/prompt/i);
		expect(runner.allEvents().length).toBe(0);
	});
});

describe("#2803 isolated data dir guard (never the real global store under test/dogfood)", () => {
	const globalDir = path.join(os.homedir(), ".8gent");

	it("throws under a test env when EIGHT_DATA_DIR is unset (would hit ~/.8gent)", () => {
		expect(() => assertIsolatedDataDir({ NODE_ENV: "test" })).toThrow(/EIGHT_DATA_DIR/);
	});

	it("throws under a test env when EIGHT_DATA_DIR points at the real global store", () => {
		expect(() =>
			assertIsolatedDataDir({ NODE_ENV: "test", EIGHT_DATA_DIR: globalDir }),
		).toThrow(/isolat/i);
		expect(() =>
			assertIsolatedDataDir({
				NODE_ENV: "test",
				EIGHT_DATA_DIR: path.join(globalDir, "memory"),
			}),
		).toThrow(/isolat/i);
	});

	it("throws under an explicit dogfood env without isolation", () => {
		expect(() => assertIsolatedDataDir({ EIGHT_HARNESS_DOGFOOD: "1" })).toThrow(
			/EIGHT_DATA_DIR/,
		);
	});

	it("passes under a test env when EIGHT_DATA_DIR is an isolated temp dir", () => {
		const tmp = path.join(os.tmpdir(), "8gent-harness-isolated");
		expect(() =>
			assertIsolatedDataDir({ NODE_ENV: "test", EIGHT_DATA_DIR: tmp }),
		).not.toThrow();
	});

	it("is a no-op outside test/dogfood runs (production keeps the real store)", () => {
		expect(() => assertIsolatedDataDir({})).not.toThrow();
		expect(() => assertIsolatedDataDir({ NODE_ENV: "production" })).not.toThrow();
	});
});

describe("#2804 unexecuted tool_call protocol must not leak into done output", () => {
	const leakedVariant = '```\ntool_call\n{"name": "say", "arguments": {"text": "TWO"}}\n```';
	const canonicalVariant = '```tool_call\n{"name": "say", "arguments": {"text": "TWO"}}\n```';

	it("sanitizeFinalOutput strips the exact leaked fenced variant (tool_call on its own line)", () => {
		const result = sanitizeFinalOutput(leakedVariant);
		expect(result.text).toBe("");
		expect(result.strippedToolCall).toBe(true);
	});

	it("sanitizeFinalOutput strips the canonical ```tool_call fenced variant", () => {
		const result = sanitizeFinalOutput(canonicalVariant);
		expect(result.text).toBe("");
		expect(result.strippedToolCall).toBe(true);
	});

	it("sanitizeFinalOutput strips a bare tool_call line + JSON object", () => {
		const result = sanitizeFinalOutput('tool_call\n{"name": "recall", "arguments": {}}');
		expect(result.text).toBe("");
		expect(result.strippedToolCall).toBe(true);
	});

	it("sanitizeFinalOutput keeps surrounding prose and strips only the block", () => {
		const result = sanitizeFinalOutput(`Here is the answer: TWO\n${canonicalVariant}`);
		expect(result.text).toBe("Here is the answer: TWO");
		expect(result.strippedToolCall).toBe(true);
	});

	it("sanitizeFinalOutput leaves ordinary code blocks and prose alone", () => {
		const prose = 'The answer is TWO.\n```js\nconsole.log("TWO");\n```';
		const result = sanitizeFinalOutput(prose);
		expect(result.text).toBe(prose);
		expect(result.strippedToolCall).toBe(false);
	});

	it("LocalHarness ends in error (not done) when the whole answer is an unexecuted tool_call block", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({ chat: async () => leakedVariant }),
		});
		const events = await collect(harness.run({ id: "l1", prompt: "say two" }));
		const last = events[events.length - 1];
		expect(last?.state).toBe("error");
		expect(events.some((e) => e.state === "done")).toBe(false);
		expect(last?.output).toContain("tool_call");
	});

	it("LocalHarness strips a trailing tool_call block but keeps a real prose answer as done", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({
				chat: async () => `TWO\n${canonicalVariant}`,
			}),
		});
		const events = await collect(harness.run({ id: "l2", prompt: "say two" }));
		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toBe("TWO");
	});

	it("LocalHarness never emits raw fenced tool_call protocol on a done event", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({ chat: async () => canonicalVariant }),
		});
		const events = await collect(harness.run({ id: "l3", prompt: "go" }));
		for (const e of events) {
			if (e.state === "done") {
				expect(e.output ?? "").not.toContain("```tool_call");
			}
		}
	});
});
