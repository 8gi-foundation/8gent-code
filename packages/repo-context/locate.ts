/**
 * locateCode(question): plain question in, a few passages with file:line out.
 * Trial for #3427, behind EIGHT_LOCATE=1. Concept from dzhng/jevgrep (MIT):
 * narrow folders, then files, then passages. No code from it is used.
 *
 * Deterministic narrowing, every step bounded:
 *   1. terms    the question split on whitespace, each token cut to letters and
 *               digits, stop words dropped, a light suffix stem, at most 12.
 *   2. files    one literal, case-blind `rg -l --null` per term (argv, never a
 *               shell); rarer terms weigh more; a file scores more when a term
 *               is in its path or in one of its declarations (ast-index). Every
 *               path must resolve inside the root, real path included.
 *   3. folders  files grouped by their top two path segments; only the best
 *               folders keep their files.
 *   4. passage  in each kept file, the line holding the most distinct terms
 *               (comment and string-literal lines count less), shown with a
 *               few lines around it and its enclosing declaration.
 *
 * Optional judge: ONE local System One choice call (packages/decide) over the
 * top files' previews, under a time cap. Every host the decider could reach
 * (shared judge, Ollama, Laya) must be loopback before it is built, and its
 * fetch refuses any other URL at request time. In-process llama.cpp is off
 * here: it cannot be aborted inside the time cap. Any failure keeps the
 * deterministic order. Everything shown or sent to the judge is scrubbed.
 *
 * Reached through the existing `locate` tool: with EIGHT_LOCATE=1 its prose
 * route (rule 6, hybrid) answers from here (packages/ast-index/locate.ts).
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import * as path from "node:path";
import { getFileOutline, searchSymbols } from "../ast-index/index";
import { runRg } from "../ast-index/locate";
import type { Decider } from "../decide/index";
import { scrub } from "../eight/secret-scanner";

export const LOCATE_CODE_FLAG = "EIGHT_LOCATE";
export const MAX_QUESTION_CHARS = 2000;
export const MAX_TERM_CHARS = 40;
export const MAX_TERMS = 12;
export const MAX_RESULTS = 3;
/** One System One choice call per question; the brief's ceiling was three. */
export const MAX_MODEL_CALLS = 1;
export const JUDGE_TIMEOUT_MS = 4000;
/** Whole-call budget: text search stops adding terms past it, the judge gets what is left. */
export const TOTAL_BUDGET_MS = 8000;
const JUDGE_OPTIONS = 6;
const KEEP_FOLDERS = 4;
const PASSAGE_BEFORE = 2;
const PASSAGE_AFTER = 5;
const LINE_MAX = 160;
const FILE_MAX_BYTES = 1_000_000;
const CODE_GLOB = "*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go}";

const STOP = new Set(
	"the a an is are was were be been even though just only still some any all also very much many of to in on at by for from with and or not no it its this that these those where what which who how why when does do did done can could should would will get gets got there here into out about after before over under then than our your my we you they i me file files code function functions method class line lines".split(
		" ",
	),
);
const SUFFIXES = ["ations", "ation", "ings", "ing", "ers", "er", "ed", "es", "s", "ly"];

export function locateCodeEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env[LOCATE_CODE_FLAG] === "1";
}

/** Fixed suffix strip, then a trailing i/e or doubled letter: classified -> classif, scrubbed -> scrub. */
function stemOf(word: string): string {
	let stem = word;
	let cut = "";
	for (const s of SUFFIXES) {
		if (stem.length - s.length >= 3 && stem.endsWith(s)) {
			stem = stem.slice(0, -s.length);
			cut = s;
			break;
		}
	}
	if (cut.length < 2) return stem;
	if (stem.length > 4 && /[ie]$/.test(stem)) stem = stem.slice(0, -1);
	if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
	return stem;
}

