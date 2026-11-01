/**
 * Paper day 1 eval: widened harvest, grouped split by command identity, held-out report with
 * exact (Clopper-Pearson) 95% CIs. Same split, fit and bashGuard layer as judge-set/fit-8j.ts.
 *   bun paper-eval.ts --rows rows.json --backend 8j --url http://127.0.0.1:8086
 *   bun paper-eval.ts --rows rows.json --backend ollama --model openbmb/minicpm5:latest
 */
import { readFileSync, writeFileSync } from "node:fs";
import { BASH_GUARD_QUESTION, bashGuard, guardState } from "../../guard";
import { type Decider, createDecider } from "../../index";
import { decideRules } from "../../rules";
import { auc, fitLines, lineVerdict, splitRows } from "./fit-8j";
import type { Row } from "./harvest";

// ---- Clopper-Pearson -------------------------------------------------------
function lgamma(x: number): number {
	const c = [
		76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
		0.1208650973866179e-2, -0.5395239384953e-5,
	];
	let y = x;
	let tmp = x + 5.5;
	tmp -= (x + 0.5) * Math.log(tmp);
	let ser = 1.000000000190015;
	for (const cj of c) ser += cj / ++y;
	return -tmp + Math.log((2.5066282746310007 * ser) / x);
}
function betacf(a: number, b: number, x: number): number {
	const MAXIT = 300;
	const EPS = 3e-14;
	const FPMIN = 1e-300;
	const qab = a + b;
	const qap = a + 1;
	const qam = a - 1;
	let c = 1;
	let d = 1 - (qab * x) / qap;
	if (Math.abs(d) < FPMIN) d = FPMIN;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= MAXIT; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < FPMIN) d = FPMIN;
		c = 1 + aa / c;
		if (Math.abs(c) < FPMIN) c = FPMIN;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < EPS) break;
	}
	return h;
}
function betai(a: number, b: number, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const bt = Math.exp(
		lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
	);
	return x < (a + 1) / (a + b + 2)
		? (bt * betacf(a, b, x)) / a
		: 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function betaInv(p: number, a: number, b: number): number {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (betai(a, b, mid) < p) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}
export function cp(k: number, n: number, alpha = 0.05): [number, number] {
	if (n === 0) return [Number.NaN, Number.NaN];
	const lo = k === 0 ? 0 : betaInv(alpha / 2, k, n - k + 1);
	const hi = k === n ? 1 : betaInv(1 - alpha / 2, k + 1, n - k);
	return [lo, hi];
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const fmt = (k: number, n: number) => {
	const [lo, hi] = cp(k, n);
	return `${k}/${n} = ${pct(k / n)} (95% CP ${pct(lo)} to ${pct(hi)})`;
};

// ---- run ---------------------------------------------------------------------
const arg = (k: string) => {
	const i = process.argv.indexOf(k);
	return i < 0 ? undefined : process.argv[i + 1];
};
const rows = JSON.parse(readFileSync(arg("--rows") ?? "", "utf8")) as Row[];
const backend = arg("--backend") ?? "8j";
const url = (arg("--url") ?? "http://127.0.0.1:8086").replace(/\/+$/, "");
const model = arg("--model") ?? "";

let decider: Pick<Decider, "noul">;
let modelName = model;
const cache = new Map<string, number>();
if (backend === "8j") {
	const health = (await (await fetch(`${url}/health`, { redirect: "error" })).json()) as {
		model: string;
	};
	modelName = health.model;
	const ask = async (state: string): Promise<number> => {
		const hit = cache.get(state);
		if (hit !== undefined) return hit;
		const res = await fetch(`${url}/v1/systemone`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				state,
				questions: { q: { type: "noul", instructions: BASH_GUARD_QUESTION } },
			}),
			redirect: "error",
		});
		if (!res.ok) throw new Error(`8j ${res.status}`);
		const p = ((await res.json()) as { answers: { q: { noul: number } } }).answers.q.noul;
		cache.set(state, p);
		return p;
	};
	decider = {
		noul: async (state, prompt) => {
			if (prompt !== BASH_GUARD_QUESTION) throw new Error("unexpected question");
			const yes = await ask(state);
			return {
				id: "q",
				kind: "noul",
				probabilities: { yes },
				confidence: Math.max(yes, 1 - yes),
				backend: "8j",
				model: modelName,
				latencyMs: 0,
			};
		},
	};
} else {
	const d = createDecider({
		backend: "ollama",
		model,
		env: { ...process.env, EIGHT_S1_SHARED_JUDGE: "0" },
	});
	const inner = d.noul.bind(d);
	decider = {
		noul: async (state, prompt) => {
			const key = `${state}\0${prompt}`;
			const r = await inner(state, prompt);
			cache.set(key, r.probabilities.yes);
			return r;
		},
	};
}
const askP = async (state: string) =>
	(await decider.noul(state, BASH_GUARD_QUESTION)).probabilities.yes;

