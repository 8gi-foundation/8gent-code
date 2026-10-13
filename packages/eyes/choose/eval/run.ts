/**
 * Score chooseElement on the labelled ground-eval set (8TO, 12 Oct) with a
 * local decider, so the number sits next to ground()'s on the same targets.
 *
 *   bun packages/eyes/choose/eval/run.ts [--set <labels.json>] [--model <ollama model>] [--out <results.json>]
 *
 * A target is a hit when the chosen element's index equals the label's
 * elementIndex, or its rect centre (CSS px times the page scale) lies inside
 * the label's box in image pixels. Pages with no element list (the TUI
 * screenshots) are NO_NODE: that is ground()'s job, counted apart.
 *
 * Runs with allowRisky so the grounding is measured on every target; how many
 * the default risky gate would hold is reported without a model call. Local
 * only, one model call at a time; take the lane lock before running.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDecider } from "../../../decide/index.js";
import { type DomElementRow, fromDomElements } from "../adapters.js";
import { MIN_CONFIDENCE, MIN_MARGIN, RISKY, chooseElement } from "../index.js";

interface Page {
	id: string;
	png: string;
	source: string;
	viewport: { w: number; h: number };
	scale: number;
	targets: Array<{
		instruction: string;
		box: [number, number, number, number];
		elementIndex: number;
	}>;
	elements: DomElementRow[];
}

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const home = os.homedir();
const setPath = arg("set", path.join(home, ".8gent/ground-eval/set/labels.json"));
const model = arg("model", "hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF:latest");
const outPath = arg("out", path.join(home, ".8gent/ground-eval/results-choose.json"));

const pages: Page[] = JSON.parse(fs.readFileSync(setPath, "utf8"));
const decider = createDecider({ backend: "ollama", model, cacheSize: 0, timeoutMs: 120_000 });

interface Row {
	page: string;
	instruction: string;
	status: string;
	expectedIndex: number;
	chosenIndex: number | null;
	hit: boolean;
	confidence: number | null;
	margin: number | null;
	ms: number;
	reason?: string;
	riskyGated: boolean;
}

const inside = (p: Page, idx: number, box: number[]): boolean => {
	const e = p.elements.find((r) => r.index === idx);
	if (!e) return false;
	const cx = (e.rect.x + e.rect.w / 2) * p.scale;
	const cy = (e.rect.y + e.rect.h / 2) * p.scale;
	return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
};

const rows: Row[] = [];
let backend = "";
for (const p of pages) {
	const elements = fromDomElements(p.elements);
	for (const t of p.targets) {
		const out = await chooseElement({
			elements,
			intent: t.instruction,
			allowRisky: true,
			decider,
			viewport: { width: p.viewport.w, height: p.viewport.h },
		});
		const chosen = out.status === "CHOSEN" ? out.index : null;
		const hit = chosen !== null && (chosen === t.elementIndex || inside(p, chosen, t.box));
		const row: Row = {
			page: p.id,
			instruction: t.instruction,
			status: out.status,
			expectedIndex: t.elementIndex,
			chosenIndex: chosen ?? ("heldIndex" in out ? (out.heldIndex ?? null) : null),
			hit,
			confidence: "confidence" in out ? (out.confidence ?? null) : null,
			margin: "margin" in out ? (out.margin ?? null) : null,
			ms: "ms" in out ? (out.ms ?? 0) : 0,
			reason: "reason" in out ? out.reason : undefined,
			riskyGated: RISKY.test(t.instruction),
		};
		if ("backend" in out && out.backend) backend = out.backend;
		rows.push(row);
		const tag =
			out.status === "CHOSEN"
				? hit
					? "HIT "
					: "MISS"
				: out.status === "NO_NODE"
					? "NONODE"
					: "AGENT";
		const c =
			row.confidence === null
				? ""
				: `c=${row.confidence.toFixed(2)} m=${(row.margin ?? 0).toFixed(2)}`;
		console.log(
			`${tag.padEnd(6)} ${p.id.padEnd(22)} ${t.instruction.padEnd(46)} want=${String(t.elementIndex).padStart(2)} got=${String(row.chosenIndex ?? "-").padStart(2)} ${c} ${row.ms}ms${row.reason ? ` (${row.reason})` : ""}`,
		);
	}
}

const dom = rows.filter((r) => r.status !== "NO_NODE");
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const rate = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

/** What each (confidence, margin) cut would have done, from the raw picks. */
const sweep = [0.2, 0.35, 0.5, 0.7]
	.flatMap((conf) => [0, 0.1, 0.2].map((marg) => ({ conf, marg })))
	.map(({ conf, marg }) => {
		const scored = dom.filter((r) => r.confidence !== null && r.chosenIndex !== null);
		const kept = scored.filter((r) => (r.confidence ?? 0) >= conf && (r.margin ?? 0) >= marg);
		const keptHits = kept.filter((r) => {
			const p = pages.find((x) => x.id === r.page);
			const t = p?.targets.find((x) => x.instruction === r.instruction);
			return (
				p &&
				t &&
				r.chosenIndex !== null &&
				(r.chosenIndex === t.elementIndex || inside(p, r.chosenIndex, t.box))
			);
		});
		return {
			conf,
			marg,
			kept: kept.length,
			keptHits: keptHits.length,
			keptAccuracy: rate(keptHits.length, kept.length),
		};
	});

const summary = {
	model,
	backend,
	set: setPath,
	at: new Date().toISOString(),
	thresholds: { MIN_CONFIDENCE, MIN_MARGIN },
	targets: rows.length,
	domTargets: dom.length,
	noNode: rows.length - dom.length,
	hits: dom.filter((r) => r.hit).length,
	hitRateDom: rate(dom.filter((r) => r.hit).length, dom.length),
	hitRateAll: rate(dom.filter((r) => r.hit).length, rows.length),
	chosenWrong: dom.filter((r) => r.status === "CHOSEN" && !r.hit).length,
	needsAgent: dom.filter((r) => r.status === "NEEDS_AGENT").length,
	needsAgentRate: rate(dom.filter((r) => r.status === "NEEDS_AGENT").length, dom.length),
	riskyGatedByDefault: dom.filter((r) => r.riskyGated).length,
	medianMs: median(dom.map((r) => r.ms)),
	p95Ms: [...dom.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(dom.length * 0.95)] ?? 0,
	sweep,
};
fs.writeFileSync(outPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log("");
console.log(
	`choose: ${summary.hits}/${summary.domTargets} DOM targets hit (${summary.hitRateDom}%), ${summary.hits}/${summary.targets} of all (${summary.hitRateAll}%); wrong picks ${summary.chosenWrong}; NEEDS_AGENT ${summary.needsAgent} (${summary.needsAgentRate}%); NO_NODE ${summary.noNode}; risky-gated by default ${summary.riskyGatedByDefault}`,
);
console.log(
	`latency median ${summary.medianMs}ms p95 ${summary.p95Ms}ms; model ${model} via ${backend}`,
);
console.log("gate sweep (conf, margin -> kept, accuracy when kept):");
for (const s of sweep)
	console.log(`  ${s.conf} ${s.marg} -> ${s.kept} kept, ${s.keptHits} right (${s.keptAccuracy}%)`);
console.log(`written ${outPath}`);