/** Linear in the input: one whitespace split, per-token char filter, fixed suffix list. */
export function questionTerms(question: string): string[] {
	const out: string[] = [];
	for (const raw of (question ?? "").slice(0, MAX_QUESTION_CHARS).split(/\s+/)) {
		if (raw.length === 0 || raw.length > MAX_TERM_CHARS) continue;
		// "50-call" and "repo/context" give their parts; each part is short.
		for (const word of raw
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, " ")
			.split(" ")) {
			if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
			const stem = stemOf(word);
			if (!out.includes(stem)) out.push(stem);
			if (out.length >= MAX_TERMS) return out;
		}
	}
	return out;
}

export interface Passage {
	file: string;
	line: number;
	/** Enclosing declaration from the AST index, when there is one. */
	symbol?: string;
	/** The matched line, scrubbed and capped. */
	text: string;
	/** A few lines around it, each scrubbed and capped. */
	excerpt: string;
	score: number;
}

export interface LocateCodeResult {
	question: string;
	terms: string[];
	passages: Passage[];
	judge: { used: boolean; calls: number; note: string };
	ms: number;
}

/** Answer to one System One choice: a probability per option. */
export type Judge = (question: string, options: string[]) => Promise<number[]>;

export interface LocateCodeOptions {
	root: string;
	/** AST index id for root, or null to skip declaration scoring. */
	repoId: string | null;
	/** undefined: the local System One when loopback-only; null: no model. */
	judge?: Judge | null;
	judgeTimeoutMs?: number;
	env?: Record<string, string | undefined>;
	/** ripgrep binary. Default "rg" from PATH. */
	rg?: string;
}

/** Scrub, then cut: a secret is never half-shown by the cut. */
function cleanLine(line: string): string {
	const l = scrub(line).scrubbed;
	return l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}...` : l;
}

/**
 * The repo-relative "/" path for an rg result, or null when it resolves
 * outside the root (a "..", an absolute path, or a symlink out).
 */
export function insideRoot(root: string, file: string): string | null {
	if (!file || file.includes("\0")) return null;
	const resolved = path.resolve(root, file);
	const rel = path.relative(root, resolved);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	try {
		const realRoot = realpathSync(root);
		const real = path.relative(realRoot, realpathSync(resolved));
		if (!real || real.startsWith("..") || path.isAbsolute(real)) return null;
	} catch {
		return null;
	}
	return rel.split(path.sep).join("/");
}

/** Code lines outrank comment lines and lines that are mostly a string literal. */
function proseWeight(line: string): number {
	const t = line.trim();
	if (/^(\/\/|\/\*|\*|#)/.test(t)) return 0.6;
	let quoted = 0;
	let open: string | null = null;
	for (const ch of t) {
		if (open) {
			quoted++;
			if (ch === open) open = null;
		} else if (ch === '"' || ch === "'" || ch === "`") open = ch;
	}
	return quoted > t.length / 2 ? 0.6 : 1;
}

function isTest(file: string): boolean {
	return /(^|[/.])(test|tests|__tests__|spec|e2e|bench|fixtures)([/.]|$)/.test(file);
}

function folderOf(file: string): string {
	return file.split("/").slice(0, 2).join("/");
}

function lineHits(lower: string, terms: string[], weight: Map<string, number>): number {
	let n = 0;
	for (const t of terms) if (lower.includes(t)) n += weight.get(t) ?? 1;
	return n;
}

/** Rare words count more: 1 / log2(2 + files holding the word). */
function rarity(df: number): number {
	return 1 / Math.log2(2 + df);
}

