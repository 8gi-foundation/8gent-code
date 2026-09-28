/**
 * locate eval runner.
 *
 *   bun packages/decide/eval/locate-run.ts [repoRoot]
 *
 * Extracts the tree at the set's ANCHOR commit (git archive) into a temp dir,
 * so labels and corpus match exactly whatever branch is checked out, builds
 * the AST index there once, then runs every query in locate-queries.json
 * through two systems:
 *
 *   locate      - ast-index/locate.ts exactly as the tool calls it (index
 *                 refresh + route + search + formatted answer). No model.
 *   baseline A  - today's tools with no model, and with the right tool picked
 *                 for each class (an oracle choice, so generous to A):
 *                   identifier -> the real ToolExecutor search_symbols tool
 *                   path       -> rg --files, filtered to lines containing the query
 *                   string     -> rg -F -n <text> (what run_command would print)
 *
 * Metrics, overall and per class:
 *   top-1 / top-5 file hit - the label file is the first row / in the first 5 rows
 *   line hit (top-5)       - a top-5 row in the label file within LINE_TOLERANCE
 *                            of the label line (identifier and string only)
 *   p50 / p95 latency      - per query, warm index, ms
 *   output tokens          - ceil(chars / 4) of what the agent would read
 *   route accuracy         - locate only: routed mode matches the class's mode
 *
 * Writes packages/decide/eval/results/<date>-locate.json. Nothing is executed
 * from query text: rg receives it as one argv element after -e.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, ensureIndexed } from "../../ast-index";
import { type LocateMode, formatLocate, locate, parseRgLines } from "../../ast-index/locate";
import { ToolExecutor } from "../../eight/tools";
import type { LocateQuery, QueryClass } from "./locate-mine";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const LINE_TOLERANCE = 2;
const EXPECT_MODE: Record<QueryClass, LocateMode> = {
	identifier: "symbol",
	path: "path",
	string: "grep",
};
/** A fresh ToolExecutor every N baseline calls keeps under its 100-per-minute rate limit. */
const EXECUTOR_CALLS = 50;

interface Hit {
	file: string;
	line: number;
}

interface Row {
	id: string;
	class: QueryClass;
	query: string;
	label: Hit;
	system: "locate" | "baselineA";
	mode?: string;
	rule?: string;
	top: Hit[];
	top1: boolean;
	top5: boolean;
	lineHit: boolean | null;
	ms: number;
	tokens: number;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

const tokens = (s: string) => Math.ceil(s.length / 4);

function score(q: LocateQuery, top: Hit[]): Pick<Row, "top1" | "top5" | "lineHit"> {
	const five = top.slice(0, 5);
	return {
		top1: five[0]?.file === q.file,
		top5: five.some((h) => h.file === q.file),
		lineHit:
			q.class === "path"
				? null
				: five.some((h) => h.file === q.file && Math.abs(h.line - q.line) <= LINE_TOLERANCE),
	};
}

function run(cmd: string, args: string[], cwd: string): string {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
	if (r.error) throw r.error;
	return r.stdout ?? "";
}

function extractAnchor(repo: string, anchor: string): { dir: string; tree: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locate-eval-"));
	const tree = path.join(dir, "tree");
	fs.mkdirSync(tree);
	const tar = path.join(dir, "anchor.tar");
	const a = spawnSync("git", ["archive", "--format=tar", "-o", tar, anchor], { cwd: repo });
	if (a.status !== 0) throw new Error(`git archive failed: ${a.stderr}`);
	const x = spawnSync("tar", ["-xf", tar, "-C", tree]);
	if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
	fs.rmSync(tar);
	return { dir, tree };
}

async function baselineA(
	q: LocateQuery,
	tree: string,
	executor: ToolExecutor,
): Promise<{ top: Hit[]; out: string }> {
	if (q.class === "identifier") {
		const out = await executor.execute("search_symbols", { query: q.query });
		const matches =
			(JSON.parse(out) as { matches?: { file: string; line: number }[] }).matches ?? [];
		return { top: matches.map((m) => ({ file: m.file, line: m.line })), out };
	}
	if (q.class === "path") {
		const needle = q.query.toLowerCase();
		const files = run("rg", ["--no-config", "--files", "--sort", "path"], tree)
			.split("\n")
			.filter((f) => f?.toLowerCase().includes(needle));
		return { top: files.map((file) => ({ file, line: 1 })), out: files.join("\n") };
	}
	const text = q.query.replace(/^"(.*)"$/, "$1");
	const out = run(
		"rg",
		["--no-config", "-F", "-n", "--no-heading", "--color", "never", "--sort", "path", "-e", text],
		tree,
	);
	return { top: parseRgLines(out).map((h) => ({ file: h.file, line: h.line })), out };
}

function summarise(rows: Row[]) {
	const pct = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : Number.NaN);
	const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
	const tok = rows.map((r) => r.tokens).sort((a, b) => a - b);
	const lineRows = rows.filter((r) => r.lineHit !== null);
	return {
		n: rows.length,
		top1: pct(rows.map((r) => r.top1)),
		top5: pct(rows.map((r) => r.top5)),
		lineHitTop5: pct(lineRows.map((r) => r.lineHit as boolean)),
		lineN: lineRows.length,
		p50Ms: Number(percentile(lat, 50).toFixed(1)),
		p95Ms: Number(percentile(lat, 95).toFixed(1)),
		meanTokens: Math.round(tok.reduce((a, b) => a + b, 0) / Math.max(1, tok.length)),
		p95Tokens: percentile(tok, 95),
		maxTokens: tok[tok.length - 1] ?? 0,
	};
}

