/**
 * D1 steering and D10 thinking display in the real App (#3918). The model is
 * scripted and slow, so the keys are pressed while a turn really runs. The
 * frames the harness captured are written as an asciicast under $TMPDIR.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { type Frame, castPath, writeCast } from "./cast.js";
import { serveScriptedModel, userTexts } from "./scripted-model.js";

const TOOL_CALL = [
	"Reading the colours file first.",
	"```tool_call",
	'{"name": "read_file", "arguments": {"path": "PRIMARY_COLORS.md"}}',
	"```",
].join("\n");

test("Enter steers the running turn, Ctrl+Q and Alt+Enter queue, Esc hands queued text back", async () => {
	const model = serveScriptedModel([
		// Turn 1: a tool call held open, the reply after the tool result (the
		// loop always sends one completion check after tool work), the answer.
		{ reply: TOOL_CALL, delayMs: 3500 },
		{ reply: "The file is read." },
		{ reply: "DONE: FIRST_DONE, the colours file is read." },
		// Turn 2: the Ctrl+Q follow-up.
		{ reply: "FOLLOWUP_DONE" },
		// Turn 3: held open with no tool call, then stopped with Esc.
		{ reply: "SECOND_DONE never shown", delayMs: 4000 },
		{ reply: "UNEXPECTED_TURN" },
	]);
	const TURN1_TOOL = 0;
	const TURN1_AFTER_TOOL = 1;
	const TURN2_FOLLOW_UP = 3;
	const TURN3_STOPPED = 4;
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "steer.harness.tsx"),
			model.env,
			120_000,
		);
		const frames = (events.find((e) => e.phase === "frames")?.frames ?? []) as Frame[];
		const cast = castPath("pi-tui-d1-steer");
		writeCast(
			cast,
			frames,
			160,
			44,
			"8gent Code: D1 steering, follow-up queue, Esc restore, D10 thinking toggle",
		);
		console.log(`[steer.test] ${frames.length} frames -> ${cast}`);

		console.log(
			`[steer.test] model saw: ${JSON.stringify(model.requests.map((r) => userTexts([r]).at(-1)?.slice(0, 60)))}`,
		);
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		expect(frames.length).toBeGreaterThan(0);
		expect(events.find((e) => e.phase === "steer")?.ok).toBeTrue();
		expect(events.find((e) => e.phase === "followup")?.ok).toBeTrue();

		// Turn 1 was two model calls: the tool call, then the answer. The steer
		// is in the second, as the last user message, after the tool result.
		expect(model.requests.length).toBe(TURN3_STOPPED + 1);
		const first = userTexts([model.requests[TURN1_TOOL]]);
		expect(first.some((t) => t.includes("STEER_NOW"))).toBeFalse();
		const second = userTexts([model.requests[TURN1_AFTER_TOOL]]);
		const steerAt = second.findIndex((t) => t.includes("STEER_NOW"));
		const resultAt = second.findIndex((t) => t.includes("Primary Colors"));
		expect(resultAt).toBeGreaterThanOrEqual(0);
		expect(steerAt).toBe(second.length - 1);
		expect(steerAt).toBeGreaterThan(resultAt);
		// The Ctrl+Q follow-up went as its own turn, after turn 1 finished.
		const followUp = userTexts([model.requests[TURN2_FOLLOW_UP]]);
		expect(followUp[followUp.length - 1]).toContain("FOLLOW_UP_LATER");
		const stopped = userTexts([model.requests[TURN3_STOPPED]]);
		expect(stopped[stopped.length - 1]).toContain("second task");
		const screen = String(events.find((e) => e.phase === "turns")?.screen ?? "");
		expect(screen.indexOf("FIRST_DONE")).toBeLessThan(screen.indexOf("FOLLOWUP_DONE"));

		// D10: Ctrl+V hides, then shows, the thinking display.
		expect(events.find((e) => e.phase === "thinking-toggle")?.ok).toBeTrue();

		// Esc: both messages came back to the input; nothing was sent after.
		const esc = events.find((e) => e.phase === "esc");
		expect(esc?.restoredFirst).toBeTrue();
		expect(esc?.restoredSecond).toBeTrue();
		expect(model.requests.length).toBe(TURN3_STOPPED + 1);
		const afterEsc = String(events.find((e) => e.phase === "after-esc")?.screen ?? "");
		expect(afterEsc).not.toContain("UNEXPECTED_TURN");
		expect(afterEsc).not.toContain("SECOND_DONE");
	} finally {
		model.stop();
	}
}, 150_000);