function bestPassage(
	root: string,
	file: string,
	terms: string[],
	weight: Map<string, number>,
	repoId: string | null,
) {
	let text: string;
	try {
		if (insideRoot(root, file) === null) return null;
		if (statSync(path.join(root, file)).size > FILE_MAX_BYTES) return null;
		text = readFileSync(path.join(root, file), "utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n");
	const outline = repoId ? getFileOutline(repoId, file) : null;
	const decls = new Set((outline?.symbols ?? []).map((s) => s.startLine));
	let best = -1;
	let bestScore = 0;
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i].slice(0, 400);
		const hits = lineHits(head.toLowerCase(), terms, weight);
		if (hits === 0) continue;
		const score = hits * (decls.has(i + 1) ? 1.25 : 1) * proseWeight(head);
		if (score > bestScore) {
			best = i;
			bestScore = score;
		}
	}
	if (best < 0) return null;
	const from = Math.max(0, best - PASSAGE_BEFORE);
	const to = Math.min(lines.length, best + PASSAGE_AFTER + 1);
	const excerpt = lines
		.slice(from, to)
		.map((l, k) => `${from + k + 1}| ${cleanLine(l)}`)
		.join("\n");
	const enclosing = (outline?.symbols ?? [])
		.filter((s) => s.startLine <= best + 1 && s.endLine >= best + 1)
		.sort((a, b) => b.startLine - a.startLine)[0];
	return {
		line: best + 1,
		text: cleanLine(lines[best].trim()),
		excerpt,
		symbol: enclosing?.name,
		lineScore: bestScore,
	};
}

/** Only "localhost" or a literal loopback IP; every other name is refused, "127.x.example" too. */
export function isLoopback(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	} catch {
		return false;
	}
	if (host === "localhost") return true;
	const kind = isIP(host);
	if (kind === 4) return host.startsWith("127.");
	if (kind === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
	return false;
}

/** fetch for the decider: refuses any URL that is not loopback, on every request (failover re-probes too). */
export function loopbackFetch(input: string, init?: RequestInit): Promise<Response> {
	if (!isLoopback(String(input))) {
		return Promise.reject(new Error("refused: model host is not on this machine"));
	}
	return fetch(input, init);
}

const deciders = new Map<string, Decider>();

/**
 * The local System One judge. packages/decide loads on first use, so the flag-off
 * path never imports it. The shared judge, Ollama and Laya hosts must all be
 * loopback before the decider is built, and its fetch checks again per request.
 * llama.cpp in process is disabled (llamacppLoader: null): it cannot be aborted.
 */
