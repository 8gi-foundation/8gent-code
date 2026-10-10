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
 * Determinism: the gate's own caller posts to {origin}/api/chat (Ollama and the
 * 8gent provider only) with format "json", temperature 0 and a fixed seed
 * (recorded in the report), under a fixed system prompt asking for
 * {"decision": <one short label>, "probability": <0..1>}. Suite prompts must
 * name a fixed label set (e.g. "Answer yes or no."), or free-text decisions
 * will differ and REJECT. One untimed warm-up call per side runs before timing.
 *
 * Safety: a target must be an http(s) origin with no credentials, query,
 * fragment or path. Only loopback hosts are allowed unless --allow-remote is
 * passed; link-local hosts (169.254.0.0/16, fe80::/10), the AWS IPv6
 * metadata range (fd00:ec2::/32) and any IPv6 form that embeds an IPv4 address
 * (mapped, compatible, translated, NAT64 64:ff9b::/96 and 64:ff9b:1::/48)
 * other than 127/8 are always refused. 6to4 (2002::/16) is not covered.
 * Hostnames are not resolved, so a name pointing at an internal address is not
 * blocked under --allow-remote.
 * Redirects are refused, and a reply body over 64 KiB is a failed call. An
 * empty, non-string or over-64-char decision is a failed call. Exit 5 means a
 * crash or I/O error, never a verdict.
 *
 * Off unless EIGHT_SPEED_GATE=1. Does NOT: serve Marlin (JSON-RPC over stdio)
 * or moshi-mlx (websocket), which need their own callers; repeat runs to
 * estimate noise (one timed sample per input); measure capability beyond
 * decision agreement on this suite; or change any model setting. The
 * probability is the model's self-report, not a scorer probability read from
 * logits. Its numbers are for this machine and this suite only.
 */

import {
	lstatSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadRecentTraffic } from "./canary-measure";
import type { ModelTarget } from "./validate-holdout";

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
	/** Largest finite drift; null when none was measured or it is unmeasurable. */
	maxDrift: number | null;
	/** True when a probability was present on only one side of some input. */
	maxDriftUnmeasurable: boolean;
	/** False when no input carried a probability on either side, so drift was never checked. */
	driftChecked: boolean;
	sampling: {
		samplesPerInput: 1;
		baselineTimedSamples: number;
		candidateTimedSamples: number;
		warnings: string[];
	};
	baselineP50Ms: number | null;
	candidateP50Ms: number | null;
	improvementPct: number | null;
	perInput: {
		index: number;
		baseline: Sample;
		candidate: Sample;
		drift: number | null;
		driftUnmeasurable?: true;
	}[];
}

export const MAX_DECISION_CHARS = 64;
export const MAX_REPLY_BYTES = 64 * 1024;
export const MAX_SUITE_BYTES = 1024 * 1024;
export const MAX_SUITE_PROMPTS = 1000;
export const MAX_TIMEOUT_MS = 2147483647;
export const MIN_SUITE_FOR_CONFIDENCE = 20;
export const DEFAULT_SEED = 8;
export const GATE_SYSTEM_PROMPT =
	'Answer with JSON only: {"decision": "<one short label from the labels the question allows>", "probability": <your confidence in that label, a number from 0 to 1>}. No other text.';

/** The gate's own /api/chat caller: deterministic decoding, JSON output. Shared callModel is untouched. */
export function gateCaller(
	seed: number,
	timeoutMs: number,
	fetchImpl: typeof fetch = fetch,
): Caller {
	return async (target, prompt) => {
		try {
			const res = await fetchImpl(`${target.url}/api/chat`, {
				method: "POST",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: target.model,
					messages: [
						{ role: "system", content: GATE_SYSTEM_PROMPT },
						{ role: "user", content: prompt },
					],
					stream: false,
					format: "json",
					options: { temperature: 0, seed },
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok || !res.body) return null;
			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (let r = await reader.read(); !r.done; r = await reader.read()) {
				size += r.value.byteLength;
				if (size > MAX_REPLY_BYTES) {
					await reader.cancel();
					return null; // over the cap: a failed call, never a truncated answer
				}
				chunks.push(r.value);
			}
			const data = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
				message?: { content?: unknown };
			} | null;
			return typeof data?.message?.content === "string" ? data.message.content : null;
		} catch {
			return null;
		}
	};
}

/**
 * Defensive parse of untrusted model output: JSON {decision, probability} or
 * plain text. Cut to the byte cap first, then only linear scans. An empty,
 * missing, non-string or over-long decision is an error, never a decision.
 */
