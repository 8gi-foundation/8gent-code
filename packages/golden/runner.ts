/**
 * Golden runner.
 *
 * Wraps a `ChatTransport` (anything that takes a prompt and returns a
 * response with captured tool calls) and runs each golden case against
 * it. The default transport adapts the daemon's AgentPool so we measure
 * the same code path that production traffic hits, not a mocked agent.
 *
 * Tests can pass a stub transport directly - this is what the bun:test
 * suite uses to verify the runner's grading logic without spinning up
 * a daemon.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { grade } from "./grader";
import {
	type AgentRunResult,
	type CapturedToolCall,
	type CaseResult,
	type GoldenCase,
	type RunSummary,
	parseGoldenCase,
} from "./schema";

export interface ChatTransport {
	/**
	 * Send `prompt` to a fresh session on `channel` and return the captured
	 * end-to-end run. Implementations are responsible for tearing down the
	 * session afterwards.
	 */
	run(opts: {
		caseId: string;
		channel: string;
		prompt: string;
	}): Promise<AgentRunResult>;

	/** Optional metadata for the summary header. */
	describe?(): { model: string; runtime: string };
}

export interface RunOptions {
	cases: GoldenCase[];
	transport: ChatTransport;
	/** Optional progress callback - useful for CLI progress bars. */
	onCaseStart?: (gcase: GoldenCase, index: number, total: number) => void;
	onCaseFinish?: (result: CaseResult, index: number, total: number) => void;
	/** Optional regex applied to case ids; non-matching cases are skipped. */
	filter?: RegExp;
}

export interface RunOutput {
	summary: RunSummary;
	results: CaseResult[];
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo] ?? 0;
	const fraction = pos - lo;
	const a = sorted[lo] ?? 0;
	const b = sorted[hi] ?? 0;
	return a + (b - a) * fraction;
}

function makeRunId(): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const noise = Math.random().toString(36).slice(2, 8);
	return `golden-${ts}-${noise}`;
}

