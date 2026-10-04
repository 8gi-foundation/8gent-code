#!/usr/bin/env bun
/**
 * speed-gate.ts - a faster setting ships only if its answers hold (#3467).
 *
 * Runs a baseline and a candidate model config paired, one after the other, on
 * the same fixed suite. Records each side's decision, probability (when the
 * output carries one) and latency, then returns exactly one verdict:
 *   ACCEPT  p50 improves by at least the declared margin, every decision
 *           matches, and max probability drift is within the declared tolerance.
 *   REJECT  any decision differs, drift exceeds tolerance, any call failed,
 *           timed out or produced an invalid timing, or nothing was measured.
 *   NO WIN  answers hold, but the improvement is below the materiality floor
 *           or below the declared margin.
 * Thresholds must be passed explicitly. There are no defaults that could pass.
 * Model output is only parsed and compared; nothing in it is executed or read
 * as an instruction, so it cannot change the verdict logic.
 *
 * Off unless EIGHT_SPEED_GATE=1. Does NOT: repeat runs to estimate noise,
 * measure capability beyond decision agreement on this suite, or change any
 * model setting. Its numbers are for this machine and this suite only.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { loadRecentTraffic } from "./canary-measure";
import { type ModelTarget, callModel } from "./validate-holdout";

export type Caller = (target: ModelTarget, prompt: string) => Promise<string | null>;
export type Verdict = "ACCEPT" | "REJECT" | "NO WIN";

export interface Thresholds {
	/** ACCEPT needs p50 to improve by at least this percent. */
	minImprovementPct: number;
	/** Improvement below this percent is NO WIN. Must be <= minImprovementPct. */
	materialityPct: number;
	/** Max allowed |probability(baseline) - probability(candidate)|. */
	maxDrift: number;
}

export interface Sample {
	ok: boolean;
	error?: string;
	decision?: string;
	probability?: number;
	latencyMs?: number;
}

export interface GateReport {
	verdict: Verdict;
	reasons: string[];
	thresholds: Thresholds;
	inputs: number;
	failures: number;
	decisionMismatches: number;
	maxDrift: number | null;
	baselineP50Ms: number | null;
	candidateP50Ms: number | null;
	improvementPct: number | null;
	perInput: { index: number; baseline: Sample; candidate: Sample; drift: number | null }[];
}

const MAX_DECISION_CHARS = 2000;

/** Defensive parse of untrusted model output. JSON {decision, probability} or plain text. */
export function parseOutput(raw: string): { decision: string; probability?: number } {
	let decision: unknown = raw;
	let probability: number | undefined;
	try {
		const obj: unknown = JSON.parse(raw);
		if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
			const rec = obj as Record<string, unknown>;
			if (Object.hasOwn(rec, "decision")) decision = rec.decision;
			const p = Object.hasOwn(rec, "probability") ? rec.probability : undefined;
			if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) probability = p;
		}
	} catch {
		// plain text output: the whole string is the decision
	}
	const text = typeof decision === "string" ? decision : (JSON.stringify(decision) ?? "");
	return {
		decision: text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_DECISION_CHARS),
		probability,
	};
}

export function p50(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timed(
	call: Caller,
	target: ModelTarget,
	prompt: string,
	timeoutMs: number,
	now: () => number,
): Promise<Sample> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
	});
	const start = now();
	try {
		const out = await Promise.race([call(target, prompt), timeout]);
		const latencyMs = now() - start;
		if (typeof out !== "string") return { ok: false, error: "caller returned no output" };
		if (!Number.isFinite(latencyMs) || latencyMs < 0)
			return { ok: false, error: `invalid timing ${latencyMs}` };
		return { ok: true, latencyMs, ...parseOutput(out) };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) };
	} finally {
		clearTimeout(timer);
	}
}

