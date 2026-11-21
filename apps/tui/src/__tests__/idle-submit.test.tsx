/**
 * #178: a message typed while no turn runs starts a turn; the steering line is
 * printed only while a turn really runs, and it leaves the screen when that
 * turn ends or the model has answered after it. Real App, scripted model. Each
 * test ends a turn a different way, then types a message into the idle app.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { STEERING_LINE, liveSteerLines } from "../lib/steer-line.js";
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

const steerLine = { id: "system-3", role: "system", content: STEERING_LINE };
const asked = { id: "user-1", role: "user", content: "read the file" };
const steer = { id: "user-2", role: "user", content: "also count the lines" };
const answer = { id: "assistant-4", role: "assistant", content: "12 lines." };

test("the steering line shows while the turn it steers is running", () => {
	expect(liveSteerLines([asked, steer, steerLine], true)).toEqual([asked, steer, steerLine]);
});

test("the steering line leaves the screen when no turn runs; the steer itself stays", () => {
	expect(liveSteerLines([asked, steer, steerLine], false)).toEqual([asked, steer]);
});

test("the steering line leaves once the model has answered after it, even in a later turn", () => {
	const later = { id: "user-5", role: "user", content: "next" };
	expect(liveSteerLines([asked, steer, steerLine, answer, later], true)).toEqual([
		asked,
		steer,
		answer,
		later,
	]);
});

test("other system lines are never hidden", () => {
	const queued = {
		id: "system-6",
		role: "system",
		content: "Queued. It sends when the current task finishes.",
	};
	expect(liveSteerLines([asked, queued], false)).toEqual([asked, queued]);
});

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
	// The steer typed during the first, running turn printed its line then (the
	// harness waits for it). That turn is over, so the line is gone.
	expect(idle?.steeringLines).toBe(0);
	expect(started(texts)).toBe(true);
	// The steer typed during the first turn reaches the model with the next one.
	expect(texts.filter((t) => t.includes("STEER_KEPT")).length).toBeGreaterThan(0);
}, 150_000);