export function parseOutput(raw: string): {
	decision?: string;
	probability?: number;
	error?: string;
} {
	let body = raw.slice(0, MAX_REPLY_BYTES).trim();
	if (body.startsWith("```")) {
		const nl = body.indexOf("\n");
		body = nl === -1 ? body.slice(3) : body.slice(nl + 1);
		if (body.endsWith("```")) body = body.slice(0, -3);
		body = body.trim();
	}
	let decision: unknown = body;
	let probability: number | undefined;
	try {
		const obj: unknown = JSON.parse(body);
		if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
			const rec = obj as Record<string, unknown>;
			decision = Object.hasOwn(rec, "decision") ? rec.decision : undefined;
			const p = Object.hasOwn(rec, "probability") ? rec.probability : undefined;
			if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) probability = p;
		}
	} catch {
		// plain text output: the whole string is the decision
	}
	if (typeof decision !== "string") return { error: "reply has no string decision" };
	const text = decision.trim().toLowerCase().replace(/\s+/g, " ");
	let end = text.length;
	while (end > 0 && ".!?,;: ".includes(text[end - 1])) end--;
	if (end === 0) return { error: "reply has an empty decision" };
	if (end > MAX_DECISION_CHARS)
		return { error: `decision longer than ${MAX_DECISION_CHARS} chars` };
	return { decision: text.slice(0, end), probability };
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
	// Read the clock before arming the timer: a clock that throws must not leave
	// a live timer whose rejection nobody handles.
	const start = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
	});
	try {
		const out = await Promise.race([call(target, prompt), timeout]);
		const latencyMs = now() - start;
		if (typeof out !== "string") return { ok: false, error: "caller returned no output" };
		if (!Number.isFinite(latencyMs) || latencyMs < 0)
			return { ok: false, error: `invalid timing ${latencyMs}` };
		const parsed = parseOutput(out);
		if (parsed.error !== undefined) return { ok: false, error: parsed.error };
		return { ok: true, latencyMs, decision: parsed.decision, probability: parsed.probability };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Paired run: one untimed warm-up call per side, then the same inputs, sides
 * called one at a time, order alternated per input.
 */
export async function runPaired(opts: {
	baseline: ModelTarget;
	candidate: ModelTarget;
	prompts: string[];
	caller?: Caller;
	timeoutMs: number;
	seed?: number;
	now?: () => number;
}): Promise<{
	baseline: Sample[];
	candidate: Sample[];
	warmUp: { baseline: boolean; candidate: boolean };
}> {
	const call = opts.caller ?? gateCaller(opts.seed ?? DEFAULT_SEED, opts.timeoutMs);
	const now = opts.now ?? (() => performance.now());
	const baseline: Sample[] = [];
	const candidate: Sample[] = [];
	const warmUp = { baseline: false, candidate: false };
	if (opts.prompts.length > 0) {
		const free = () => 0; // warm-up is never timed
		warmUp.baseline = (await timed(call, opts.baseline, opts.prompts[0], opts.timeoutMs, free)).ok;
		warmUp.candidate = (
			await timed(call, opts.candidate, opts.prompts[0], opts.timeoutMs, free)
		).ok;
	}
	for (const [i, prompt] of opts.prompts.entries()) {
		if (i % 2 === 0) {
			baseline.push(await timed(call, opts.baseline, prompt, opts.timeoutMs, now));
			candidate.push(await timed(call, opts.candidate, prompt, opts.timeoutMs, now));
		} else {
			candidate.push(await timed(call, opts.candidate, prompt, opts.timeoutMs, now));
			baseline.push(await timed(call, opts.baseline, prompt, opts.timeoutMs, now));
		}
	}
	return { baseline, candidate, warmUp };
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
	let unmeasurable = false;
	let driftChecked = false;
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
			if (drift !== null) driftChecked = true;
			if (drift === Number.POSITIVE_INFINITY) unmeasurable = true;
			else if (drift !== null) maxDrift = Math.max(maxDrift ?? 0, drift);
		}
		perInput.push(
			drift === Number.POSITIVE_INFINITY
				? { index: i, baseline: b, candidate: c, drift: null, driftUnmeasurable: true }
				: { index: i, baseline: b, candidate: c, drift },
		);
	}
	if (failures > 0)
		reasons.push(`${failures} paired input(s) had a failed, timed-out or invalid call`);
	if (mismatches > 0) reasons.push(`${mismatches} decision(s) changed`);
	if (unmeasurable) reasons.push("drift unmeasurable: a probability was present on only one side");
	if (maxDrift !== null && maxDrift > t.maxDrift)
		reasons.push(`max drift ${maxDrift} exceeds tolerance ${t.maxDrift}`);
	const lat = (s: Sample[]) =>
		s.filter((x) => x.ok && typeof x.latencyMs === "number").map((x) => x.latencyMs as number);
	const bLat = lat(baseline);
	const cLat = lat(candidate);
	const bP50 = p50(bLat);
	const cP50 = p50(cLat);
	const warnings =
		n < MIN_SUITE_FOR_CONFIDENCE
			? [
					`suite has ${n} inputs, fewer than ${MIN_SUITE_FOR_CONFIDENCE}: p50 from one sample per input is noisy`,
				]
			: [];
	if (n > failures && !driftChecked)
		warnings.push("no input carried a probability on either side: drift was not checked");
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
		maxDriftUnmeasurable: unmeasurable,
		driftChecked,
		sampling: {
			samplesPerInput: 1,
			baselineTimedSamples: bLat.length,
			candidateTimedSamples: cLat.length,
			warnings,
		},
		baselineP50Ms: bP50,
		candidateP50Ms: cP50,
		improvementPct,
		perInput,
	};
}

