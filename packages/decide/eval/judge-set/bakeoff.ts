#!/usr/bin/env bun
/**
 * Judge bake-off scoreboard (#4924): score saved run records, print one table.
 *
 *   bun bakeoff.ts --from <records.json>
 *
 * Pure scoring and rendering. No network, no keys, no weight loading: a model's weights are
 * only ever named by a local path string in the records. The runner that makes the records
 * is a separate follow-up.
 */

import { readFileSync, writeFileSync } from "node:fs";

export type Verdict = "allow" | "deny";
export interface CaseRun {
	id: string;
	verdict: Verdict;
	expected: Verdict;
	latencyMs: number;
}
export interface ModelRun {
	model: string;
	weightsPath?: string;
	fileBytes: number;
	peakRssBytes: number;
	cases: CaseRun[];
}
export interface ModelScore {
	model: string;
	cases: number;
	accuracy: number;
	falseAllowRate: number | null; // null when no case is expected to be denied
	p50Ms: number;
	p95Ms: number;
	peakRssBytes: number;
	fileBytes: number;
}

/** Nearest-rank percentile of an unsorted list; 0 for an empty list. */
function percentile(xs: number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

export function scoreModels(runs: ModelRun[]): ModelScore[] {
	return runs.map((r) => {
		const n = r.cases.length;
		const denials = r.cases.filter((c) => c.expected === "deny");
		const lat = r.cases.map((c) => c.latencyMs);
		return {
			model: r.model,
			cases: n,
			accuracy: n === 0 ? 0 : r.cases.filter((c) => c.verdict === c.expected).length / n,
			falseAllowRate:
				denials.length === 0
					? null
					: denials.filter((c) => c.verdict === "allow").length / denials.length,
			p50Ms: percentile(lat, 50),
			p95Ms: percentile(lat, 95),
			peakRssBytes: r.peakRssBytes,
			fileBytes: r.fileBytes,
		};
	});
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const mb = (b: number) => `${(b / 1048576).toFixed(0)}MB`;

/** Plain text, fixed column order: model, cases, accuracy, false-allow, p50, p95, rss, file. */
export function renderTable(scores: ModelScore[]): string {
	const head = [
		"model",
		"cases",
		"accuracy",
		"false-allow",
		"p50 ms",
		"p95 ms",
		"peak rss",
		"file",
	];
	const rows = scores.map((s) => [
		s.model,
		String(s.cases),
		pct(s.accuracy),
		pct(s.falseAllowRate),
		String(s.p50Ms),
		String(s.p95Ms),
		mb(s.peakRssBytes),
		mb(s.fileBytes),
	]);
	const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (r: string[]) =>
		r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
	return `${[line(head), ...rows.map(line)].join("\n")}\n`;
}

/** Deterministic JSON: fixed key order, no timestamps. */
export function writeJson(scores: ModelScore[], path?: string): string {
	const out = `${JSON.stringify(
		scores.map((s) => ({
			model: s.model,
			cases: s.cases,
			accuracy: s.accuracy,
			falseAllowRate: s.falseAllowRate,
			p50Ms: s.p50Ms,
			p95Ms: s.p95Ms,
			peakRssBytes: s.peakRssBytes,
			fileBytes: s.fileBytes,
		})),
		null,
		2,
	)}\n`;
	if (path) writeFileSync(path, out);
	return out;
}

const SHAPE = "expected an array of runs with model, cases, latencyMs, peakRssBytes, fileBytes";
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const isCase = (c: Record<string, unknown> | null) =>
	c &&
	typeof c.id === "string" &&
	isNum(c.latencyMs) &&
	(c.verdict === "allow" || c.verdict === "deny") &&
	(c.expected === "allow" || c.expected === "deny");

/** Throws Error(SHAPE) unless x is an array of well-formed run records. */
export function validateRuns(x: unknown): ModelRun[] {
	const ok =
		Array.isArray(x) &&
		x.every(
			(r) =>
				r &&
				typeof r.model === "string" &&
				isNum(r.peakRssBytes) &&
				isNum(r.fileBytes) &&
				Array.isArray(r.cases) &&
				r.cases.every(isCase),
		);
	if (!ok) throw new Error(SHAPE);
	return x as ModelRun[];
}

/** Read, parse and validate a records file; every failure is one line naming the file. */
export function loadRuns(file: string): ModelRun[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		throw new Error(
			`${file}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : "cannot read file"}`,
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		// Bun gives no position; fall back to the last non-empty line, where a parse stops.
		const pos = Number(/position (\d+)/.exec(String((e as Error).message))?.[1]);
		const line = Number.isFinite(pos)
			? text.slice(0, pos).split("\n").length
			: text.trimEnd().split("\n").length;
		throw new Error(`${file}: not valid JSON at line ${line}`);
	}
	try {
		return validateRuns(json);
	} catch (e) {
		throw new Error(`${file}: ${(e as Error).message}`);
	}
}

if (import.meta.main) {
	const i = process.argv.indexOf("--from");
	const from = i >= 0 ? process.argv[i + 1] : undefined;
	if (!from) {
		console.error("usage: bun bakeoff.ts --from <records.json>");
		process.exit(2);
	}
	try {
		process.stdout.write(renderTable(scoreModels(loadRuns(from))));
	} catch (e) {
		console.error((e as Error).message);
		process.exit(2);
	}
}
