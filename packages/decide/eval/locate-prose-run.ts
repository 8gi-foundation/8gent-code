/**
 * locate prose eval: System One mode routing (M2).
 *
 *   bun packages/decide/eval/locate-prose-run.ts --model <ollama model> [--write-calibration] [repoRoot]
 *
 * The set is locate-queries-prose.json: 40 prose queries, hand-written and
 * hand-labelled (synthetic, one labeller, not second-checked). Each carries a
 * mode label and the file(s) that answer it. Every query reaches rule "prose"
 * (directly, or as the fallback of a phrase with no literal hit), so it is
 * exactly the traffic the model sees.
 *
 * Extracts the tree at the set's anchor (git archive), builds the AST index
 * once, then per query:
 *
 *   classifier - one System One `choice` call through createDecider on the
 *                named Ollama model, memo off, the same state and question
 *                locate asks. Wall time is the latency.
 *   M1         - locate with System One off (the rules' hybrid answer).
 *   M2         - locate with a real prose router (createProseRouter, 500 ms
 *                budget, fail-open) gated by the leave-one-out threshold for
 *                that query: a threshold fitted on the other 39 answers, so
 *                no query is scored by a cut it helped choose.
 *
 *   oracle     - locate with a router that always answers the hand label
 *                (no model): the top-5 ceiling of routing, what M2 would
 *                score with a perfect classifier.
 *
 * Metrics: raw mode accuracy (argmax equals label), gated held-out accuracy,
 * coverage (share where the model's mode was kept) and accuracy on those,
 * classifier p50/p95, M1 and M2 top-5 file hit and end-to-end p50/p95.
 *
 * Writes eval/results/<date>-locate-prose-<model-slug>.json. With
 * --write-calibration it also writes calibration/locate/<backend>-<model>.json
 * (threshold fitted on all 40). One model per run; nothing runs in parallel.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearIndex, ensureIndexed } from "../../ast-index";
import { locate } from "../../ast-index/locate";
import {
	LOCATE_MODE_OPTIONS,
	LOCATE_MODE_OPTION_TEXT,
	LOCATE_MODE_QUESTION,
	createProseRouter,
	locateModeState,
} from "../../ast-index/locate-system-one";
import { calibrationFileName, modelSlug } from "../calibrate";
import { createDecider } from "../index";
import {
	LOCATE_CALIBRATION_DIR,
	type LocateCalibration,
	type LocateModeChoice,
	type LocateSample,
	fitLocateCalibration,
	locateLeaveOneOut,
} from "../locate-calibration";

const RESULTS_DIR = path.join(import.meta.dir, "results");

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

/** The tree at `anchor` in a temp dir (git archive), so labels match whatever is checked out. */
function extractAnchor(repo: string, anchor: string): { dir: string; tree: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locate-prose-eval-"));
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
const TARGET = { accuracy: 0.85, p95Ms: 500 };

interface ProseQuery {
	id: string;
	mode: LocateModeChoice;
	query: string;
	files: string[];
}

interface Row {
	id: string;
	query: string;
	label: LocateModeChoice;
	files: string[];
	model: {
		chosen: LocateModeChoice;
		confidence: number;
		probabilities: number[];
		latencyMs: number;
	} | null;
	modelError?: string;
	heldOutThreshold: number | null;
	gated: LocateModeChoice;
	m1: { top5: boolean; ms: number; top: string[] };
	m2: { top5: boolean; ms: number; top: string[]; route: string; reason?: string };
	oracle: { top5: boolean; top: string[]; route: string };
}

const pc = (x: number) => (Number.isNaN(x) ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);
const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return {
		p50: Number(percentile(s, 50).toFixed(1)),
		p95: Number(percentile(s, 95).toFixed(1)),
		max: Number((s[s.length - 1] ?? Number.NaN).toFixed(1)),
	};
};

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const modelIdx = argv.indexOf("--model");
	const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
	if (!model) throw new Error("--model <ollama model name> is required");
	const writeCal = argv.includes("--write-calibration");
	const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--model");
	const repo = path.resolve(positional[0] ?? path.join(import.meta.dir, "..", "..", ".."));
	const setFile = path.join(import.meta.dir, "locate-queries-prose.json");
	const set = JSON.parse(fs.readFileSync(setFile, "utf8")) as {
		anchor: string;
		queries: ProseQuery[];
	};

	const decider = createDecider({ backend: "ollama", model, cacheSize: 0, timeoutMs: 120_000 });
	const backend = await decider.backend();

	const { dir, tree } = extractAnchor(repo, set.anchor);
	try {
		const t0 = performance.now();
		const index = await ensureIndexed(tree);
		console.log(
			`anchor ${set.anchor.slice(0, 8)}: ${index.fileCount} files, index build ${Math.round(performance.now() - t0)} ms`,
		);

		// Warm-up, not timed: loads the model and JITs locate.
		const w0 = performance.now();
		await decider.choice(locateModeState("warm up"), LOCATE_MODE_QUESTION, [
			...LOCATE_MODE_OPTION_TEXT,
		]);
		const warmMs = Math.round(performance.now() - w0);
		await locate("where is the store", { root: tree, repoId: index.id, systemOne: null });
		console.log(`${backend.name} ${backend.model}: warm-up (model load) ${warmMs} ms`);

		// Pass 1: the classifier alone, and M1.
		const partial: Array<Omit<Row, "heldOutThreshold" | "gated" | "m2" | "oracle">> = [];
		for (const q of set.queries) {
			let modelAns: Row["model"] = null;
			let modelError: string | undefined;
			const c0 = performance.now();
			try {
				const a = await decider.choice(locateModeState(q.query), LOCATE_MODE_QUESTION, [
					...LOCATE_MODE_OPTION_TEXT,
				]);
				modelAns = {
					chosen: LOCATE_MODE_OPTIONS[a.chosen],
					confidence: Number(a.confidence.toFixed(4)),
					probabilities: a.probabilities.map((p) => Number(p.toFixed(4))),
					latencyMs: Number((performance.now() - c0).toFixed(1)),
				};
			} catch (err) {
				modelError = err instanceof Error ? err.message : String(err);
			}
			const m0 = performance.now();
			const r1 = await locate(q.query, { root: tree, repoId: index.id, systemOne: null });
			const m1ms = performance.now() - m0;
			const top1 = r1.rows.map((r) => r.file);
			partial.push({
				id: q.id,
				query: q.query,
				label: q.mode,
				files: q.files,
				model: modelAns,
				...(modelError ? { modelError } : {}),
				m1: {
					top5: top1.slice(0, 5).some((f) => q.files.includes(f)),
					ms: Number(m1ms.toFixed(1)),
					top: top1,
				},
			});
		}

		// Held-out thresholds: each query's cut is fitted on the other answers.
		const answered = partial.map((p, i) => ({ p, i })).filter(({ p }) => p.model);
		const samples: LocateSample[] = answered.map(({ p }) => ({
			chosen: p.model!.chosen,
			confidence: p.model!.confidence,
			label: p.label,
		}));
		const loo = locateLeaveOneOut(samples);
		const looByIndex = new Map(answered.map(({ i }, k) => [i, loo.rows[k]]));

		// Pass 2: M2 end to end, a real router (500 ms budget) at the held-out cut.
		const rows: Row[] = [];
		for (let i = 0; i < partial.length; i++) {
			const p = partial[i];
			const held = looByIndex.get(i);
			const threshold = held ? held.threshold : null;
			const router = createProseRouter({ decider, threshold: threshold ?? 1 });
			const e0 = performance.now();
			const r2 = await locate(p.query, { root: tree, repoId: index.id, systemOne: router });
			const m2ms = performance.now() - e0;
			const top2 = r2.rows.map((r) => r.file);
			const label = p.label;
			const ro = await locate(p.query, {
				root: tree,
				repoId: index.id,
				systemOne: async () => ({
					mode: label,
					chosen: label,
					reason: "model",
					confidence: 1,
					latencyMs: 0,
				}),
			});
			const topO = ro.rows.map((r) => r.file);
			rows.push({
				...p,
				heldOutThreshold: threshold,
				gated: held ? held.gated : "hybrid",
				m2: {
					top5: top2.slice(0, 5).some((f) => p.files.includes(f)),
					ms: Number(m2ms.toFixed(1)),
					top: top2,
					route: `${r2.route.mode}/${r2.route.rule}`,
					...(r2.route.systemOne ? { reason: r2.route.systemOne.reason } : {}),
				},
				oracle: {
					top5: topO.slice(0, 5).some((f) => p.files.includes(f)),
					top: topO,
					route: `${ro.route.mode}/${ro.route.rule}`,
				},
			});
		}

		const fit = fitLocateCalibration(samples);
		const n = rows.length;
		const rate = (xs: boolean[]) => xs.filter(Boolean).length / Math.max(1, xs.length);
		const byMode = Object.fromEntries(
			LOCATE_MODE_OPTIONS.map((m) => {
				const rs = rows.filter((r) => r.label === m);
				return [
					m,
					{
						n: rs.length,
						raw: rate(rs.map((r) => r.model?.chosen === m)),
						gated: rate(rs.map((r) => r.gated === m)),
						m1Top5: rate(rs.map((r) => r.m1.top5)),
						m2Top5: rate(rs.map((r) => r.m2.top5)),
						oracleTop5: rate(rs.map((r) => r.oracle.top5)),
					},
				];
			}),
		);
		const confusion: Record<string, Record<string, number>> = {};
		for (const r of rows) {
			const got = r.model?.chosen ?? "error";
			confusion[r.label] ??= {};
			confusion[r.label][got] = (confusion[r.label][got] ?? 0) + 1;
		}
		const summary = {
			date: new Date().toISOString(),
			anchor: set.anchor,
			set: path.basename(setFile),
			synthetic: true,
			backend: backend.name,
			model: backend.model,
			machine: {
				os: process.platform,
				arch: process.arch,
				cpus: os.cpus()[0]?.model,
				loadavg: os.loadavg().map((x) => Number(x.toFixed(2))),
			},
			n,
			answered: samples.length,
			warmUpMs: warmMs,
			rawAccuracy: fit.rawAccuracy,
			thresholdAll: fit.threshold,
			heldOut: loo.heldOut,
			classifierMs: stats(rows.filter((r) => r.model).map((r) => r.model!.latencyMs)),
			m1: { top5: rate(rows.map((r) => r.m1.top5)), ms: stats(rows.map((r) => r.m1.ms)) },
			m2: {
				top5: rate(rows.map((r) => r.m2.top5)),
				ms: stats(rows.map((r) => r.m2.ms)),
				reasons: rows.reduce<Record<string, number>>((acc, r) => {
					const k = r.m2.reason ?? "none";
					acc[k] = (acc[k] ?? 0) + 1;
					return acc;
				}, {}),
			},
			oracle: { top5: rate(rows.map((r) => r.oracle.top5)) },
			byMode,
			confusion,
			target: TARGET,
		};

		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		const resultName = `${summary.date.slice(0, 10)}-locate-prose-${modelSlug(backend.model)}.json`;
		fs.writeFileSync(
			path.join(RESULTS_DIR, resultName),
			`${JSON.stringify({ summary, rows }, null, "\t")}\n`,
		);

		console.log(`\n${backend.name} ${backend.model}  n=${n} (answered ${samples.length})`);
		console.log(
			`  mode accuracy raw ${pc(fit.rawAccuracy)}   gated held-out ${pc(loo.heldOut.accuracy)}   coverage ${pc(loo.heldOut.coverage)}   accuracy when kept ${pc(loo.heldOut.acceptedAccuracy)}   threshold (all 40) ${fit.threshold}`,
		);
		console.log(
			`  classifier  p50 ${summary.classifierMs.p50} ms  p95 ${summary.classifierMs.p95} ms  max ${summary.classifierMs.max} ms`,
		);
		console.log(
			`  M1 (rules)  top5 ${pc(summary.m1.top5)}  p50 ${summary.m1.ms.p50} ms  p95 ${summary.m1.ms.p95} ms`,
		);
		console.log(
			`  M2 (routed) top5 ${pc(summary.m2.top5)}  p50 ${summary.m2.ms.p50} ms  p95 ${summary.m2.ms.p95} ms  router reasons ${JSON.stringify(summary.m2.reasons)}`,
		);
		console.log(`  oracle (label as mode) top5 ${pc(summary.oracle.top5)}`);
		console.log("  per label mode: n  raw  gated  M1top5  M2top5  oracleTop5");
		for (const [m, v] of Object.entries(byMode))
			console.log(
				`    ${m.padEnd(9)} ${String(v.n).padStart(2)} ${pc(v.raw)} ${pc(v.gated)} ${pc(v.m1Top5)} ${pc(v.m2Top5)} ${pc(v.oracleTop5)}`,
			);
		console.log(`  confusion (label -> model argmax): ${JSON.stringify(confusion)}`);
		console.log(
			`  target mode accuracy >= 85% (gated held-out): ${loo.heldOut.accuracy >= TARGET.accuracy ? "met" : "NOT met"}; classifier p95 < 500 ms: ${summary.classifierMs.p95 < TARGET.p95Ms ? "met" : "NOT met"}`,
		);
		console.log(`wrote eval/results/${resultName}`);

		if (writeCal) {
			const cal: LocateCalibration = {
				kind: "locate-mode",
				model: backend.model,
				backend: backend.name,
				threshold: fit.threshold,
				fittedOn: `eval/results/${resultName}`,
				n: samples.length,
				rawAccuracy: Number(fit.rawAccuracy.toFixed(4)),
				heldOut: {
					accuracy: Number(loo.heldOut.accuracy.toFixed(4)),
					coverage: Number(loo.heldOut.coverage.toFixed(4)),
					acceptedAccuracy: Number(loo.heldOut.acceptedAccuracy.toFixed(4)),
					method: "leave-one-out",
				},
				note: `PROVISIONAL: fitted on ${samples.length} hand-labelled synthetic prose queries (one labeller). Keep the model's mode when its choice confidence >= threshold, else hybrid.`,
			};
			fs.mkdirSync(LOCATE_CALIBRATION_DIR, { recursive: true });
			const out = path.join(
				LOCATE_CALIBRATION_DIR,
				calibrationFileName(backend.name, backend.model),
			);
			fs.writeFileSync(out, `${JSON.stringify(cal, null, "\t")}\n`);
			console.log(`wrote ${path.relative(process.cwd(), out)}`);
		}
		clearIndex(index.id);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

await main();
