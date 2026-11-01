/**
 * Fixture for goal-survives-no-tts.test.ts. Runs a goal to completion with a
 * stub model, speaks the verdict the way the TUI does, then proves the process
 * is still alive and exits 0. Run as its own process so an unhandled 'error'
 * event (the #4721 crash) shows up as a non-zero exit.
 */
import { speakVerdict } from "../../apps/tui/src/components/LiveFocalStrip";
import { GoalLoop } from "./goal-loop";
import type { ExecutorHandle, GoalEvent, JudgeHandle } from "./types";

const executor: ExecutorHandle = {
	model: "stub-executor",
	async turn() {
		return { summary: "wrote notes.txt, 3 lines", tokensIn: 10, tokensOut: 10, toolResults: 2 };
	},
	abort() {},
};
const judge: JudgeHandle = {
	model: "stub-judge",
	async score() {
		return { decision: "satisfied", confidence: 0.95, summary: "done" } as never;
	},
};
const events: GoalEvent[] = [];
const receipt = await new GoalLoop({
	runId: "r1",
	sessionId: "s1",
	goal: "write a 3 line notes.txt and wc it",
	executor,
	judge,
	sink: { append: (e: GoalEvent) => void events.push(e) },
}).run_();

await speakVerdict("Done. Goal met at turn 1.");
// Give any async ENOENT 'error' event time to arrive and kill the process.
await new Promise((r) => setTimeout(r, 400));
console.log(`ALIVE status=${receipt.status}`);