const items = splitRows(rows);
const scored: Array<(typeof items)[number] & { p: number; rules: string }> = [];
for (const it of items)
	scored.push({ ...it, p: await askP(guardState(it.cmd)), rules: decideRules(it.cmd).verdict });
const tune = scored.filter((s) => s.split === "tune");
const test = scored.filter((s) => s.split === "test");
const lines = fitLines(tune);

const full = async (set: typeof scored) => {
	const out: Array<{ risky: boolean; v: string; cmd: string }> = [];
	for (const s of set)
		out.push({
			risky: s.risky,
			cmd: s.cmd,
			v: (await bashGuard(s.cmd, decider as Decider, lines)).verdict,
		});
	return out;
};
const rep = async (label: string, set: typeof scored) => {
	const risky = set.filter((s) => s.risky);
	const safe = set.filter((s) => !s.risky);
	const f = await full(set);
	const fa = f.filter((x) => x.risky && x.v === "allow");
	const fb = f.filter((x) => !x.risky && x.v === "block");
	const sa = f.filter((x) => !x.risky && x.v === "escalate");
	const modelOnly = set.map((s) => ({ ...s, v: lineVerdict(s.p, lines) }));
	const rp = risky.filter((s) => s.rules === "pass");
	const rpFa = modelOnly.filter((m) => m.risky && m.rules === "pass" && m.v === "allow");
	console.log(
		`\n[${label}] ${modelName} n=${set.length} risky=${risky.length} safe=${safe.length} groups=${new Set(set.map((s) => s.group)).size}`,
	);
	console.log(
		`  lines: allow below ${lines.escalateBand[0].toFixed(6)}, block above ${lines.blockAbove.toFixed(6)}`,
	);
	console.log(
		`  rules+${backend === "8j" ? "8J" : modelName} (full bashGuard): false allows ${fmt(fa.length, risky.length)}`,
	);
	console.log(
		`    false blocks ${fmt(fb.length, safe.length)}; safe asked ${fmt(sa.length, safe.length)}`,
	);
	console.log(
		`  model alone on risky the rules pass: false allows ${fmt(rpFa.length, rp.length)}; AUC ${auc(set).toFixed(3)}`,
	);
	return { falseAllows: fa.map((x) => x.cmd), falseBlocks: fb.map((x) => x.cmd) };
};
console.log(
	`rows ${rows.length}; items ${items.length}; tune ${tune.length} (safe ${tune.filter((s) => !s.risky).length}); test ${test.length} (safe ${test.filter((s) => !s.risky).length}, risky ${test.filter((s) => s.risky).length})`,
);
const r = await rep("held-out test", test);
await rep("tune (for reference, lines fitted here)", tune);
console.log("false allows (test):", JSON.stringify(r.falseAllows));
console.log("false blocks (test):", JSON.stringify(r.falseBlocks));
writeFileSync(
	`${process.env.TMPDIR}/paper-eval-${backend}-${modelName.replace(/[^a-z0-9.]/gi, "_")}.json`,
	JSON.stringify({
		lines,
		rows: scored.map(({ cmd, risky, split, p, rules, srcs }) => ({
			cmd,
			risky,
			split,
			p,
			rules,
			srcs,
		})),
	}),
);
