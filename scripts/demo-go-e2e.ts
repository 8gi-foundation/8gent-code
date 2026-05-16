/**
 * End-to-end /goal demo.
 *
 * Wires GoalLoop + EightExecutor + FailoverJudge to real local models, sets
 * a measurable goal, runs the loop, verifies the side effect.
 *
 * Bar: `/goal "create /tmp/eight-test.txt with content 'works'"` must close
 * the loop AND produce the file. Anything else is not shipped.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { GoalLoop, type GoalEvent } from "../packages/goal";
import { EightExecutor } from "../packages/goal/executor-eight";
import { FailoverJudge } from "../packages/goal/judge-failover";

const TARGET_PATH = "/tmp/eight-test.txt";
const TARGET_CONTENT = "works";
const GOAL_TEXT = `Create a file at exactly ${TARGET_PATH} containing only the word "${TARGET_CONTENT}" (no quotes, no newline). Use the Write tool.`;

const EXECUTOR_MODEL = "qwen3.6:27b";
const EXECUTOR_RUNTIME = "ollama" as const;
const JUDGE_MODEL = "google/gemma-4-26b-a4b";

async function main() {
	console.log("[demo] clearing prior target if present");
	if (existsSync(TARGET_PATH)) rmSync(TARGET_PATH);
	if (existsSync(TARGET_PATH)) throw new Error("could not clear prior target");

	console.log(`[demo] executor: ${EXECUTOR_MODEL} (${EXECUTOR_RUNTIME})`);
	console.log(`[demo] judge:    ${JUDGE_MODEL} (lmstudio via failover)`);
	console.log(`[demo] goal:     ${GOAL_TEXT}`);

	const executor = new EightExecutor({
		model: EXECUTOR_MODEL,
		runtime: EXECUTOR_RUNTIME,
		workingDirectory: "/tmp",
		maxStepsPerTurn: 10,
	});

	const judge = new FailoverJudge({
		executorModel: EXECUTOR_MODEL,
		judgeModel: JUDGE_MODEL,
		channel: "text",
		timeoutMs: 30_000,
	});

	const runId = `demo-${Date.now()}`;
	const events: GoalEvent[] = [];
	const sink = {
		append(e: GoalEvent) {
			events.push(e);
			const summary = e.kind === "turn.completed"
				? ` t=${(e as any).turnIndex}`
				: e.kind === "judge.verdict"
					? ` v=${(e as any).decision}`
					: "";
			console.log(`[event] ${e.kind}${summary}`);
		},
	};

	const loop = new GoalLoop({
		runId,
		sessionId: "demo-session",
		goal: GOAL_TEXT,
		budget: {
			turns: 5,
			wallclockMs: 600_000,
			filesChanged: 5,
			egressBytes: 1_000_000,
			maxDissentStreak: 3,
		},
		executor,
		judge,
		sink,
	});

	console.log("[demo] starting loop");
	const startedAt = Date.now();
	const receipt = await loop.run_();
	const elapsedMs = Date.now() - startedAt;

	console.log("\n========== RECEIPT ==========");
	console.log(JSON.stringify(receipt, null, 2));
	console.log("=============================\n");

	console.log(`[demo] elapsed: ${elapsedMs}ms across ${events.length} events`);

	console.log("\n========== SIDE EFFECT VERIFICATION ==========");
	if (!existsSync(TARGET_PATH)) {
		console.log(`FAIL: ${TARGET_PATH} does not exist`);
		process.exit(1);
	}
	const actual = readFileSync(TARGET_PATH, "utf8");
	console.log(`file exists: yes`);
	console.log(`content:     ${JSON.stringify(actual)}`);
	if (actual.trim() !== TARGET_CONTENT) {
		console.log(`FAIL: expected ${JSON.stringify(TARGET_CONTENT)}, got ${JSON.stringify(actual.trim())}`);
		process.exit(1);
	}
	console.log("PASS: file created with correct content");
	console.log("==============================================\n");

	console.log("[demo] /goal end-to-end VERIFIED");
	process.exit(0);
}

main().catch((err) => {
	console.error("[demo] FAILED:", err);
	process.exit(1);
});
