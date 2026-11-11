/**
 * #178: a message typed while no turn runs starts a turn; the steering line is
 * printed only while a turn really runs. Real App, scripted model. Each test
 * ends a turn a different way, then types a message into the idle app.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveScriptedModel, userTexts } from "./scripted-model.js";

const FAIL = { reply: "", failStatus: 500 };

async function run(scenario: string, steps: Parameters<typeof serveScriptedModel>[0], env = {}) {
	const model = serveScriptedModel(steps, ["m-a:1b", "m-b:1b"]);
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "idle-submit.harness.tsx"),
			{ ...model.env, IDLE_SCENARIO: scenario, ...env },
			120_000,
		);
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const idle = events.find((e) => e.phase === "idle-msg");
		return { idle, texts: userTexts(model.requests) };
	} finally {
		model.stop();
	}
}

const started = (texts: string[]) => texts.some((t) => t.includes("IDLE_MSG"));

test("after a turn ends in a provider error, the next message starts a turn", async () => {
	const { idle, texts } = await run("error", [FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]);
	expect(idle?.steeringLines).toBe(0);
	expect(started(texts)).toBe(true);
}, 150_000);

test("after a thrown turn (native tool path), the next message starts a turn", async () => {
	const { idle, texts } = await run("error", [FAIL, FAIL, FAIL, FAIL, FAIL, FAIL], {
		EIGHT_TEXT_TOOLS: "0",
	});
	expect(idle?.steeringLines).toBe(0);
	expect(started(texts)).toBe(true);
}, 150_000);

test("after an Esc abort, the next message starts a turn", async () => {
	const { idle, texts } = await run("abort", [{ reply: "SLOW", delayMs: 6000 }, { reply: "OK" }]);
	expect(idle?.steeringLines).toBe(0);
	expect(started(texts)).toBe(true);
}, 150_000);

test("after the tab's engine is rebuilt mid-turn, the next message starts a turn and the queued steer is not lost", async () => {
	const { idle, texts } = await run("rebuild", [
		{ reply: "SLOW", delayMs: 6000 },
		{ reply: "OK" },
		{ reply: "OK" },
	]);
	// One steering line is right: the steer typed during the first, running turn.
	expect(idle?.steeringLines).toBe(1);
	expect(started(texts)).toBe(true);
	// The steer typed during the first turn reaches the model with the next one.
	expect(texts.filter((t) => t.includes("STEER_KEPT")).length).toBeGreaterThan(0);
}, 150_000);
