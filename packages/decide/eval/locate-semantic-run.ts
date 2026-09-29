/**
 * locate M3 eval: the persisted AST index and semantic mode.
 *
 *   bun packages/decide/eval/locate-semantic-run.ts [repoRoot] [--tree <dir>] [--cache <dir>] [--cards]
 *
 * Default: the spec's method, symbol signature plus path. --cards also
 * embeds the opt-in file cards (EIGHT_LOCATE_SEMANTIC_CARDS=1).
 *
 * No classifier model: this measures retrieval, not routing.
 *
 * 1. Index. Extracts the prose set's anchor (git archive) into a stable dir
 *    (--tree, default <tmp>/locate-semantic-eval-<anchor>), so the index and
 *    embedding caches carry over between runs. Builds the index with the
 *    on-disk cache (cold the first time), then drops it from memory and
 *    loads it again three times: the warm-start times.
 * 2. Semantic index. ensureSemanticIndex with the nomic client over Ollama;
 *    reports how many signatures were embedded now and how long it took.
 * 3. Queries. For each of the 40 hand-labelled prose queries
 *    (locate-queries-prose.json), top-5 file hit and wall time for:
 *      rules    - locate with System One off (M1, the hybrid answer)
 *      semantic - locate with a router that always keeps semantic
 *      oracle   - locate with a router that answers the hand label, so a
 *                 semantic-labelled query runs semantic and the rest run
 *                 their own mode (the ceiling of routing, now with M3)
 *    Reported overall and per labelled mode. The M3 target is top-5 >= 70%
 *    for semantic mode on the semantic (concept) class.
 *
 * Writes eval/results/<date>-locate-semantic-<signatures|cards>.json.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, getBuildInfo, indexFolder } from "../../ast-index";
import { defaultCacheRoot } from "../../ast-index/index-cache";
import { locate } from "../../ast-index/locate";
import type { ProseRouting } from "../../ast-index/locate-system-one";
import { ensureSemanticIndex, semanticStatus } from "../../ast-index/semantic";
import type { LocateModeChoice } from "../locate-calibration";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const TARGET_CONCEPT_TOP5 = 0.7;
const TARGET_WARM_MS = 1000;

interface ProseQuery {
	id: string;
	mode: LocateModeChoice;
	query: string;
	files: string[];
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return { p50: Math.round(percentile(s, 50)), p95: Math.round(percentile(s, 95)) };
};
const pc = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;

function argValue(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** The tree at `anchor` in `dir` (git archive), extracted once and reused. */
function extractAnchor(repo: string, anchor: string, dir: string): void {
	if (
		fs.existsSync(path.join(dir, ".anchor")) &&
		fs.readFileSync(path.join(dir, ".anchor"), "utf8") === anchor
	) {
		return;
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const tar = `${dir}.tar`;
	const a = spawnSync("git", ["archive", "--format=tar", "-o", tar, anchor], { cwd: repo });
	if (a.status !== 0) throw new Error(`git archive failed: ${a.stderr}`);
	const x = spawnSync("tar", ["-xf", tar, "-C", dir]);
	fs.rmSync(tar, { force: true });
	if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
	fs.writeFileSync(path.join(dir, ".anchor"), anchor);
}

const labelRouter = (mode: LocateModeChoice) => async (): Promise<ProseRouting> => ({
	mode,
	chosen: mode,
	reason: "model",
	confidence: 1,
	latencyMs: 0,
});

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const positional = argv.filter(
		(a, i) => !a.startsWith("--") && argv[i - 1] !== "--tree" && argv[i - 1] !== "--cache",
	);
	const repo = path.resolve(positional[0] ?? path.join(import.meta.dir, "..", "..", ".."));
	const set = JSON.parse(
		fs.readFileSync(path.join(import.meta.dir, "locate-queries-prose.json"), "utf8"),
	) as { anchor: string; queries: ProseQuery[] };
	const tree = fs.realpathSync(
		(() => {
			const t = path.resolve(
				argValue(argv, "--tree") ??
					path.join(os.tmpdir(), `locate-semantic-eval-${set.anchor.slice(0, 8)}`),
			);
			extractAnchor(repo, set.anchor, t);
			return t;
		})(),
	);
	const cacheDir =
		argValue(argv, "--cache") ?? defaultCacheRoot({ ...process.env, NODE_ENV: undefined });
	if (!cacheDir)
		throw new Error("the index cache is off (EIGHT_AST_INDEX_CACHE); pass --cache <dir>");
	const cards = argv.includes("--cards");
	// locate reads the env var; the build below is told directly.
	process.env.EIGHT_LOCATE_SEMANTIC_CARDS = cards ? "1" : "0";
	const load = () => os.loadavg().map((x) => Number(x.toFixed(1)));

	// 1. Index: first build (cold, or warm when an earlier run left a cache), then three warm loads.
	const first = await indexFolder(tree, { cacheDir });
	const firstInfo = getBuildInfo(first.id)!;
	console.log(
		`anchor ${set.anchor.slice(0, 8)}: ${first.fileCount} files, ${first.symbolCount} symbols; first build ${firstInfo.ms} ms (${firstInfo.fromCache ? "from cache" : "cold"}, parsed ${firstInfo.parsed}) load ${load().join(" ")}`,
	);
	const warm: number[] = [];
	for (let i = 0; i < 3; i++) {
		clearIndex(first.id);
		const w = await indexFolder(tree, { cacheDir });
		const info = getBuildInfo(w.id)!;
		if (!info.fromCache || info.parsed > 0)
			throw new Error(`warm load parsed ${info.parsed} files`);
		warm.push(info.ms);
	}
	const warmLoad = load();
	console.log(`warm loads ${warm.join(", ")} ms (parsed 0) load ${warmLoad.join(" ")}`);
	const repoId = first.id;

	// 2. Semantic index.
	const s0 = performance.now();
	const progress = setInterval(() => {
		const st = semanticStatus(repoId);
		if (st.state === "building")
			console.log(`  embedding ${st.done} of ${st.total}  load ${load().join(" ")}`);
	}, 30_000);
	const sem = await ensureSemanticIndex(repoId, { fileCards: cards });
	clearInterval(progress);
	const semanticBuildMs = Math.round(performance.now() - s0);
	console.log(`semantic index: ${JSON.stringify(sem)} in ${semanticBuildMs} ms`);
	if (sem.state !== "ready")
		throw new Error("semantic index not ready; is nomic-embed-text pulled in Ollama?");

	// Warm-up, not timed: loads the embedding model and JITs locate.
	await locate("warm up the store", { root: tree, repoId, systemOne: labelRouter("semantic") });

	// 3. Queries.
	interface Run {
		top5: boolean;
		ms: number;
		route: string;
		top: string[];
		semantic?: unknown;
	}
	const rows: {
		id: string;
		query: string;
		label: LocateModeChoice;
		files: string[];
		rules: Run;
		semantic: Run;
		oracle: Run;
	}[] = [];
	for (const q of set.queries) {
		const run = async (systemOne: ((q: string) => Promise<ProseRouting>) | null): Promise<Run> => {
			const t0 = performance.now();
			const r = await locate(q.query, { root: tree, repoId, systemOne });
			const ms = performance.now() - t0;
			const top = r.rows.map((x) => x.file);
			return {
				top5: top.slice(0, 5).some((f) => q.files.includes(f)),
				ms: Number(ms.toFixed(1)),
				route: `${r.route.mode}/${r.route.rule}`,
				top,
				...(r.semantic ? { semantic: r.semantic } : {}),
			};
		};
		rows.push({
			id: q.id,
			query: q.query,
			label: q.mode,
			files: q.files,
			rules: await run(null),
			semantic: await run(labelRouter("semantic")),
			oracle: await run(labelRouter(q.mode)),
		});
	}

	const rate = (xs: boolean[]) => xs.filter(Boolean).length / Math.max(1, xs.length);
	const modes: LocateModeChoice[] = ["symbol", "grep", "path", "semantic", "hybrid"];
	const byMode = Object.fromEntries(
		modes.map((m) => {
			const rs = rows.filter((r) => r.label === m);
			return [
				m,
				{
					n: rs.length,
					rulesTop5: rate(rs.map((r) => r.rules.top5)),
					semanticTop5: rate(rs.map((r) => r.semantic.top5)),
					oracleTop5: rate(rs.map((r) => r.oracle.top5)),
				},
			];
		}),
	);
	const concept = byMode.semantic;
	const summary = {
		date: new Date().toISOString(),
		anchor: set.anchor,
		set: "locate-queries-prose.json",
		synthetic: true,
		machine: { os: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model },
		index: {
			files: first.fileCount,
			symbols: first.symbolCount,
			firstBuild: firstInfo,
			warmLoadMs: warm,
			loadavgAtWarm: warmLoad,
		},
		semanticIndex: { ...sem, buildMs: semanticBuildMs, fileCards: cards },
		n: rows.length,
		rules: { top5: rate(rows.map((r) => r.rules.top5)), ms: stats(rows.map((r) => r.rules.ms)) },
		semantic: {
			top5: rate(rows.map((r) => r.semantic.top5)),
			ms: stats(rows.map((r) => r.semantic.ms)),
		},
		oracle: { top5: rate(rows.map((r) => r.oracle.top5)), ms: stats(rows.map((r) => r.oracle.ms)) },
		byMode,
		loadavgEnd: load(),
		target: { conceptTop5: TARGET_CONCEPT_TOP5, warmLoadMs: TARGET_WARM_MS },
	};
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const name = `${summary.date.slice(0, 10)}-locate-semantic-${cards ? "cards" : "signatures"}.json`;
	fs.writeFileSync(
		path.join(RESULTS_DIR, name),
		`${JSON.stringify({ summary, rows }, null, "\t")}\n`,
	);

	console.log(
		`\nn=${rows.length}  method ${cards ? "signature + path + file cards" : "signature + path"}  (top-5 file hit; wall ms p50/p95)`,
	);
	for (const k of ["rules", "semantic", "oracle"] as const) {
		const v = summary[k];
		console.log(`  ${k.padEnd(8)} top5 ${pc(v.top5)}  p50 ${v.ms.p50} ms  p95 ${v.ms.p95} ms`);
	}
	console.log("  per label mode: n  rules  semantic  oracle");
	for (const [m, v] of Object.entries(byMode)) {
		console.log(
			`    ${m.padEnd(9)} ${String(v.n).padStart(2)} ${pc(v.rulesTop5)} ${pc(v.semanticTop5)} ${pc(v.oracleTop5)}`,
		);
	}
	for (const r of rows.filter((x) => x.label === "semantic")) {
		console.log(
			`  ${r.id} ${r.semantic.top5 ? "hit " : "MISS"} ${r.query}\n       -> ${r.semantic.top.join(", ")}`,
		);
	}
	console.log(
		`  target concept top-5 >= 70%: ${concept.semanticTop5 >= TARGET_CONCEPT_TOP5 ? "met" : "NOT met"} (${pc(concept.semanticTop5)}); warm load < 1 s: ${Math.max(...warm) < TARGET_WARM_MS ? "met" : "NOT met"} (max ${Math.max(...warm)} ms)`,
	);
	console.log(`wrote eval/results/${name}`);
}

await main();
