/**
 * Day-3 judge eval gate runner.
 *
 * Loads `eval/go-task-set-v1.jsonl`, runs each task through the GoalLoop
 * with EightExecutor + FailoverJudge against real local models, records
 * the full receipt + per-turn judge verdicts + final side-effect
 * verification (the task's deterministic `verification.check` command).
 *
 * Output:
 *   eval/results/<DATE>-day3-run.jsonl     one row per task
 *   eval/results/<DATE>-day3-summary.md    aggregate
 *
 * Hard rules from brief:
 *   - Real models only. No mocking.
 *   - >5min per-task budget on qwen, else switch to faster model with the
 *     run flagged "degraded".
 *   - Total wall-clock <= 90 min. Cap remaining tasks with note if hit.
 *   - Skip fixture-dependent tasks if /tmp/eval-fixtures/ is missing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { GoalLoop, type GoalEvent } from "../packages/goal";
import { EightExecutor } from "../packages/goal/executor-eight";
import { FailoverJudge } from "../packages/goal/judge-failover";
import { LMStudioClient } from "../packages/eight/clients/lmstudio";

// ----- config ----------------------------------------------------------------

const TASK_SET_PATH = "eval/go-task-set-v1.jsonl";
const RESULTS_DIR = "eval/results";
const RUN_DATE = "2026-05-16";
const RUN_JSONL = join(RESULTS_DIR, `${RUN_DATE}-day3-run.jsonl`);
const SUMMARY_MD = join(RESULTS_DIR, `${RUN_DATE}-day3-summary.md`);

const EXECUTOR_MODEL_PRIMARY = "qwen3.6:27b";
const EXECUTOR_MODEL_FALLBACK = "qwen3:14b"; // not currently pulled - will surface in summary
const EXECUTOR_RUNTIME = "ollama" as const;
const JUDGE_MODEL = "google/gemma-4-26b-a4b";

// Global wall-clock cap: 90 minutes total.
const TOTAL_BUDGET_MS = 90 * 60 * 1000;
// Per-task escalation: if a task exceeds 5 min on primary, mark degraded and
// switch the rest of the run to the fallback model.
const PER_TASK_DEGRADE_THRESHOLD_MS = 5 * 60 * 1000;

const FIXTURES_DIR = "/tmp/eval-fixtures";

// ----- task type -------------------------------------------------------------

interface Task {
	id: string;
	goal: string;
	category: string;
	expected_outcome: string;
	verification: { method: string; check: string };
	budget_hint?: { maxTurns?: number; maxWallclockMs?: number };
	difficulty?: string;
	local_only_target?: boolean;
	notes?: string;
}

interface TaskResult {
	taskId: string;
	category: string;
	difficulty?: string;
	goal?: string;
	skipped: boolean;
	skipReason?: string;
	degraded: boolean;
	executorModel: string;
	judgeModel: string;
	durationMs: number;
	receipt?: any;
	verification?: { passed: boolean; exitCode: number; stdout: string; stderr: string };
	turnVerdicts: Array<{
		turn: number;
		summary: string;
		decision: string;
		confidence: number;
		judgeSummary: string;
	}>;
	totalTokens: number;
	error?: string;
}

// ----- helpers ---------------------------------------------------------------

function loadTasks(): Task[] {
	const raw = readFileSync(TASK_SET_PATH, "utf8");
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Task);
}

function hasFixtureDependency(task: Task): boolean {
	const haystack = `${task.goal}\n${task.expected_outcome}\n${task.verification.check}`;
	return haystack.includes("eval-fixtures") || haystack.includes(FIXTURES_DIR);
}

/**
 * Tasks that touch the real user-owned filesystem (~/Downloads, ~/Documents,
 * ~/Desktop, ~/8gent-code-go-evals/packages). Running an autonomous agent on
 * real user data is destructive and not the scope of a judge-eval gate. We
 * skip these with a clear reason rather than risk irreversible damage to
 * James's machine.
 */
