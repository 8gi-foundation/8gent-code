import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionWriter } from "./writer.js";

let tmp: string | undefined;
afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

function setup() {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sw-step-"));
	const clock = { now: 1_000_000 };
	const w = new SessionWriter("step-test", tmp, () => clock.now);
	const read = () =>
		fs
			.readFileSync(path.join(tmp as string, "step-test.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
	return { w, read, clock };
}

describe("step_start / step_end timing (#3910)", () => {
	test("step_start has the right shape and only provider and model", () => {
		const { w, read } = setup();
		w.writeStepStart(0, { provider: "ollama", modelId: "qwen3:14b" });
		const start = read().find((e) => e.type === "step_start");
		expect(start.stepNumber).toBe(0);
		expect(start.model).toEqual({ provider: "ollama", modelId: "qwen3:14b" });
		expect(Object.keys(start).sort()).toEqual(
			["model", "sequenceNumber", "stepNumber", "timestamp", "type"].sort(),
		);
	});

	test("start precedes end and durationMs equals end minus start", () => {
		const { w, read, clock } = setup();
		w.writeStepStart(3, { provider: "ollama", modelId: "m" });
		clock.now += 1234;
		w.writeStepEnd(3, "stop");
		const entries = read().filter((e) => e.type === "step_start" || e.type === "step_end");
		const [s, e] = entries;
		expect(s.type).toBe("step_start");
		expect(e.type).toBe("step_end");
		expect(s.sequenceNumber).toBeLessThan(e.sequenceNumber);
		expect(Date.parse(s.timestamp)).toBeLessThanOrEqual(Date.parse(e.timestamp));
		expect(e.durationMs).toBe(Date.parse(e.timestamp) - Date.parse(s.timestamp));
		expect(e.durationMs).toBe(1234);
	});

	test("step_end without a matching start omits durationMs", () => {
		const { w, read } = setup();
		w.writeStepEnd(9, "stop");
		const e = read().find((x) => x.type === "step_end");
		expect(e.durationMs).toBeUndefined();
	});

	test("secret-looking prompt text never reaches the new fields", () => {
		const secret = "sk-live-SECRET-abc123 password=hunter2";
		const { w, read } = setup();
		w.writeUserMessage(secret); // lives only in the user_message entry
		w.writeStepStart(0, { provider: "openrouter", modelId: "anthropic/x" });
		w.writeStepEnd(0, "stop");
		for (const e of read().filter((x) => x.type === "step_start" || x.type === "step_end")) {
			expect(JSON.stringify(e)).not.toContain("SECRET");
			expect(JSON.stringify(e)).not.toContain("hunter2");
		}
	});
});