/** Paired run: the same inputs, sides called one at a time, order alternated per input. */
export async function runPaired(opts: {
	baseline: ModelTarget;
	candidate: ModelTarget;
	prompts: string[];
	caller?: Caller;
	timeoutMs: number;
	now?: () => number;
}): Promise<{ baseline: Sample[]; candidate: Sample[] }> {
	const call = opts.caller ?? ((t, p) => callModel(t, p, opts.timeoutMs));
	const now = opts.now ?? (() => performance.now());
	const baseline: Sample[] = [];
	const candidate: Sample[] = [];
	for (const [i, prompt] of opts.prompts.entries()) {
		if (i % 2 === 0) {
			baseline.push(await timed(call, opts.baseline, prompt, opts.timeoutMs, now));
			candidate.push(await timed(call, opts.candidate, prompt, opts.timeoutMs, now));
		} else {
			candidate.push(await timed(call, opts.candidate, prompt, opts.timeoutMs, now));
			baseline.push(await timed(call, opts.baseline, prompt, opts.timeoutMs, now));
		}
	}
	return { baseline, candidate };
}

export function validateThresholds(t: Partial<Thresholds>): string | null {
	for (const k of ["minImprovementPct", "materialityPct", "maxDrift"] as const) {
		const v = t[k];
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
			return `${k} must be declared as a finite number >= 0`;
	}
	if ((t.materialityPct as number) > (t.minImprovementPct as number))
		return "materialityPct must be <= minImprovementPct";
	return null;
}

/** Pure verdict over paired samples. Fails closed on anything it cannot judge. */
export function judge(baseline: Sample[], candidate: Sample[], t: Thresholds): GateReport {
	const reasons: string[] = [];
	const bad = validateThresholds(t);
	if (bad) reasons.push(`invalid thresholds: ${bad}`);
	if (baseline.length !== candidate.length)
		reasons.push(`mismatched lengths: baseline ${baseline.length}, candidate ${candidate.length}`);
	if (baseline.length === 0) reasons.push("empty suite: nothing measured");
	const n = Math.min(baseline.length, candidate.length);
	let failures = 0;
	let mismatches = 0;
	let maxDrift: number | null = null;
	const perInput: GateReport["perInput"] = [];
	for (let i = 0; i < n; i++) {
		const b = baseline[i];
		const c = candidate[i];
		let drift: number | null = null;
		if (!b.ok || !c.ok) failures++;
		else {
			if (b.decision !== c.decision) mismatches++;
			if ((b.probability === undefined) !== (c.probability === undefined)) {
				drift = Number.POSITIVE_INFINITY; // one side lost its probability: unmeasurable, fail closed
			} else if (b.probability !== undefined && c.probability !== undefined) {
				drift = Math.abs(b.probability - c.probability);
			}
			if (drift !== null) maxDrift = Math.max(maxDrift ?? 0, drift);
		}
		perInput.push({ index: i, baseline: b, candidate: c, drift });
	}
	if (failures > 0)
		reasons.push(`${failures} paired input(s) had a failed, timed-out or invalid call`);
	if (mismatches > 0) reasons.push(`${mismatches} decision(s) changed`);
	if (maxDrift !== null && maxDrift > t.maxDrift)
		reasons.push(`max drift ${maxDrift} exceeds tolerance ${t.maxDrift}`);
	const lat = (s: Sample[]) =>
		s.filter((x) => x.ok && typeof x.latencyMs === "number").map((x) => x.latencyMs as number);
	const bP50 = p50(lat(baseline));
	const cP50 = p50(lat(candidate));
	const improvementPct =
		bP50 !== null && cP50 !== null && bP50 > 0 ? ((bP50 - cP50) / bP50) * 100 : null;
	if (reasons.length === 0 && improvementPct === null)
		reasons.push("p50 improvement not computable");
	let verdict: Verdict = "REJECT";
	if (reasons.length === 0 && improvementPct !== null) {
		if (improvementPct < t.materialityPct) {
			verdict = "NO WIN";
			reasons.push(
				`improvement ${improvementPct.toFixed(2)}% is below materiality ${t.materialityPct}%`,
			);
		} else if (improvementPct < t.minImprovementPct) {
			verdict = "NO WIN";
			reasons.push(
				`improvement ${improvementPct.toFixed(2)}% is below declared margin ${t.minImprovementPct}%`,
			);
		} else {
			verdict = "ACCEPT";
			reasons.push(
				`p50 ${bP50} -> ${cP50} ms (${improvementPct.toFixed(2)}%), ${n}/${n} decisions match`,
			);
		}
	}
	return {
		verdict,
		reasons,
		thresholds: t,
		inputs: n,
		failures,
		decisionMismatches: mismatches,
		maxDrift,
		baselineP50Ms: bP50,
		candidateP50Ms: cP50,
		improvementPct,
		perInput,
	};
}