const DESTRUCTIVE_USER_DIRS = [
	"~/Downloads",
	"~/Documents",
	"~/Desktop",
	"~/Pictures",
	"~/8gent-code-go-evals",
];
function touchesUserDir(task: Task): string | null {
	const blob = `${task.goal}\n${task.expected_outcome}`;
	for (const d of DESTRUCTIVE_USER_DIRS) {
		if (blob.includes(d)) return d;
	}
	return null;
}

function verifyTask(task: Task): { passed: boolean; exitCode: number; stdout: string; stderr: string } {
	try {
		const stdout = execSync(task.verification.check, {
			encoding: "utf8",
			shell: "/bin/bash",
			timeout: 30_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { passed: true, exitCode: 0, stdout: stdout.slice(0, 2000), stderr: "" };
	} catch (err: any) {
		return {
			passed: false,
			exitCode: err.status ?? -1,
			stdout: String(err.stdout ?? "").slice(0, 2000),
			stderr: String(err.stderr ?? err.message ?? "").slice(0, 2000),
		};
	}
}

async function runTask(
	task: Task,
	executorModel: string,
	degraded: boolean,
): Promise<TaskResult> {
	const startedAt = Date.now();
	const turnVerdicts: TaskResult["turnVerdicts"] = [];
	const events: GoalEvent[] = [];
	let lastTurnSummary = "";

	const executor = new EightExecutor({
		model: executorModel,
		runtime: EXECUTOR_RUNTIME,
		workingDirectory: "/tmp",
		maxStepsPerTurn: 10,
	});

	// Inject an lmstudio client factory directly. The default FailoverJudge
	// resolves the judge model through ModelFailover, but there is no
	// registered chain for gemma-4-26b-a4b so it falls through to OpenRouter
	// and fails open without an API key. Force the judge to call lmstudio
	// directly. Anti-collusion still holds (different model than executor).
	const judge = new FailoverJudge({
		executorModel: executorModel,
		judgeModel: JUDGE_MODEL,
		channel: "text",
		timeoutMs: 30_000,
		clientFactory: () => new LMStudioClient(JUDGE_MODEL),
	});

	const sink = {
		append(e: GoalEvent) {
			events.push(e);
			if (e.kind === "turn.completed") {
				const p = (e as any).payload ?? {};
				lastTurnSummary = p.summary ?? "";
			}
			if (e.kind === "judge.verdict") {
				const p = (e as any).payload ?? {};
				turnVerdicts.push({
					turn: p.turn ?? turnVerdicts.length + 1,
					summary: lastTurnSummary,
					decision: p.decision ?? "",
					confidence: p.confidence ?? 0,
					judgeSummary: p.summary ?? "",
				});
			}
		},
	};

	const runId = `eval-${task.id}-${Date.now()}`;

	// Use the task's budget hint, capped to keep us under total budget.
	// Per-task cap is hardened to 8 minutes so we can fit all fixture-free
	// tasks under the 90-minute global cap. Tasks that need more time are
	// reported with `error: budget_wallclock` in the receipt.
	const turns = Math.min(task.budget_hint?.maxTurns ?? 12, 8);
	const wallclockMs = Math.min(task.budget_hint?.maxWallclockMs ?? 480_000, 480_000);

	const loop = new GoalLoop({
		runId,
		sessionId: `eval-day3`,
		goal: task.goal,
		budget: {
			turns,
			wallclockMs,
			filesChanged: 50,
			egressBytes: 25 * 1024 * 1024,
			maxDissentStreak: 8,
		},
		executor,
		judge,
		sink,
	});

	let receipt: any;
	let error: string | undefined;
	try {
		receipt = await loop.run_();
	} catch (e: any) {
		error = String(e?.message ?? e);
	}
	const durationMs = Date.now() - startedAt;

	// Side-effect verification regardless of loop outcome.
	const verification = verifyTask(task);

	return {
		taskId: task.id,
		category: task.category,
		difficulty: task.difficulty,
		goal: task.goal,
		skipped: false,
		degraded,
		executorModel,
		judgeModel: JUDGE_MODEL,
		durationMs,
		receipt,
		verification,
		turnVerdicts,
		totalTokens: receipt?.totalTokens ?? 0,
		error,
	};
}

// ----- main ------------------------------------------------------------------

async function main() {
	mkdirSync(RESULTS_DIR, { recursive: true });
	// Truncate output files.
	writeFileSync(RUN_JSONL, "");

	const tasks = loadTasks();
	const fixturesExist = existsSync(FIXTURES_DIR);
	console.log(`[eval] loaded ${tasks.length} tasks. fixtures exist: ${fixturesExist}`);
	console.log(`[eval] executor primary: ${EXECUTOR_MODEL_PRIMARY} (${EXECUTOR_RUNTIME})`);
	console.log(`[eval] judge: ${JUDGE_MODEL} (lmstudio via failover)`);

	const results: TaskResult[] = [];
	const overallStart = Date.now();
	let currentExecutor = EXECUTOR_MODEL_PRIMARY;
	let degraded = false;

	for (const task of tasks) {
		const elapsed = Date.now() - overallStart;
		if (elapsed > TOTAL_BUDGET_MS) {
			console.log(`[eval] global budget exceeded (${(elapsed / 60000).toFixed(1)}min). Capping remaining tasks.`);
			results.push({
				taskId: task.id,
				category: task.category,
				difficulty: task.difficulty,
				skipped: true,
				skipReason: "global_budget_exceeded",
				degraded,
				executorModel: currentExecutor,
				judgeModel: JUDGE_MODEL,
				durationMs: 0,
				turnVerdicts: [],
				totalTokens: 0,
			});
			appendFileSync(RUN_JSONL, JSON.stringify(results[results.length - 1]) + "\n");
			continue;
		}

		const userDir = touchesUserDir(task);
		if (userDir) {
			console.log(`[eval] SKIP ${task.id} (touches user dir ${userDir} - destructive)`);
			const skipped: TaskResult = {
				taskId: task.id,
				category: task.category,
				difficulty: task.difficulty,
				goal: task.goal,
				skipped: true,
				skipReason: `touches_user_dir:${userDir}`,
				degraded: false,
				executorModel: currentExecutor,
				judgeModel: JUDGE_MODEL,
				durationMs: 0,
				turnVerdicts: [],
				totalTokens: 0,
			};
			results.push(skipped);
			appendFileSync(RUN_JSONL, JSON.stringify(skipped) + "\n");
			continue;
		}

		if (hasFixtureDependency(task) && !fixturesExist) {
			console.log(`[eval] SKIP ${task.id} (fixture-dependent, no ${FIXTURES_DIR})`);
			const skipped: TaskResult = {
				taskId: task.id,
				category: task.category,
				difficulty: task.difficulty,
				skipped: true,
				skipReason: "fixtures_missing",
				degraded: false,
				executorModel: currentExecutor,
				judgeModel: JUDGE_MODEL,
				durationMs: 0,
				turnVerdicts: [],
				totalTokens: 0,
			};
			results.push(skipped);
			appendFileSync(RUN_JSONL, JSON.stringify(skipped) + "\n");
			continue;
		}

		console.log(`\n[eval] ===== ${task.id} [${task.category}/${task.difficulty}] =====`);
		console.log(`[eval] goal: ${task.goal.slice(0, 120)}...`);
		console.log(`[eval] executor: ${currentExecutor}${degraded ? " (degraded)" : ""}`);

		const result = await runTask(task, currentExecutor, degraded);
		console.log(`[eval] ${task.id} done in ${(result.durationMs / 1000).toFixed(1)}s. verification=${result.verification?.passed ? "PASS" : "FAIL"}`);

		// Degradation check: if this task ran on primary and exceeded threshold,
		// flip remaining tasks to fallback model.
		if (!degraded && result.durationMs > PER_TASK_DEGRADE_THRESHOLD_MS) {
			console.log(`[eval] task exceeded ${PER_TASK_DEGRADE_THRESHOLD_MS}ms - switching to fallback ${EXECUTOR_MODEL_FALLBACK} for remaining tasks`);
			currentExecutor = EXECUTOR_MODEL_FALLBACK;
			degraded = true;
		}

		results.push(result);
		appendFileSync(RUN_JSONL, JSON.stringify(result) + "\n");
	}

	const overallMs = Date.now() - overallStart;

	// ----- summary ------------------------------------------------------------

	const ran = results.filter((r) => !r.skipped);
	const skipped = results.filter((r) => r.skipped);
	const passed = ran.filter((r) => r.verification?.passed === true);
	const failed = ran.filter((r) => r.verification?.passed === false);
	const totalTokens = results.reduce((s, r) => s + (r.totalTokens || 0), 0);

	const summary: string[] = [];
	summary.push(`# Day-3 Eval Run — ${RUN_DATE}`);
	summary.push("");
	summary.push(`**Run started:** ${new Date(overallStart).toISOString()}`);
	summary.push(`**Wall-clock:** ${(overallMs / 60000).toFixed(2)} min`);
	summary.push(`**Tasks loaded:** ${tasks.length}`);
	summary.push(`**Tasks executed:** ${ran.length}`);
	summary.push(`**Tasks skipped:** ${skipped.length}`);
	summary.push(`**Side-effect verification pass:** ${passed.length}/${ran.length}`);
	summary.push(`**Side-effect verification fail:** ${failed.length}/${ran.length}`);
	summary.push(`**Total tokens (executor + judge tracked):** ${totalTokens}`);
	summary.push(`**Executor primary:** ${EXECUTOR_MODEL_PRIMARY} (${EXECUTOR_RUNTIME})`);
	summary.push(`**Executor fallback used:** ${results.some((r) => r.degraded) ? "yes" : "no"}`);
	summary.push(`**Judge:** ${JUDGE_MODEL} (lmstudio via failover)`);
	summary.push("");
	summary.push("## Per-task results");
	summary.push("");
	summary.push("| Task | Category | Difficulty | Status | Verify | Duration | Turns | Tokens |");
	summary.push("|------|----------|------------|--------|--------|----------|-------|--------|");
	for (const r of results) {
		const status = r.skipped ? `SKIP (${r.skipReason})` : r.error ? "ERROR" : "RAN";
		const verify = r.skipped ? "-" : r.verification?.passed ? "PASS" : "FAIL";
		const duration = r.skipped ? "-" : `${(r.durationMs / 1000).toFixed(1)}s`;
		const turns = r.turnVerdicts.length;
		const tokens = r.totalTokens;
		summary.push(`| ${r.taskId} | ${r.category} | ${r.difficulty ?? "?"} | ${status} | ${verify} | ${duration} | ${turns} | ${tokens} |`);
	}
	summary.push("");
	summary.push("## Skipped tasks");
	summary.push("");
	for (const r of skipped) {
		summary.push(`- **${r.taskId}** (${r.category}): ${r.skipReason}`);
	}
	if (skipped.length === 0) summary.push("- none");
	summary.push("");
	summary.push("## Errors");
	summary.push("");
	const errored = results.filter((r) => r.error);
	if (errored.length === 0) {
		summary.push("- none");
	} else {
		for (const r of errored) {
			summary.push(`- **${r.taskId}**: ${r.error}`);
		}
	}
	summary.push("");
	summary.push("## Next step");
	summary.push("");
	summary.push(`Run \`bun scripts/judge-vs-proxy-rater.ts\` to compute judge-vs-proxy agreement on 30 sampled turn-level verdicts. The gate criterion is agreement >= 70%.`);

	writeFileSync(SUMMARY_MD, summary.join("\n") + "\n");
	console.log(`\n[eval] summary written to ${SUMMARY_MD}`);
	console.log(`[eval] raw results at ${RUN_JSONL}`);
	console.log(`[eval] DONE in ${(overallMs / 60000).toFixed(2)}min. ran=${ran.length} skipped=${skipped.length} pass=${passed.length}`);
}

main().catch((err) => {
	console.error("[eval] FATAL:", err);
	process.exit(1);
});
