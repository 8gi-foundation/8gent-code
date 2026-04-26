#!/usr/bin/env bun
/**
 * multi-model-harness.ts — Parallel benchmark runner across local + cloud models.
 *
 * Out of scope by design:
 * - No model pulling. All models must already be available.
 * - No prompt mutation here. That stays in harness-v2.ts.
 *
 * Wires:
 * - Ollama (qwen3:32b)            -> http://localhost:11434
 * - LM Studio (gemma-4-26b-a4b)   -> http://localhost:1234
 * - Apple Foundation (apfel HTTP) -> http://localhost:11500/v1
 * - OpenRouter cloud              -> https://openrouter.ai/api/v1
 *
 * For each benchmark:
 * 1. Probe which models are reachable
 * 2. Run benchmark on every reachable model in parallel (bounded)
 * 3. Grade each output with the existing execution + keyword grader
 * 4. Record (model, domain, benchmarkId, score) to the model-router experience DB
 * 5. Print a per-domain leaderboard at the end
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

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
import { recordResult, getExperienceSummary } from "./model-router";
import { getSystemPrompt } from "./system-prompt";

// ── Config ──────────────────────────────────────────────────────────

const ROOT = resolve(dirname(import.meta.dir));
const OUTPUT_FILE = join(ROOT, "results-multi.tsv");
const LOG_FILE = join(ROOT, "autoresearch", "multi-model.log");

const MAX_CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY ?? 4);
const MAX_TOKENS = Number(process.env.HARNESS_MAX_TOKENS ?? 2048);
const TEMPERATURE = Number(process.env.HARNESS_TEMP ?? 0.5);
const CALL_TIMEOUT_MS = Number(process.env.HARNESS_CALL_TIMEOUT_MS ?? 600_000);

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

interface ModelEndpoint {
	id: string; // stable name used by model-router DB (e.g. "ollama:qwen3:32b")
	provider: "ollama" | "lmstudio" | "apfel" | "openrouter";
	model: string; // wire model id
	probe: () => Promise<boolean>;
	call: (messages: ChatMessage[]) => Promise<ApiResult>;
}

// ── Provider Adapters ───────────────────────────────────────────────

function ollamaAdapter(model: string, baseUrl = "http://localhost:11434"): ModelEndpoint {
	return {
		id: `ollama:${model}`,
		provider: "ollama",
		model,
		probe: async () => {
			try {
				const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
				if (!r.ok) return false;
				const json: any = await r.json();
				return (json.models ?? []).some((m: any) => m.name === model);
			} catch {
				return false;
			}
		},
		call: async (messages) => {
			const start = performance.now();
			const r = await fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
				body: JSON.stringify({
					model,
					messages,
					stream: false,
					options: { temperature: TEMPERATURE, num_predict: MAX_TOKENS },
				}),
			});
			if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
			const json: any = await r.json();
			return {
				content: json.message?.content ?? "",
				model: json.model ?? model,
				durationMs: Math.round(performance.now() - start),
				tokenUsage: {
					promptTokens: json.prompt_eval_count ?? 0,
					completionTokens: json.eval_count ?? 0,
					totalTokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0),
				},
			};
		},
	};
}

function openAICompatAdapter(opts: {
	id: string;
	provider: ModelEndpoint["provider"];
	model: string;
	baseUrl: string;
	headers?: Record<string, string>;
}): ModelEndpoint {
	const headers = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
	return {
		id: opts.id,
		provider: opts.provider,
		model: opts.model,
		probe: async () => {
			try {
				const r = await fetch(`${opts.baseUrl}/models`, {
					headers: opts.headers ?? {},
					signal: AbortSignal.timeout(3000),
				});
				if (!r.ok) return false;
				if (opts.provider === "lmstudio") {
					const json: any = await r.json();
					return (json.data ?? []).some((m: any) => m.id === opts.model);
				}
				return true;
			} catch {
				return false;
			}
		},
		call: async (messages) => {
			const start = performance.now();
			const r = await fetch(`${opts.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
				body: JSON.stringify({
					model: opts.model,
					messages,
					temperature: TEMPERATURE,
					max_tokens: MAX_TOKENS,
				}),
			});
			if (!r.ok) throw new Error(`${opts.provider} ${r.status}: ${await r.text()}`);
			const json: any = await r.json();
			const usage = json.usage ?? {};
			return {
				content: json.choices?.[0]?.message?.content ?? "",
				model: json.model ?? opts.model,
				durationMs: Math.round(performance.now() - start),
				tokenUsage: {
					promptTokens: usage.prompt_tokens ?? 0,
					completionTokens: usage.completion_tokens ?? 0,
					totalTokens: usage.total_tokens ?? 0,
				},
			};
		},
	};
}

// ── Endpoint registry ───────────────────────────────────────────────

function buildEndpoints(): ModelEndpoint[] {
	const out: ModelEndpoint[] = [];

	// Local
	out.push(ollamaAdapter(process.env.OLLAMA_MODEL ?? "qwen3:32b"));
	out.push(
		openAICompatAdapter({
			id: "lmstudio:gemma-4-26b-a4b",
			provider: "lmstudio",
			model: process.env.LMSTUDIO_MODEL ?? "google/gemma-4-26b-a4b",
			baseUrl: process.env.LM_STUDIO_HOST ?? "http://localhost:1234/v1",
		}),
	);
	out.push(
		openAICompatAdapter({
			id: "apfel:apple-foundationmodel",
			provider: "apfel",
			model: process.env.APFEL_MODEL ?? "apple-foundationmodel",
			baseUrl: process.env.APFEL_BASE_URL ?? "http://localhost:11500/v1",
		}),
	);

	// Cloud (only if OPENROUTER_API_KEY is set)
	const orKey = process.env.OPENROUTER_API_KEY;
	if (orKey) {
		const cloudModels = (
			process.env.CLOUD_MODELS ??
			"anthropic/claude-sonnet-4.5,openai/gpt-4o,google/gemini-2.0-flash-001"
		)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		const cloudHeaders = {
			Authorization: `Bearer ${orKey}`,
			"HTTP-Referer": "https://8gent.dev",
			"X-Title": "8gent-multi-model-harness",
		};
		for (const model of cloudModels) {
			out.push(
				openAICompatAdapter({
					id: `openrouter:${model}`,
					provider: "openrouter",
					model,
					baseUrl: "https://openrouter.ai/api/v1",
					headers: cloudHeaders,
				}),
			);
		}
	}

	return out;
}

// ── Logging ─────────────────────────────────────────────────────────

function log(msg: string): void {
	const line = `[${new Date().toISOString()}] ${msg}`;
	console.log(line);
	try {
		appendFileSync(LOG_FILE, `${line}\n`);
	} catch {}
}

// ── Concurrency ─────────────────────────────────────────────────────

async function pMap<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Run ─────────────────────────────────────────────────────────────

interface ModelOutcome {
	endpoint: ModelEndpoint;
	run: BenchmarkRun | null;
	error?: string;
}

function buildMessages(benchmark: BenchmarkDefinition): ChatMessage[] {
	const sys = getSystemPrompt();
	const fewShot = getFewShot(benchmark.category);
	const messages: ChatMessage[] = [{ role: "system", content: sys }];
	if (fewShot) {
		messages.push({ role: "user", content: "Here is an example of a similar task:" });
		messages.push({ role: "assistant", content: fewShot });
	}
	messages.push({ role: "user", content: benchmark.prompt });
	return messages;
}

async function runOnEndpoint(
	benchmark: BenchmarkDefinition,
	endpoint: ModelEndpoint,
): Promise<ModelOutcome> {
	const messages = buildMessages(benchmark);
	try {
		const api = await endpoint.call(messages);
		const { code, result } = await grade(api.content, benchmark);
		const run: BenchmarkRun = {
			benchmarkId: benchmark.id,
			model: endpoint.id,
			temperature: TEMPERATURE,
			rawOutput: api.content,
			extractedCode: code,
			grade: result,
			timestamp: Date.now(),
			durationMs: api.durationMs,
			tokenUsage: api.tokenUsage,
		};
		recordResult(endpoint.id, benchmark.category, benchmark.id, result.score);
		return { endpoint, run };
	} catch (err: any) {
		return { endpoint, run: null, error: err?.message ?? String(err) };
	}
}

function initResultsFile(): void {
	const header = [
		"benchmark_id",
		"category",
		"model_id",
		"provider",
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
		"timestamp",
	].join("\t");
	writeFileSync(OUTPUT_FILE, `${header}\n`);
}

function appendResult(
	benchmark: BenchmarkDefinition,
	endpoint: ModelEndpoint,
	run: BenchmarkRun,
): void {
	const row = [
		run.benchmarkId,
		benchmark.category,
		endpoint.id,
		endpoint.provider,
		run.grade.score,
		run.grade.execution?.score ?? "",
		run.grade.keyword.score,
		run.grade.method,
		run.grade.execution?.passedTests ?? "",
		run.grade.execution?.totalTests ?? "",
		run.durationMs,
		run.tokenUsage?.promptTokens ?? "",
		run.tokenUsage?.completionTokens ?? "",
		run.tokenUsage?.totalTokens ?? "",
		new Date(run.timestamp).toISOString(),
	].join("\t");
	appendFileSync(OUTPUT_FILE, `${row}\n`);
}

// ── Selection ───────────────────────────────────────────────────────

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

function selectBenchmarks(): BenchmarkDefinition[] {
	const cats = process.env.CATEGORIES?.split(",").map((s) => s.trim()).filter(Boolean);
	const ids = process.env.IDS?.split(",").map((s) => s.trim()).filter(Boolean);
	let list = ALL_BENCHMARKS;
	if (cats?.length) list = list.filter((b) => cats.includes(b.category));
	if (ids?.length) list = list.filter((b) => ids.includes(b.id));
	const limit = Number(process.env.LIMIT ?? 0);
	if (limit > 0) list = list.slice(0, limit);
	return list;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	mkdirSync(join(ROOT, "autoresearch", "work"), { recursive: true });
	initResultsFile();

	log("═══════════════════════════════════════════════════════════════");
	log("  Multi-Model Harness — parallel local + cloud benchmarks");
	log("═══════════════════════════════════════════════════════════════");

	const allEndpoints = buildEndpoints();
	log(`  Probing ${allEndpoints.length} endpoints...`);
	const probes = await Promise.all(
		allEndpoints.map(async (e) => ({ e, ok: await e.probe() })),
	);
	const endpoints = probes.filter((p) => p.ok).map((p) => p.e);
	for (const { e, ok } of probes) {
		log(`  ${ok ? "✓" : "✗"} ${e.id}`);
	}

	if (endpoints.length === 0) {
		log("  No reachable endpoints. Exiting.");
		process.exit(1);
	}

	const benchmarks = selectBenchmarks();
	log(`  Benchmarks: ${benchmarks.length}, models: ${endpoints.length}`);
	log(`  Concurrency: ${MAX_CONCURRENCY}, temperature: ${TEMPERATURE}`);
	log("");

	type AggKey = string;
	const perModel: Record<AggKey, { score: number; runs: number; errors: number }> = {};

	for (const benchmark of benchmarks) {
		log(`┌─ ${benchmark.id} [${benchmark.category}/${benchmark.difficulty}] ${benchmark.title}`);

		const outcomes = await pMap(endpoints, MAX_CONCURRENCY, (ep) =>
			runOnEndpoint(benchmark, ep),
		);

		// Sort by score desc for readable log
		outcomes.sort((a, b) => (b.run?.grade.score ?? -1) - (a.run?.grade.score ?? -1));

		for (const { endpoint, run, error } of outcomes) {
			if (!perModel[endpoint.id]) perModel[endpoint.id] = { score: 0, runs: 0, errors: 0 };
			if (error || !run) {
				perModel[endpoint.id].errors += 1;
				log(`│  ✗ ${endpoint.id} failed: ${error ?? "no run"}`);
				continue;
			}
			perModel[endpoint.id].score += run.grade.score;
			perModel[endpoint.id].runs += 1;
			appendResult(benchmark, endpoint, run);
			const tk = run.tokenUsage?.totalTokens ?? "?";
			log(
				`│  ${run.grade.score >= 70 ? "✓" : "·"} ${endpoint.id.padEnd(40)} score=${String(run.grade.score).padStart(3)} (exec=${run.grade.execution?.score ?? "n/a"}, kw=${run.grade.keyword.score}) tokens=${tk} ${run.durationMs}ms`,
			);
		}
		log("");
	}

	// ── Leaderboard ─────────────────────────────────────────────────
	log("═══════════════════════════════════════════════════════════════");
	log("  PER-MODEL AVERAGE SCORE");
	log("═══════════════════════════════════════════════════════════════");
	const sorted = Object.entries(perModel)
		.map(([id, s]) => ({
			id,
			avg: s.runs > 0 ? Math.round(s.score / s.runs) : 0,
			runs: s.runs,
			errors: s.errors,
		}))
		.sort((a, b) => b.avg - a.avg);
	for (const r of sorted) {
		log(`  ${String(r.avg).padStart(3)}  ${r.id.padEnd(50)} runs=${r.runs} errors=${r.errors}`);
	}

	log("");
	log("Per-domain best (from experience DB):");
	log(getExperienceSummary());
	log("");
	log(`Results TSV: ${OUTPUT_FILE}`);
	log(`Log file:    ${LOG_FILE}`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