/** Run a set of golden cases and return aggregated results. */
export async function runGolden(opts: RunOptions): Promise<RunOutput> {
	const { cases, transport, onCaseStart, onCaseFinish, filter } = opts;
	const runId = makeRunId();
	const startedAt = Date.now();
	const results: CaseResult[] = [];

	const filtered = cases.filter((c) => !filter || filter.test(c.id));
	const total = filtered.length;

	let skipped = 0;
	for (let i = 0; i < filtered.length; i++) {
		const gcase = filtered[i] as GoldenCase;
		if (gcase.skip) {
			skipped++;
			continue;
		}
		onCaseStart?.(gcase, i, total);

		const startMs = Date.now();
		let runResult: AgentRunResult;
		try {
			runResult = await transport.run({
				caseId: gcase.id,
				channel: gcase.channel,
				prompt: gcase.prompt,
			});
		} catch (err) {
			runResult = {
				caseId: gcase.id,
				prompt: gcase.prompt,
				response: "",
				durationMs: Date.now() - startMs,
				toolCalls: [],
				promptTokensEstimate: 0,
				completionTokensEstimate: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}

		const gradeResult = grade(runResult, gcase);
		const caseResult: CaseResult = {
			...runResult,
			...gradeResult,
			startedAt: startMs,
		};
		results.push(caseResult);
		onCaseFinish?.(caseResult, i, total);
	}

	const finishedAt = Date.now();
	const sortedDurations = [...results.map((r) => r.durationMs)].sort((a, b) => a - b);
	const passed = results.filter((r) => r.passed).length;
	const failed = results.length - passed;
	const totalToolCalls = results.reduce((acc, r) => acc + r.toolCalls.length, 0);
	const totalPromptTokens = results.reduce((acc, r) => acc + (r.promptTokensEstimate ?? 0), 0);
	const totalCompletionTokens = results.reduce(
		(acc, r) => acc + (r.completionTokensEstimate ?? 0),
		0,
	);
	const meanScore =
		results.length === 0 ? 0 : results.reduce((acc, r) => acc + r.score, 0) / results.length;

	const desc = transport.describe?.() ?? { model: "unknown", runtime: "unknown" };
	const summary: RunSummary = {
		runId,
		startedAt,
		finishedAt,
		totalCases: filtered.length,
		passed,
		failed,
		skipped,
		score: meanScore,
		p50DurationMs: Math.round(quantile(sortedDurations, 0.5)),
		p95DurationMs: Math.round(quantile(sortedDurations, 0.95)),
		p99DurationMs: Math.round(quantile(sortedDurations, 0.99)),
		totalToolCalls,
		totalPromptTokensEstimate: totalPromptTokens,
		totalCompletionTokensEstimate: totalCompletionTokens,
		model: desc.model,
		runtime: desc.runtime,
	};

	return { summary, results };
}

/** Load every JSON case in a directory. Throws on first invalid case. */
export function loadCasesFromDirectory(dir: string): GoldenCase[] {
	if (!fs.existsSync(dir)) {
		throw new Error(`golden case directory not found: ${dir}`);
	}
	const entries = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const out: GoldenCase[] = [];
	for (const file of entries) {
		const full = path.join(dir, file);
		const raw = fs.readFileSync(full, "utf8");
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (err) {
			throw new Error(`golden case ${file} is not valid JSON: ${(err as Error).message}`);
		}
		try {
			out.push(parseGoldenCase(json));
		} catch (err) {
			throw new Error(`golden case ${file} failed schema validation: ${(err as Error).message}`);
		}
	}
	return out;
}

/**
 * AgentPool transport - the production code path.
 *
 * We import lazily so callers that only ever use a stub transport
 * (e.g. bun:test) don't have to pull in the full daemon graph.
 */
export interface AgentPoolLike {
	createSession(sessionId: string, channel: string): void;
	chat(sessionId: string, text: string): Promise<string>;
	destroySession(sessionId: string): void;
}

export interface AgentPoolBusLike {
	on(
		event: "tool:start" | "tool:result",
		handler: (payload: {
			sessionId: string;
			tool: string;
			durationMs?: number;
		}) => void,
	): number;
	off(id: number): void;
}

export interface AgentPoolTransportOpts {
	pool: AgentPoolLike;
	bus: AgentPoolBusLike;
	model: string;
	runtime: string;
	sessionPrefix?: string;
}

export function agentPoolTransport(opts: AgentPoolTransportOpts): ChatTransport {
	const prefix = opts.sessionPrefix ?? "golden";
	let counter = 0;

	return {
		describe() {
			return { model: opts.model, runtime: opts.runtime };
		},
		async run({ caseId, channel, prompt }) {
			counter++;
			const sessionId = `${prefix}-${caseId}-${counter}`;
			const toolCalls: CapturedToolCall[] = [];
			const inflight = new Map<string, number>();

			const startSub = opts.bus.on("tool:start", (p) => {
				if (p.sessionId !== sessionId) return;
				inflight.set(p.tool, Date.now());
			});
			const endSub = opts.bus.on("tool:result", (p) => {
				if (p.sessionId !== sessionId) return;
				const startedAt = inflight.get(p.tool);
				const durationMs = p.durationMs ?? (startedAt ? Date.now() - startedAt : 0);
				inflight.delete(p.tool);
				toolCalls.push({ tool: p.tool, durationMs });
			});

			const startMs = Date.now();
			let response = "";
			let error: string | undefined;
			try {
				opts.pool.createSession(sessionId, channel);
				response = await opts.pool.chat(sessionId, prompt);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			} finally {
				try {
					opts.pool.destroySession(sessionId);
				} catch {
					// session may already be gone
				}
				opts.bus.off(startSub);
				opts.bus.off(endSub);
			}

			const durationMs = Date.now() - startMs;
			const promptTokensEstimate = Math.ceil(prompt.length / 4);
			const completionTokensEstimate = Math.ceil(response.length / 4);

			return {
				caseId,
				prompt,
				response,
				durationMs,
				toolCalls,
				promptTokensEstimate,
				completionTokensEstimate,
				error,
			};
		},
	};
}
