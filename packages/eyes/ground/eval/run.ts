/**
 * Score ground() on the labelled set. A hit is the returned click point inside
 * the target's measured box. Backend comes from the same env as production
 * (EIGHT_GROUND_BACKEND / _MODEL / _ENDPOINT / _COORDS), so a bake-off is the
 * same command with a different env.
 *
 *   bun packages/eyes/ground/eval/run.ts [setDir] [--out results.json]
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backendFromEnv, ground } from "../index.js";
import type { LabelShot } from "./build-set.js";

const args = process.argv.slice(2);
const setDir = args.find((a) => !a.startsWith("--")) ?? join(homedir(), ".8gent", "ground-eval", "set");
const outIdx = args.indexOf("--out");
const backend = backendFromEnv();
const outPath =
	outIdx >= 0
		? args[outIdx + 1]
		: join(homedir(), ".8gent", "ground-eval", `results-ground-${backend.model.replace(/[^\w.-]+/g, "_")}.json`);

const shots = JSON.parse(await Bun.file(join(setDir, "labels.json")).text()) as LabelShot[];
const rows: Record<string, unknown>[] = [];
const by: Record<string, { n: number; hit: number }> = {};

// Warm the model once so the first row's latency is not the load time.
await ground({ image: join(setDir, shots[0].png), instruction: "warm-up" }, { backend });

for (const s of shots) {
	for (const t of s.targets) {
		const r = await ground({ image: join(setDir, s.png), instruction: t.instruction }, { backend });
		const [x1, y1, x2, y2] = t.box;
		const hit = r.ok && r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2;
		const dist = r.ok
			? Math.round(Math.hypot(Math.max(x1 - r.x, 0, r.x - x2), Math.max(y1 - r.y, 0, r.y - y2)) / s.scale)
			: null;
		const key = s.id.endsWith("-1x") ? "1x-copy" : s.source;
		by[key] ??= { n: 0, hit: 0 };
		by[key].n++;
		if (hit) by[key].hit++;
		rows.push({
			shot: s.id,
			source: s.source,
			instruction: t.instruction,
			box: t.box,
			ok: r.ok,
			point: r.ok ? [r.x, r.y] : null,
			confidence: r.ok ? r.confidence : 0,
			hit,
			missCssPx: hit ? 0 : dist,
			ms: r.ms,
			reason: r.ok ? undefined : r.reason,
		});
		console.log(`${hit ? "HIT " : "MISS"} ${s.id.padEnd(22)} ${t.instruction.padEnd(46)} ${r.ok ? `(${r.x},${r.y}) c=${r.confidence}` : r.reason} ${r.ms}ms${!hit && dist !== null ? ` off by ${dist} css px` : ""}`);
	}
}

const n = rows.length;
const hits = rows.filter((r) => r.hit).length;
const ms = rows.map((r) => r.ms as number).sort((a, b) => a - b);
const highConf = rows.filter((r) => (r.confidence as number) >= 0.5);
const summary = {
	backend: backend.id,
	model: backend.model,
	screenshots: shots.length,
	targets: n,
	hits,
	hitRate: Math.round((hits / n) * 1000) / 10,
	bySource: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, `${v.hit}/${v.n}`])),
	precisionWhenConfident: highConf.length
		? Math.round((highConf.filter((r) => r.hit).length / highConf.length) * 1000) / 10
		: null,
	medianMs: ms[Math.floor(ms.length / 2)],
	p90Ms: ms[Math.floor(ms.length * 0.9)],
	at: new Date().toISOString(),
};
writeFileSync(outPath, `${JSON.stringify({ summary, rows }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