export const EXIT = { ACCEPT: 0, REJECT: 1, "NO WIN": 2, OFF: 3, USAGE: 4, ERROR: 5 } as const;

export class UsageError extends Error {}

/** Load and validate a target config. Throws UsageError on anything unsafe. */
export function loadTarget(path: string, label: string, allowRemote: boolean): ModelTarget {
	let obj: Record<string, unknown> | null;
	try {
		obj = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown> | null;
	} catch {
		throw new UsageError(`${path}: cannot read config JSON`);
	}
	if (typeof obj?.url !== "string" || typeof obj.model !== "string")
		throw new UsageError(`${path}: needs string "url" and "model"`);
	let u: URL;
	try {
		u = new URL(obj.url);
	} catch {
		throw new UsageError(`${path}: url is not a valid URL`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		throw new UsageError(`${path}: url must be http or https`);
	if (u.username || u.password) throw new UsageError(`${path}: url must not carry credentials`);
	if (obj.url.includes("?") || obj.url.includes("#"))
		throw new UsageError(`${path}: url must not have a query or fragment`);
	if (u.pathname !== "/") throw new UsageError(`${path}: url must be an origin with no path`);
	const host = u.hostname.toLowerCase();
	// IPv6 that embeds an IPv4 address: ::a.b.c.d, ::ffff:a.b.c.d, ::ffff:0:a.b.c.d, 64:ff9b::a.b.c.d, 64:ff9b:1::/48
	const embedded =
		/^\[(?:::(?:ffff:(?:0:)?)?|64:ff9b::|64:ff9b:1:(?:[0-9a-f]{0,4}:)+)([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(
			host,
		);
	const embeddedLoopback =
		embedded !== null && /^7f[0-9a-f]{2}$/.test(embedded[1].padStart(4, "0"));
	if (
		/^169\.254\./.test(host) ||
		/^\[fe[89ab]/.test(host) ||
		host.startsWith("[fd00:ec2:") ||
		(embedded !== null && !embeddedLoopback)
	)
		throw new UsageError(`${path}: link-local, metadata or IPv4-embedded host ${host} is refused`);
	const loopback =
		host === "localhost" ||
		host === "[::1]" ||
		embeddedLoopback ||
		/^127\.\d+\.\d+\.\d+$/.test(host);
	if (!loopback) {
		if (!allowRemote)
			throw new UsageError(`${path}: ${host} is not loopback; pass --allow-remote to use it`);
		console.error(
			`remote host allowed for ${label}: ${host} (hostnames are not resolved; a name pointing at an internal address is not blocked)`,
		);
	}
	const name = typeof obj.label === "string" ? obj.label.slice(0, 64) : label;
	return { url: u.origin, model: obj.model, label: name };
}

/** Validate the suite file strictly, then load it with the canary traffic loader. */
export function loadSuite(path: string): string[] {
	let size: number;
	try {
		const st = statSync(path);
		if (!st.isFile()) throw new UsageError(`suite ${path} is not a regular file`);
		size = st.size;
	} catch (err) {
		throw err instanceof UsageError ? err : new UsageError(`suite ${path} cannot be read`);
	}
	if (size > MAX_SUITE_BYTES) throw new UsageError(`suite is over ${MAX_SUITE_BYTES} bytes`);
	let count = 0;
	for (const [i, line] of readFileSync(path, "utf-8").split("\n").entries()) {
		if (!line.trim()) continue;
		let prompt: unknown;
		try {
			prompt = (JSON.parse(line) as Record<string, unknown> | null)?.prompt;
		} catch {
			throw new UsageError(`suite line ${i + 1} is not valid JSON`);
		}
		if (typeof prompt !== "string" || prompt.length === 0)
			throw new UsageError(`suite line ${i + 1} has no string "prompt"`);
		count++;
	}
	if (count === 0) throw new UsageError(`suite ${path} has no prompts`);
	if (count > MAX_SUITE_PROMPTS)
		throw new UsageError(`suite has over ${MAX_SUITE_PROMPTS} prompts`);
	const prompts = loadRecentTraffic(path, 0).map((t) => t.prompt);
	if (prompts.length !== count) throw new UsageError("suite changed while it was being read");
	return prompts;
}

/** Refuse an --out that is an input, a symlink, or not a regular file. */
function checkOut(out: string, inputs: string[]): void {
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			try {
				return join(realpathSync(dirname(p)), basename(p));
			} catch {
				return resolve(p);
			}
		}
	};
	if (inputs.some((p) => real(p) === real(out)))
		throw new UsageError("--out must not be an input file");
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(out);
	} catch {
		return; // absent is fine
	}
	if (st.isSymbolicLink() || !st.isFile())
		throw new UsageError("--out must not be a symlink, directory or special file");
}

/** Write a 0600 temp file in the same directory, then rename it over the target. */
function writeReport(out: string, text: string): void {
	const tmp = join(dirname(out), `.${basename(out)}.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		renameSync(tmp, out);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

const USAGE =
	"usage: EIGHT_SPEED_GATE=1 bun benchmarks/autoresearch/speed-gate.ts --baseline <cfg.json> --candidate <cfg.json> --suite <suite.jsonl> --min-improvement <pct> --materiality <pct> --max-drift <abs> --timeout-ms <ms> [--seed <int>] [--out <report.json>] [--allow-remote]";

async function run(argv: string[], caller?: Caller, now?: () => number): Promise<number> {
	const args: Record<string, string> = {};
	let allowRemote = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--allow-remote") {
			allowRemote = true;
			continue;
		}
		if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
			throw new UsageError(`bad argument near "${argv[i]}"`);
		args[argv[i].slice(2)] = argv[i + 1];
		i++;
	}
	const num = (k: string) =>
		args[k] === undefined || args[k].trim() === "" ? Number.NaN : Number(args[k]);
	const thresholds = {
		minImprovementPct: num("min-improvement"),
		materialityPct: num("materiality"),
		maxDrift: num("max-drift"),
	};
	const timeoutMs = num("timeout-ms");
	const seed = args.seed === undefined ? DEFAULT_SEED : num("seed");
	const bad =
		validateThresholds(thresholds) ??
		(!(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)
			? `timeout-ms must be declared, > 0 and <= ${MAX_TIMEOUT_MS}`
			: null) ??
		(!Number.isSafeInteger(seed) ? "seed must be an integer" : null) ??
		(!args.baseline || !args.candidate || !args.suite
			? "--baseline, --candidate and --suite are required"
			: null);
	if (bad) throw new UsageError(bad);
	const out = args.out ?? "speed-gate-report.json";
	checkOut(out, [args.baseline, args.candidate, args.suite]);
	const prompts = loadSuite(args.suite);
	const baseline = loadTarget(args.baseline, "baseline", allowRemote);
	const candidate = loadTarget(args.candidate, "candidate", allowRemote);
	const samples = await runPaired({ baseline, candidate, prompts, caller, timeoutMs, seed, now });
	const report = judge(samples.baseline, samples.candidate, thresholds);
	for (const side of ["baseline", "candidate"] as const) {
		if (!samples.warmUp[side])
			report.sampling.warnings.push(
				`${side} warm-up failed: its first timed call likely includes model load`,
			);
	}
	console.log(`${report.verdict}: ${report.reasons.join("; ")}`);
	for (const w of report.sampling.warnings) console.log(`warning: ${w}`);
	const decoding = { endpoint: "/api/chat", format: "json", temperature: 0, seed };
	const warmUp = { untimedCallsPerSide: 1, ok: samples.warmUp };
	const full = { baseline, candidate, suite: args.suite, decoding, warmUp, ...report };
	try {
		writeReport(out, `${JSON.stringify(full, null, 2)}\n`);
	} catch (err) {
		console.error(`report write failed: ${err instanceof Error ? err.message : err}`);
		return EXIT.ERROR;
	}
	console.log(`report: ${out}`);
	return EXIT[report.verdict];
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
	try {
		return await run(argv, caller, now);
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(`${USAGE}\n${err.message}`);
			return EXIT.USAGE;
		}
		console.error(`speed-gate error: ${err instanceof Error ? err.message : err}`);
		return EXIT.ERROR;
	}
}

if (import.meta.main) {
	main(process.argv.slice(2), process.env).then(
		(code) => process.exit(code),
		() => process.exit(EXIT.ERROR),
	);
}
