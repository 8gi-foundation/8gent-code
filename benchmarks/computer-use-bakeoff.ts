#!/usr/bin/env bun
/**
 * Computer-use failover bake-off harness.
 *
 * Runs the `computer-use` category against two chains:
 *   - baseline: legacy text-channel chain (anchor `eight-1.0-q3:14b`)
 *   - candidate: new computer-channel chain (apfel → Qwen 3.6-27B
 *     → DeepSeek V4-Flash → OpenRouter `:free`)
 *
 * Per-task grading is keyword-based: a response passes when at least
 * `passKeywordCount` of the listed keywords appear (case-insensitive).
 *
 * If a tier in the chain is unreachable the harness records the failover
 * event and falls through automatically (that's the whole point).
 *
 * Headless invocation:
 *
 *     CATEGORY=computer-use bun run benchmark:loop
 *
 * is wired in `package.json`; this file is also runnable directly:
 *
 *     bun run benchmarks/computer-use-bakeoff.ts
 *     bun run benchmarks/computer-use-bakeoff.ts --chain candidate
 *     bun run benchmarks/computer-use-bakeoff.ts --dry-run
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
	ModelFailover,
	type FailoverEntry,
} from "../packages/providers/failover";
import { OllamaClient } from "../packages/eight/clients/ollama";
import { LMStudioClient } from "../packages/eight/clients/lmstudio";
import { ApfelClient } from "../packages/eight/clients/apfel";
import { OpenRouterClient } from "../packages/eight/clients/openrouter";
import type { LLMClient, Message } from "../packages/eight/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = path.join(HERE, "categories/computer-use/tasks.json");
const FIXTURES_DIR = path.join(HERE, "categories/computer-use");

interface Task {
	id: string;
	title: string;
	kind: "vision" | "tool" | "chat";
	prompt: string;
	fixture?: string;
	expectedKeywords: string[];
	passKeywordCount: number;
}

interface TasksFile {
	category: string;
	version: string;
	description: string;
	tasks: Task[];
}

interface TaskOutcome {
	taskId: string;
	title: string;
	kind: Task["kind"];
	resolvedTier: FailoverEntry;
	pass: boolean;
	matchedKeywords: string[];
	missedKeywords: string[];
	durationMs: number;
	error?: string;
}

interface ChainResult {
	chain: "baseline" | "candidate";
	outcomes: TaskOutcome[];
	failoverEvents: number;
	passed: number;
	total: number;
	durationMs: number;
}

function clientForEntry(entry: FailoverEntry): LLMClient | null {
	switch (entry.provider) {
		case "apfel":
			return new ApfelClient(entry.model);
		case "ollama":
		case "8gent":
			return new OllamaClient(entry.model);
		case "lmstudio":
			return new LMStudioClient(entry.model);
		case "deepseek":
			try {
				// Lazy import keeps the harness importable without the key set.
				const {
					DeepSeekClient,
				} = require("../packages/eight/clients/deepseek");
				return new DeepSeekClient(entry.model);
			} catch (err) {
				console.warn(
					`[bakeoff] deepseek client unavailable: ${(err as Error).message}`,
				);
				return null;
			}
		case "openrouter": {
			const apiKey = process.env.OPENROUTER_API_KEY || "";
			if (!apiKey) return null;
			return new OpenRouterClient(entry.model, apiKey);
		}
		default:
			return null;
	}
}

function buildMessages(task: Task): Message[] {
	if (task.kind === "vision" && task.fixture) {
		const fp = path.join(FIXTURES_DIR, task.fixture);
		if (fs.existsSync(fp)) {
			const b64 = fs.readFileSync(fp).toString("base64");
			return [
				{
					role: "user",
					content: [
						{ type: "text", text: task.prompt },
						{
							type: "image_url",
							image_url: { url: `data:image/png;base64,${b64}` },
						},
					],
				},
			];
		}
	}
	return [{ role: "user", content: task.prompt }];
}

function gradeOutput(
	task: Task,
	output: string,
): { pass: boolean; matched: string[]; missed: string[] } {
	const lower = output.toLowerCase();
	const matched: string[] = [];
	const missed: string[] = [];
	for (const kw of task.expectedKeywords) {
		if (lower.includes(kw.toLowerCase())) matched.push(kw);
		else missed.push(kw);
	}
	return { pass: matched.length >= task.passKeywordCount, matched, missed };
}

async function runTaskOnChain(
	task: Task,
	fo: ModelFailover,
	channel: "text" | "computer",
	anchor: string,
	dryRun: boolean,
): Promise<TaskOutcome> {
	const start = Date.now();
	const messages = buildMessages(task);

	// Walk the chain manually so failover events are recorded per attempt.
	let attempts = 0;
	while (attempts < 6) {
		attempts++;
		const entry = fo.resolve(anchor, channel);

		if (dryRun) {
			return {
				taskId: task.id,
				title: task.title,
				kind: task.kind,
				resolvedTier: entry,
				pass: true,
				matchedKeywords: [],
				missedKeywords: [],
				durationMs: Date.now() - start,
				error: "dry-run",
			};
		}

		const client = clientForEntry(entry);
		if (!client) {
			fo.markDown(entry.model, entry.provider);
			continue;
		}

		try {
			const response = await client.chat(messages);
			const content = response.message.content || "";
			const grade = gradeOutput(task, content);
			return {
				taskId: task.id,
				title: task.title,
				kind: task.kind,
				resolvedTier: entry,
				pass: grade.pass,
				matchedKeywords: grade.matched,
				missedKeywords: grade.missed,
				durationMs: Date.now() - start,
			};
		} catch (err) {
			fo.markDown(entry.model, entry.provider);
			// Try the next tier.
			continue;
		}
	}

	return {
		taskId: task.id,
		title: task.title,
		kind: task.kind,
		resolvedTier: { model: anchor, provider: "unknown" },
		pass: false,
		matchedKeywords: [],
		missedKeywords: task.expectedKeywords,
		durationMs: Date.now() - start,
		error: "all tiers exhausted",
	};
}

async function runChain(
	label: "baseline" | "candidate",
	channel: "text" | "computer",
	anchor: string,
	tasks: Task[],
	dryRun: boolean,
): Promise<ChainResult> {
	const fo = new ModelFailover();
	const startedAt = Date.now();
	const outcomes: TaskOutcome[] = [];
	for (const task of tasks) {
		const outcome = await runTaskOnChain(task, fo, channel, anchor, dryRun);
		outcomes.push(outcome);
	}
	const events = fo.drainEvents();
	return {
		chain: label,
		outcomes,
		failoverEvents: events.length,
		passed: outcomes.filter((o) => o.pass).length,
		total: outcomes.length,
		durationMs: Date.now() - startedAt,
	};
}

function summary(result: ChainResult): string {
	const rows = result.outcomes.map((o) => {
		const mark = o.pass ? "PASS" : "FAIL";
		const tier = `${o.resolvedTier.provider}/${o.resolvedTier.model}`;
		return `  - ${o.taskId} [${mark}] tier=${tier} (${o.durationMs}ms)${o.error ? ` err=${o.error}` : ""}`;
	});
	return [
		`chain=${result.chain} passed=${result.passed}/${result.total} ` +
			`failovers=${result.failoverEvents} duration=${result.durationMs}ms`,
		...rows,
	].join("\n");
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const dryRun = args.has("--dry-run") || process.env.BAKEOFF_DRY_RUN === "1";
	const chainArg = process.argv.includes("--chain")
		? process.argv[process.argv.indexOf("--chain") + 1]
		: "both";

	if (!fs.existsSync(TASKS_FILE)) {
		console.error(`[bakeoff] tasks file missing: ${TASKS_FILE}`);
		process.exit(1);
	}
	const tasks = (JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8")) as TasksFile)
		.tasks;
	console.log(`[bakeoff] loaded ${tasks.length} tasks (dry-run=${dryRun})`);

	const results: ChainResult[] = [];
	if (chainArg === "both" || chainArg === "baseline") {
		console.log("\n=== baseline (text channel, eight-1.0-q3:14b anchor) ===");
		const r = await runChain(
			"baseline",
			"text",
			"apple-foundation-system",
			tasks,
			dryRun,
		);
		console.log(summary(r));
		results.push(r);
	}
	if (chainArg === "both" || chainArg === "candidate") {
		console.log("\n=== candidate (computer channel, qwen3.6:27b anchor) ===");
		const r = await runChain(
			"candidate",
			"computer",
			"qwen3.6:27b",
			tasks,
			dryRun,
		);
		console.log(summary(r));
		results.push(r);
	}

	// Emit JSON to a results file for the report.
	const outFile = path.join(HERE, "results", "computer-use-bakeoff.json");
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(
		outFile,
		JSON.stringify({ ts: Date.now(), dryRun, results }, null, 2),
	);
	console.log(`\n[bakeoff] wrote ${outFile}`);
}

main().catch((err) => {
	console.error(`[bakeoff] crashed: ${err}`);
	process.exit(1);
});