async function main(): Promise<void> {
	const repo = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "..", ".."));
	const set = JSON.parse(
		fs.readFileSync(path.join(import.meta.dir, "locate-queries.json"), "utf8"),
	) as {
		anchor: string;
		queries: LocateQuery[];
	};

	const { dir, tree } = extractAnchor(repo, set.anchor);
	try {
		const t0 = performance.now();
		const index = await ensureIndexed(tree);
		const buildMs = Math.round(performance.now() - t0);
		console.log(
			`anchor ${set.anchor.slice(0, 8)}: ${index.fileCount} files, ${index.symbolCount} symbols, index build ${buildMs} ms`,
		);

		// Warm both systems once (JIT, file cache, rg binary); not timed.
		await locate("createDecider", { root: tree, repoId: index.id });
		run("rg", ["--no-config", "--files"], tree);

		const rows: Row[] = [];
		let executor = new ToolExecutor(tree);
		let calls = 0;
		for (const q of set.queries) {
			const label = { file: q.file, line: q.line };

			const s0 = performance.now();
			const result = await locate(q.query, { root: tree, repoId: index.id });
			const text = formatLocate(result);
			const ms = performance.now() - s0;
			const top = result.rows.map((r) => ({ file: r.file, line: r.line }));
			rows.push({
				id: q.id,
				class: q.class,
				query: q.query,
				label,
				system: "locate",
				mode: result.route.mode,
				rule: result.route.rule,
				top,
				...score(q, top),
				ms: Number(ms.toFixed(1)),
				tokens: tokens(text),
			});

			if (q.class === "identifier" && ++calls % EXECUTOR_CALLS === 0)
				executor = new ToolExecutor(tree);
			const b0 = performance.now();
			const base = await baselineA(q, tree, executor);
			const bms = performance.now() - b0;
			rows.push({
				id: q.id,
				class: q.class,
				query: q.query,
				label,
				system: "baselineA",
				top: base.top.slice(0, 5),
				...score(q, base.top),
				ms: Number(bms.toFixed(1)),
				tokens: tokens(base.out),
			});
		}

		const loc = rows.filter((r) => r.system === "locate");
		const baseRows = rows.filter((r) => r.system === "baselineA");
		const classes: QueryClass[] = ["identifier", "path", "string"];
		const summary = {
			date: new Date().toISOString(),
			anchor: set.anchor,
			machine: { os: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model },
			index: { files: index.fileCount, symbols: index.symbolCount, buildMs },
			lineTolerance: LINE_TOLERANCE,
			locate: {
				...summarise(loc),
				routeAccuracy: loc.filter((r) => r.mode === EXPECT_MODE[r.class]).length / loc.length,
				byClass: Object.fromEntries(
					classes.map((c) => [c, summarise(loc.filter((r) => r.class === c))]),
				),
			},
			baselineA: {
				...summarise(baseRows),
				byClass: Object.fromEntries(
					classes.map((c) => [c, summarise(baseRows.filter((r) => r.class === c))]),
				),
			},
			target: { top5: 0.9, p95Ms: 250 },
		};

		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		const file = path.join(RESULTS_DIR, `${summary.date.slice(0, 10)}-locate.json`);
		fs.writeFileSync(file, `${JSON.stringify({ summary, rows }, null, "\t")}\n`);

		const pc = (x: number) => (Number.isNaN(x) ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);
		const line = (name: string, s: ReturnType<typeof summarise>) =>
			`  ${name.padEnd(22)} n=${String(s.n).padStart(3)}  top1 ${pc(s.top1)}  top5 ${pc(s.top5)}  line ${pc(s.lineHitTop5)}  p50 ${String(s.p50Ms).padStart(6)} ms  p95 ${String(s.p95Ms).padStart(6)} ms  tokens mean ${String(s.meanTokens).padStart(5)} p95 ${String(s.p95Tokens).padStart(5)} max ${String(s.maxTokens).padStart(6)}`;
		for (const [name, sys] of [
			["locate", summary.locate],
			["baseline A", summary.baselineA],
		] as const) {
			console.log(`\n${name}`);
			console.log(line("all", sys));
			for (const c of classes) console.log(line(c, sys.byClass[c]));
		}
		console.log(`\nlocate route accuracy ${pc(summary.locate.routeAccuracy)}`);
		const misses = loc.filter((r) => !r.top5);
		console.log(`locate top-5 misses (${misses.length}):`);
		for (const m of misses) {
			console.log(
				`  ${m.id} [${m.mode}/${m.rule}] ${m.query} -> want ${m.label.file}:${m.label.line}, got ${m.top[0] ? `${m.top[0].file}:${m.top[0].line}` : "nothing"}`,
			);
		}
		console.log(
			`\ntarget top5 >= 90%: ${summary.locate.top5 >= 0.9 ? "met" : "NOT met"}; p95 < 250 ms: ${summary.locate.p95Ms < 250 ? "met" : "NOT met"}`,
		);
		console.log(`wrote ${path.relative(process.cwd(), file)}`);
		clearIndex(index.id);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

await main();