export const EXIT = { ACCEPT: 0, REJECT: 1, "NO WIN": 2, OFF: 3, USAGE: 4 } as const;

function loadTarget(path: string, label: string): ModelTarget {
	const obj = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	if (typeof obj.url !== "string" || typeof obj.model !== "string")
		throw new Error(`${path}: needs string "url" and "model"`);
	return {
		url: obj.url,
		model: obj.model,
		label: typeof obj.label === "string" ? obj.label : label,
	};
}

/** CLI entry. Returns the exit code; the caller and clock are injectable for tests. */
export async function main(
	argv: string[],
	env: Record<string, string | undefined>,
	caller?: Caller,
	now?: () => number,
): Promise<number> {
	if (env.EIGHT_SPEED_GATE !== "1") {
		console.error("speed-gate is off. Set EIGHT_SPEED_GATE=1 to run it. Nothing was run.");
		return EXIT.OFF;
	}
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) {
			console.error(`bad argument near "${argv[i]}"`);
			return EXIT.USAGE;
		}
		args[argv[i].slice(2)] = argv[i + 1];
	}
	const num = (k: string) =>
		args[k] === undefined || args[k].trim() === "" ? Number.NaN : Number(args[k]);
	const thresholds = {
		minImprovementPct: num("min-improvement"),
		materialityPct: num("materiality"),
		maxDrift: num("max-drift"),
	};
	const timeoutMs = num("timeout-ms");
	const bad =
		validateThresholds(thresholds) ??
		(!(timeoutMs > 0) ? "timeout-ms must be declared as a number > 0" : null);
	if (!args.baseline || !args.candidate || !args.suite || bad) {
		console.error(
			`usage: EIGHT_SPEED_GATE=1 bun benchmarks/autoresearch/speed-gate.ts --baseline <cfg.json> --candidate <cfg.json> --suite <suite.jsonl> --min-improvement <pct> --materiality <pct> --max-drift <abs> --timeout-ms <ms> [--out <report.json>]${bad ? `\n${bad}` : ""}`,
		);
		return EXIT.USAGE;
	}
	let baseline: ModelTarget;
	let candidate: ModelTarget;
	try {
		baseline = loadTarget(args.baseline, "baseline");
		candidate = loadTarget(args.candidate, "candidate");
	} catch (err) {
		console.error(`config error: ${err instanceof Error ? err.message : err}`);
		return EXIT.USAGE;
	}
	const prompts = loadRecentTraffic(args.suite, 0).map((t) => t.prompt);
	const samples = await runPaired({ baseline, candidate, prompts, caller, timeoutMs, now });
	const report = judge(samples.baseline, samples.candidate, thresholds);
	const out = args.out ?? "speed-gate-report.json";
	writeFileSync(
		out,
		`${JSON.stringify({ baseline, candidate, suite: args.suite, ...report }, null, 2)}\n`,
	);
	console.log(`${report.verdict}: ${report.reasons.join("; ")}\nreport: ${out}`);
	return EXIT[report.verdict];
}

if (import.meta.main) {
	main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
