/**
 * Micro-bench: compiled check vs a hand-written validator, on one nested object.
 * Run: bun packages/schema/bench.ts
 * Prints ns/op for each. Swap in your own schema or validator below to compare.
 */
import { compile } from "./index";

const schema = {
	type: "object",
	properties: {
		path: { type: "string", minLength: 1 },
		mode: { enum: ["r", "w", "a"] },
		limit: { type: "integer", minimum: 0, maximum: 1000 },
		opts: {
			type: "object",
			properties: {
				encoding: { type: ["string", "null"] },
				flags: { type: "array", items: { type: "string" } },
				deep: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
			},
			required: ["encoding"],
			additionalProperties: false,
		},
	},
	required: ["path", "mode"],
	additionalProperties: false,
};

const value = {
	path: "src/index.ts",
	mode: "r",
	limit: 200,
	opts: { encoding: "utf8", flags: ["a", "b", "c"], deep: { n: 1.5 } },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function handWritten(v: unknown): boolean {
	if (!isObj(v)) return false;
	for (const k of Object.keys(v)) if (k !== "path" && k !== "mode" && k !== "limit" && k !== "opts") return false;
	if (!own(v, "path") || !own(v, "mode")) return false;
	if (typeof v.path !== "string" || v.path.length < 1) return false;
	if (v.mode !== "r" && v.mode !== "w" && v.mode !== "a") return false;
	if (own(v, "limit")) {
		const l = v.limit;
		if (typeof l !== "number" || !Number.isInteger(l) || l < 0 || l > 1000) return false;
	}
	if (own(v, "opts")) {
		const o = v.opts;
		if (!isObj(o)) return false;
		for (const k of Object.keys(o)) if (k !== "encoding" && k !== "flags" && k !== "deep") return false;
		if (!own(o, "encoding")) return false;
		if (typeof o.encoding !== "string" && o.encoding !== null) return false;
		if (own(o, "flags")) {
			if (!Array.isArray(o.flags)) return false;
			for (const f of o.flags) if (typeof f !== "string") return false;
		}
		if (own(o, "deep")) {
			const d = o.deep;
			if (!isObj(d) || !own(d, "n") || typeof d.n !== "number" || !Number.isFinite(d.n)) return false;
		}
	}
	return true;
}

function time(label: string, fn: () => boolean, iters: number): number {
	let sink = 0;
	for (let i = 0; i < iters / 10; i++) fn() && sink++; // warm up
	const t0 = Bun.nanoseconds();
	for (let i = 0; i < iters; i++) fn() && sink++;
	const ns = (Bun.nanoseconds() - t0) / iters;
	if (sink === 0) throw new Error("validator rejected the sample value");
	console.log(`${label.padEnd(28)} ${ns.toFixed(1).padStart(9)} ns/op`);
	return ns;
}

const t0 = Bun.nanoseconds();
const compiled = compile(schema);
console.log(`${"compile (once)".padEnd(28)} ${(Bun.nanoseconds() - t0).toFixed(0).padStart(9)} ns`);
console.log(`agreement on sample: ${compiled.check(value) === handWritten(value)}`);
const bad = { ...value, limit: 5000 };
console.log(`agreement on bad sample: ${compiled.check(bad) === handWritten(bad)}`);

const N = 2_000_000;
time("compiled.check", () => compiled.check(value), N);
time("hand-written", () => handWritten(value), N);
time("compiled.errors (valid)", () => compiled.errors(value).length === 0, N / 4);
