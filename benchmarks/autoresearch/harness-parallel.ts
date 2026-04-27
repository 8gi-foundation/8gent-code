#!/usr/bin/env bun
/**
 * harness-parallel.ts — Multi-model parallel benchmark harness
 *
 * Fans each benchmark out to N models in parallel (local Ollama + cloud
 * OpenRouter), records every result into the experience-based model
 * router, and reports per-model + per-benchmark scores side-by-side.
 *
 * Default model panel (override via MODELS env var, comma-separated specs):
 *   ollama::qwen3.6:27b
 *   ollama::qwen2.5-coder:7b
 *   ollama::llama3.2:3b
 *   openrouter::anthropic/claude-3.5-sonnet
 *   openrouter::openai/gpt-4o
 *   openrouter::google/gemini-2.0-flash-001
 *
 * Spec format: "provider::model"
 *   provider ∈ { ollama, openrouter }
 *   model    is whatever that provider expects
 *
 * Env:
 *   MODELS                  comma-separated specs (default: panel above)
 *   OPENROUTER_API_KEY      required if any spec is openrouter::*
 *   OLLAMA_URL              default http://localhost:11434/v1/chat/completions
 *   TEMP                    single sampling temperature (default 0.5)
 *   CATEGORY                filter benchmarks by category (default: all)
 *   MAX_BENCHMARKS          limit benchmark count (default: all)
 *   BENCHMARK_TIMEOUT       per-call timeout ms (default 300000)
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { BenchmarkDefinition, BenchmarkRun, TokenUsage } from "../types";

import { agenticBenchmarks } from "../categories/agentic/benchmarks";
import { battleTestBenchmarks } from "../categories/battle-test/benchmarks";
import { battleTestProBenchmarks } from "../categories/battle-test/benchmarks-pro";
import { bugFixingBenchmarks } from "../categories/bug-fixing/benchmarks";
import { featureImplementationBenchmarks } from "../categories/feature-implementation/benchmarks";
import { fileManipulationBenchmarks } from "../categories/file-manipulation/benchmarks";
import { fullstackBenchmarks } from "../categories/fullstack/benchmarks";
import { uiDesignBenchmarks } from "../categories/ui-design/benchmarks";
import { grade } from "./execution-grader";
import { getFewShot } from "./few-shot";
import { getExperienceSummary, recordResult } from "./model-router";
import { getSystemPrompt } from "./system-prompt";

// ── Config ──────────────────────────────────────────────────────────

const ROOT = resolve(dirname(import.meta.dir));

const DEFAULT_MODELS = [
	"ollama::qwen3.6:27b",
	"ollama::qwen2.5-coder:7b",
	"ollama::llama3.2:3b",
	"openrouter::anthropic/claude-3.5-sonnet",
	"openrouter::openai/gpt-4o",
	"openrouter::google/gemini-2.0-flash-001",
];

const MODELS = (process.env.MODELS ? process.env.MODELS.split(",") : DEFAULT_MODELS)
	.map((s) => s.trim())
	.filter(Boolean);

const TEMP = Number.parseFloat(process.env.TEMP ?? "0.5");
const TARGET_CATEGORY = process.env.CATEGORY ?? "";
const MAX_BENCHMARKS = process.env.MAX_BENCHMARKS
	? Number.parseInt(process.env.MAX_BENCHMARKS, 10)
	: Number.POSITIVE_INFINITY;
const TIMEOUT_MS = Number.parseInt(process.env.BENCHMARK_TIMEOUT ?? "300000", 10);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const RESULTS_FILE = join(ROOT, "autoresearch", "results-parallel.tsv");
const LOG_FILE = join(ROOT, "autoresearch", "harness-parallel.log");
const SUMMARY_FILE = join(ROOT, "autoresearch", "parallel-summary.json");

// ── Benchmarks ──────────────────────────────────────────────────────

const ALL_BENCHMARKS: BenchmarkDefinition[] = [
	...bugFixingBenchmarks,
	...fileManipulationBenchmarks,
	...featureImplementationBenchmarks,
	...fullstackBenchmarks,
	...agenticBenchmarks,
	...uiDesignBenchmarks,
	...battleTestBenchmarks,
	...battleTestProBenchmarks,
];

function getTargetBenchmarks(): BenchmarkDefinition[] {
	const filtered = TARGET_CATEGORY
		? ALL_BENCHMARKS.filter((b) => b.category === TARGET_CATEGORY)
		: ALL_BENCHMARKS;
	return filtered.slice(0, MAX_BENCHMARKS);
}

// ── Logging ─────────────────────────────────────────────────────────

function log(msg: string): void {
	const line = `[${new Date().toISOString()}] ${msg}`;
	console.log(line);
	try {
		appendFileSync(LOG_FILE, `${line}\n`);
	} catch {}
}

// ── Provider ────────────────────────────────────────────────────────

type Provider = "ollama" | "openrouter";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ApiResult {
	content: string;
	model: string;
	durationMs: number;
	tokenUsage: TokenUsage;
}

function parseModel(spec: string): { provider: Provider; model: string; spec: string } {
	if (spec.startsWith("ollama::")) return { provider: "ollama", model: spec.slice(8), spec };
	if (spec.startsWith("openrouter::"))
		return { provider: "openrouter", model: spec.slice(12), spec };
	return spec.includes("/")
		? { provider: "openrouter", model: spec, spec: `openrouter::${spec}` }
		: { provider: "ollama", model: spec, spec: `ollama::${spec}` };
}

async function callModel(
	provider: Provider,
	model: string,
	messages: ChatMessage[],
	temperature: number,
): Promise<ApiResult> {
	const start = performance.now();
	const isOllama = provider === "ollama";
	const url = isOllama ? OLLAMA_URL : OPENROUTER_URL;

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (!isOllama) {
		if (!OPENROUTER_API_KEY)
			throw new Error("OPENROUTER_API_KEY required for openrouter::* models");
		headers.Authorization = `Bearer ${OPENROUTER_API_KEY}`;
		headers["HTTP-Referer"] = "https://8gent.app";
		headers["X-Title"] = "8gent-harness-parallel";
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			signal: controller.signal,
			body: JSON.stringify({
				model,
				messages,
				temperature,
				max_tokens: 8192,
				...(isOllama ? { stream: false } : {}),
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`${response.status}: ${body.slice(0, 200)}`);
		}

		const json = (await response.json()) as any;
		const usage = json.usage ?? {};
		const msg = json.choices?.[0]?.message ?? {};
		const content = msg.content || msg.reasoning || "";

		return {
			content,
			model: `${provider}/${json.model ?? model}`,
			durationMs: Math.round(performance.now() - start),
			tokenUsage: {
				promptTokens: usage.prompt_tokens ?? 0,
				completionTokens: usage.completion_tokens ?? 0,
				totalTokens: usage.total_tokens ?? 0,
			},
		};
	} finally {
		clearTimeout(timeout);
	}
}

// ── Single benchmark x model ────────────────────────────────────────

function buildMessages(benchmark: BenchmarkDefinition): ChatMessage[] {
	const systemPrompt = getSystemPrompt();
	const fewShot = getFewShot(benchmark.category);

	const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
	if (fewShot) {
		messages.push({ role: "user", content: "Here is an example of how to solve a similar task:" });
		messages.push({ role: "assistant", content: fewShot });
	}
	messages.push({ role: "user", content: benchmark.prompt });
	return messages;
}

async function runBenchmarkOnModel(
	benchmark: BenchmarkDefinition,
	spec: string,
): Promise<BenchmarkRun> {
	const { provider, model } = parseModel(spec);
	const messages = buildMessages(benchmark);

	const {
		content,
		model: returnedModel,
		durationMs,
		tokenUsage,
	} = await callModel(provider, model, messages, TEMP);

	const { code, result } = await grade(content, benchmark);

	const run: BenchmarkRun = {
		benchmarkId: benchmark.id,
		model: returnedModel,
		temperature: TEMP,
		rawOutput: content,
		extractedCode: code,
		grade: result,
		timestamp: Date.now(),
		durationMs,
		tokenUsage,
	};

	recordResult(returnedModel, benchmark.category, benchmark.id, result.score);
	return run;
}

// ── Parallel fan-out ────────────────────────────────────────────────

interface ModelOutcome {
	spec: string;
	provider: Provider;
	model: string;
	run: BenchmarkRun | null;
	error: string | null;
}

async function runBenchmarkParallel(
	benchmark: BenchmarkDefinition,
	specs: string[],
): Promise<ModelOutcome[]> {
	const settled = await Promise.allSettled(
		specs.map(async (spec) => {
			const { provider, model } = parseModel(spec);
			const run = await runBenchmarkOnModel(benchmark, spec);
			return { spec, provider, model, run };
		}),
	);

	return settled.map((res, i) => {
		const { provider, model } = parseModel(specs[i]);
		if (res.status === "fulfilled") {
			return { spec: specs[i], provider, model, run: res.value.run, error: null };
		}
		return {
			spec: specs[i],
			provider,
			model,
			run: null,
			error: (res.reason as Error)?.message ?? String(res.reason),
		};
	});
}

// ── Output ──────────────────────────────────────────────────────────

function initResultsFile(): void {
	const header = [
		"benchmark_id",
		"category",
		"title",
		"difficulty",
		"spec",
		"model_returned",
		"score",
		"exec_score",
		"kw_score",
		"method",
		"passed_tests",
		"total_tests",
		"api_duration_ms",
		"prompt_tokens",
		"completion_tokens",
		"total_tokens",
		"error",
		"timestamp",
	].join("\t");
	writeFileSync(RESULTS_FILE, `${header}\n`);
}

function appendOutcome(benchmark: BenchmarkDefinition, outcome: ModelOutcome): void {
	const r = outcome.run;
	const row = [
		benchmark.id,
		benchmark.category,
		benchmark.title,
		benchmark.difficulty,
		outcome.spec,
		r?.model ?? "",
		r?.grade.score ?? 0,
		r?.grade.execution?.score ?? "",
		r?.grade.keyword.score ?? "",
		r?.grade.method ?? "",
		r?.grade.execution?.passedTests ?? "",
		r?.grade.execution?.totalTests ?? "",
		r?.durationMs ?? 0,
		r?.tokenUsage?.promptTokens ?? 0,
		r?.tokenUsage?.completionTokens ?? 0,
		r?.tokenUsage?.totalTokens ?? 0,
		outcome.error ?? "",
		new Date().toISOString(),
	].join("\t");
	appendFileSync(RESULTS_FILE, `${row}\n`);
}

// ── Main ────────────────────────────────────────────────────────────

interface RunSummary {
	timestamp: string;
	models: string[];
	temp: number;
	totalBenchmarks: number;
	perModel: Record<
		string,
		{ runs: number; failed: number; avgScore: number; passing: number; totalTokens: number }
	>;
	bestPerBenchmark: Record<string, { spec: string; score: number }>;
}

async function main(): Promise<void> {
	const needsOpenRouter = MODELS.some((s) => parseModel(s).provider === "openrouter");
	if (needsOpenRouter && !OPENROUTER_API_KEY) {
		console.error(
			"❌ OPENROUTER_API_KEY required for openrouter::* models. Either set it, or pass MODELS=ollama::...",
		);
		process.exit(1);
	}

	mkdirSync(join(ROOT, "autoresearch", "work"), { recursive: true });
	initResultsFile();

	const benchmarks = getTargetBenchmarks();

	log("═".repeat(70));
	log("  Multi-Model Parallel Harness");
	log("═".repeat(70));
	log(`  Models (${MODELS.length}): ${MODELS.join(", ")}`);
	log(`  Temp:        ${TEMP}`);
	log(`  Benchmarks:  ${benchmarks.length} (${TARGET_CATEGORY || "all categories"})`);
	log(`  Timeout:     ${TIMEOUT_MS}ms per call`);
	log("");

	const perModelStats: Record<
		string,
		{ runs: number; failed: number; totalScore: number; passing: number; totalTokens: number }
	> = {};
	for (const spec of MODELS) {
		perModelStats[spec] = { runs: 0, failed: 0, totalScore: 0, passing: 0, totalTokens: 0 };
	}

	const bestPerBenchmark: Record<string, { spec: string; score: number }> = {};

	for (const benchmark of benchmarks) {
		log(`┌─ ${benchmark.id}: ${benchmark.title} [${benchmark.difficulty}]`);
		const start = performance.now();

		const outcomes = await runBenchmarkParallel(benchmark, MODELS);

		const wallMs = Math.round(performance.now() - start);

		let bestSpec: string | null = null;
		let bestScore = -1;

		for (const outcome of outcomes) {
			appendOutcome(benchmark, outcome);
			const stats = perModelStats[outcome.spec];
			if (!outcome.run) {
				stats.failed += 1;
				log(`│  ✗ ${outcome.spec.padEnd(48)} ERROR: ${outcome.error?.slice(0, 80) ?? "?"}`);
				continue;
			}
			const score = outcome.run.grade.score;
			stats.runs += 1;
			stats.totalScore += score;
			if (score >= 70) stats.passing += 1;
			stats.totalTokens += outcome.run.tokenUsage?.totalTokens ?? 0;

			if (score > bestScore) {
				bestScore = score;
				bestSpec = outcome.spec;
			}

			log(
				`│  ${score >= 70 ? "✓" : "·"} ${outcome.spec.padEnd(48)} score=${String(score).padStart(3)} tokens=${outcome.run.tokenUsage?.totalTokens ?? "?"} ${outcome.run.durationMs}ms`,
			);
		}

		if (bestSpec) bestPerBenchmark[benchmark.id] = { spec: bestSpec, score: bestScore };
		log(`└─ wall=${wallMs}ms best=${bestSpec ?? "none"} score=${bestScore}`);
		log("");
	}

	// ── Per-model summary ─────────────────────────────────────────────
	log("═".repeat(70));
	log("  PER-MODEL SUMMARY");
	log("═".repeat(70));
	const summary: RunSummary = {
		timestamp: new Date().toISOString(),
		models: MODELS,
		temp: TEMP,
		totalBenchmarks: benchmarks.length,
		perModel: {},
		bestPerBenchmark,
	};

	for (const spec of MODELS) {
		const s = perModelStats[spec];
		const avg = s.runs > 0 ? Math.round(s.totalScore / s.runs) : 0;
		summary.perModel[spec] = {
			runs: s.runs,
			failed: s.failed,
			avgScore: avg,
			passing: s.passing,
			totalTokens: s.totalTokens,
		};
		log(
			`  ${spec.padEnd(48)} avg=${String(avg).padStart(3)}  pass=${s.passing}/${benchmarks.length}  fail=${s.failed}  tokens=${s.totalTokens}`,
		);
	}

	log("");
	log("  Best-per-benchmark distribution:");
	const winnerCounts: Record<string, number> = {};
	for (const { spec } of Object.values(bestPerBenchmark)) {
		winnerCounts[spec] = (winnerCounts[spec] ?? 0) + 1;
	}
	for (const [spec, count] of Object.entries(winnerCounts).sort((a, b) => b[1] - a[1])) {
		log(`    ${spec.padEnd(48)} won ${count}/${benchmarks.length}`);
	}

	writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
	log("");
	log(`  Results TSV:  ${RESULTS_FILE}`);
	log(`  Summary JSON: ${SUMMARY_FILE}`);
	log(`  Log:          ${LOG_FILE}`);
	log("");
	log("  🧠 Updated model-experience.json (router learns from every run)");
	log("");
	log(getExperienceSummary());
	log("");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
