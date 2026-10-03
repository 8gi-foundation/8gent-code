/**
 * #3427 trial: re-runnable scoring for question narrowing on this repo.
 *
 *   PATH=/opt/homebrew/bin:$PATH bun packages/repo-context/locate.trial.ts [--model]
 *
 * TUNED: the 10 questions the narrowing was tuned against (stems, rarity).
 * HELD_OUT: 5 written after tuning and never tuned on. Lead with HELD_OUT.
 * Answers were read from the code at 7a3ff6b2; an accepted answer is a file
 * plus an inclusive line range. Scores: top-1 file, hit@3 (an answer file in
 * the first 3 distinct files), exact-line (a row in the first 3 inside a range).
 *
 * Methods: `locate` with the flag off (today's prose answer), narrowing alone
 * (no model), narrowing with the local judge (--model only), `locate` with
 * EIGHT_LOCATE=1 (the shipped path: routing first, then narrowing for prose),
 * and search_symbols given the answer's name (a ceiling: it needs the name).
 */

import * as path from "node:path";
import { ensureIndexed, searchSymbols } from "../ast-index/index";
import { locate } from "../ast-index/locate";
import { locateCode } from "./locate";

type Accept = { file: string; lo: number; hi: number };
type Case = { q: string; name?: string; accept: Accept[] };
type Row = { file: string; line: number };

export const TUNED: Case[] = [
	{
		q: "where is the shell command sanitizer",
		name: "sanitizeShellCommand",
		accept: [{ file: "packages/permissions/shell-sanitizer.ts", lo: 80, hi: 90 }],
	},
	{
		q: "where does the 50-call breaker count calls",
		name: "ToolLoopDetector",
		accept: [{ file: "packages/eight/tool-loop-detector.ts", lo: 30, hi: 70 }],
	},
	{
		q: "where are secrets scrubbed from tool output",
		name: "scrub",
		accept: [
			{ file: "packages/eight/tools.ts", lo: 1255, hi: 1275 },
			{ file: "packages/eight/secret-scanner.ts", lo: 110, hi: 125 },
		],
	},
	{
		q: "where is a user path kept inside the working directory",
		name: "safePath",
		accept: [{ file: "packages/eight/tools.ts", lo: 150, hi: 175 }],
	},
	{
		q: "where is the request classified before the model runs to pick a retrieval strategy",
		name: "PreToolRouter",
		accept: [{ file: "packages/eight/pre-tool-router.ts", lo: 1, hi: 135 }],
	},
	{
		q: "where are greetings detected",
		name: "isGreeting",
		accept: [{ file: "packages/eight/pre-tool-router.ts", lo: 95, hi: 125 }],
	},
	{
		q: "where is long command output truncated to head and tail",
		name: "capOutput",
		accept: [{ file: "packages/eight/command-output.ts", lo: 25, hi: 50 }],
	},
	{
		q: "where does memory full text search query the fts table",
		accept: [{ file: "packages/memory/store.ts", lo: 805, hi: 850 }],
	},
	{
		q: "where is the shannon entropy check for leaked keys",
		name: "shannonEntropy",
		accept: [{ file: "packages/eight/secret-scanner.ts", lo: 85, hi: 100 }],
	},
	{
		q: "where are repo files ranked by query words recency and importers",
		name: "rank",
		accept: [{ file: "packages/repo-context/mapper.ts", lo: 84, hi: 115 }],
	},
];

export const HELD_OUT: Case[] = [
	{
		q: "where are large tool results persisted to disk and replaced with a pointer",
		name: "persistAndReplace",
		accept: [{ file: "packages/eight/artifact-store.ts", lo: 95, hi: 130 }],
	},
	{
		q: "where are write tools refused while in plan mode",
		name: "planModeRefusal",
		accept: [{ file: "packages/permissions/permission-mode.ts", lo: 215, hi: 260 }],
	},
	{
		q: "where is the hard deny for children's data that yaml cannot override",
		accept: [{ file: "packages/permissions/policy-engine.ts", lo: 438, hi: 470 }],
	},
	{
		q: "where is the home directory resolved for the .8gent folder",
		name: "resolveHome",
		accept: [{ file: "packages/core/home.ts", lo: 40, hi: 60 }],
	},
	{
		q: "where is one index build shared per folder so it is not rebuilt",
		name: "ensureIndexed",
		accept: [{ file: "packages/ast-index/index.ts", lo: 395, hi: 420 }],
	},
];

export function score(rows: Row[], accept: Accept[]) {
	const files: string[] = [];
	for (const r of rows) if (!files.includes(r.file)) files.push(r.file);
	return {
		top1: accept.some((a) => a.file === files[0]),
		hit3: accept.some((a) => files.slice(0, 3).includes(a.file)),
		line: rows
			.slice(0, 3)
			.some((r) => accept.some((a) => a.file === r.file && r.line >= a.lo && r.line <= a.hi)),
	};
}

async function main(): Promise<void> {
	const root = path.resolve(import.meta.dir, "..", "..");
	const model = process.argv.includes("--model");
	const repoId = (await ensureIndexed(root)).id;
	const flagged = async <T>(on: boolean, work: () => Promise<T>): Promise<T> => {
		const saved = process.env.EIGHT_LOCATE;
		if (on) process.env.EIGHT_LOCATE = "1";
		else delete process.env.EIGHT_LOCATE;
		try {
			return await work();
		} finally {
			if (saved === undefined) delete process.env.EIGHT_LOCATE;
			else process.env.EIGHT_LOCATE = saved;
		}
	};
	const methods: Array<[string, (c: Case) => Promise<Row[]>]> = [
		[
			"locate, flag off",
			(c) =>
				flagged(
					false,
					async () => (await locate(c.q, { root, repoId, systemOne: null, semantic: null })).rows,
				),
		],
		[
			"narrowing, no model",
			async (c) => (await locateCode(c.q, { root, repoId, judge: null })).passages,
		],
		...(model
			? ([
					[
						"narrowing + local judge",
						async (c: Case) => (await locateCode(c.q, { root, repoId })).passages,
					],
					[
						"locate, EIGHT_LOCATE=1",
						(c: Case) =>
							flagged(
								true,
								async () =>
									(await locate(c.q, { root, repoId, systemOne: null, semantic: null })).rows,
							),
					],
				] as Array<[string, (c: Case) => Promise<Row[]>]>)
			: []),
		[
			"search_symbols, name given",
			async (c) =>
				c.name
					? searchSymbols(repoId, c.name, {})
							.slice(0, 5)
							.map((s) => ({
								file: path.relative(root, path.resolve(root, s.filePath)),
								line: s.startLine,
							}))
					: [],
		],
	];
	for (const [label, set] of [
		["HELD-OUT (5)", HELD_OUT],
		["TUNED (10)", TUNED],
	] as const) {
		console.log(`\n${label}\nmethod                        top-1  hit@3  exact-line`);
		for (const [name, run] of methods) {
			let t = 0;
			let h = 0;
			let l = 0;
			for (const c of set) {
				const s = score(await run(c), c.accept);
				t += +s.top1;
				h += +s.hit3;
				l += +s.line;
			}
			const n = set.length;
			console.log(`${name.padEnd(30)}${`${t}/${n}`.padEnd(7)}${`${h}/${n}`.padEnd(7)}${l}/${n}`);
		}
	}
	process.exit(0);
}

if (import.meta.main) await main();