export function localJudge(env: Record<string, string | undefined> = process.env): Judge {
	return async (question, options) => {
		const decide = await import("../decide/index");
		const { resolveSharedJudgeHost } = await import("../decide/probe");
		const hosts = [
			resolveSharedJudgeHost(env),
			decide.resolveOllamaHost(env),
			decide.resolveLayaUrl(env),
		];
		if (hosts.some((h) => !isLoopback(h))) throw new Error("model host is not on this machine");
		const key = hosts.join(" ");
		let decider = deciders.get(key);
		if (!decider) {
			decider = decide.createDecider({
				timeoutMs: JUDGE_TIMEOUT_MS,
				env,
				fetch: loopbackFetch,
				llamacppLoader: null,
			});
			deciders.set(key, decider);
		}
		const answer = await decider.choice(
			`Question about this codebase: ${question}`,
			"Which file most likely holds the code that answers the question?",
			options,
		);
		return answer.probabilities;
	};
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	work.catch(() => {});
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export async function locateCode(
	question: string,
	opts: LocateCodeOptions,
): Promise<LocateCodeResult> {
	const t0 = performance.now();
	const q = (question ?? "").slice(0, MAX_QUESTION_CHARS).trim();
	const terms = questionTerms(q);
	const done = (passages: Passage[], judge: LocateCodeResult["judge"]): LocateCodeResult => ({
		question: q,
		terms,
		passages,
		judge,
		ms: Math.round(performance.now() - t0),
	});
	if (terms.length === 0) return done([], { used: false, calls: 0, note: "no searchable words" });

	// Level 2 first (it feeds level 1): which files hold which terms.
	const score = new Map<string, number>();
	let rgMissing = false;
	const bump = (file: string, by: number) => score.set(file, (score.get(file) ?? 0) + by);
	const weight = new Map<string, number>();
	const notes: string[] = [];
	for (const t of terms) {
		if (performance.now() - t0 > TOTAL_BUDGET_MS) {
			notes.push("time budget reached, later words not searched");
			break;
		}
		const out = await runRg(opts.root, ["-l", "--null", "-i", "-F", "--glob", CODE_GLOB, "--", t], {
			bin: opts.rg,
			maxLines: 5000,
			timeoutMs: 3000,
		});
		if (out.missing) rgMissing = true;
		const holding = out.text
			.split("\0")
			.map((f) => insideRoot(opts.root, f.replace(/^\.\//, "")))
			.filter((f): f is string => f !== null);
		const w = rarity(holding.length);
		weight.set(t, w);
		for (const file of holding) bump(file, w * (1 + (file.toLowerCase().includes(t) ? 1.5 : 0)));
		if (opts.repoId) {
			const declFiles = new Set(
				searchSymbols(opts.repoId, t, { limit: 200 }).map((s) =>
					path.relative(opts.root, path.resolve(opts.root, s.filePath)).split(path.sep).join("/"),
				),
			);
			for (const file of declFiles) if (score.has(file)) bump(file, 2 * w);
		}
	}
	for (const [file, s] of score) if (isTest(file)) score.set(file, s * 0.5);

	// Level 1: keep the folders whose best file scores highest.
	const folderBest = new Map<string, number>();
	for (const [file, s] of score) {
		const f = folderOf(file);
		folderBest.set(f, Math.max(folderBest.get(f) ?? 0, s));
	}
	const keptFolders = new Set(
		[...folderBest]
			.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
			.slice(0, KEEP_FOLDERS)
			.map(([f]) => f),
	);
	const files = [...score]
		.filter(([file]) => keptFolders.has(folderOf(file)))
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, JUDGE_OPTIONS * 2);

	// Level 3: the best passage in each kept file.
	let ranked: Passage[] = [];
	for (const [file, s] of files) {
		const p = bestPassage(opts.root, file, terms, weight, opts.repoId);
		if (p)
			ranked.push({
				file,
				line: p.line,
				symbol: p.symbol,
				text: p.text,
				excerpt: p.excerpt,
				score: s + p.lineScore,
			});
	}
	ranked.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
	ranked = ranked.slice(0, JUDGE_OPTIONS);

	// Judge: one choice call, bounded; deterministic order on any failure.
	if (rgMissing) notes.unshift("ripgrep (rg) not found, so text search did not run");
	const judge = opts.judge === undefined ? localJudge(opts.env) : opts.judge;
	const left = TOTAL_BUDGET_MS - (performance.now() - t0);
	let calls = 0;
	let used = false;
	if (!judge) notes.push("no local model, deterministic order");
	else if (ranked.length > 1 && left > 0) {
		// Nothing reaches the judge unscrubbed: path, declaration and line alike.
		const options = ranked.map(
			(p) => scrub(`${p.file}${p.symbol ? ` (${p.symbol})` : ""}: ${p.text}`).scrubbed,
		);
		try {
			calls++;
			const timeoutMs = Math.min(opts.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS, left);
			const probs = await withTimeout(judge(scrub(q).scrubbed, options), timeoutMs);
			if (probs.length === ranked.length && probs.every((p) => Number.isFinite(p))) {
				const top = ranked[0].score || 1;
				ranked = ranked
					.map((p, i) => ({ ...p, score: 0.5 * (p.score / top) + 0.5 * probs[i] }))
					.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
				used = true;
				notes.push("local model reranked");
			} else notes.push("model answer unusable, deterministic order");
		} catch (err) {
			const why = err instanceof Error ? err.message.slice(0, 80) : "error";
			notes.push(`model skipped (${why}), deterministic order`);
		}
	}
	return done(ranked.slice(0, MAX_RESULTS), {
		used,
		calls,
		note: notes.join("; ") || "deterministic order",
	});
}
