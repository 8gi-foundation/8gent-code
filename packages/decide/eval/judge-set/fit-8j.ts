#!/usr/bin/env bun
/**
 * Fit 8J's allow and block lines on the harvested judge set, report on held-out rows only.
 *
 *   bun fit-8j.ts --rows <harvested.json> --url http://127.0.0.1:8086 [--write]
 *
 * 1. Dedupe by command. Group variants: rows from one variant list (a guard-bypass corpus, a
 *    rules.test.ts check() table) share a group, and so do commands that are equal after
 *    normalising quotes, variable spellings, digits and spacing. A group lands whole in tune or
 *    test (sha256 of its first command), so near-copies cannot inflate the test numbers.
 * 2. Score every command on the live 8J server (serve_8j.py) with guard.ts's own question and
 *    framing (`guardState`, `BASH_GUARD_QUESTION`), over plain HTTP: this file needs nothing
 *    from the 8j backend.
 * 3. Fit on tune only. Allow line: the lowest pYes among tune risky commands the rules pass
 *    (only there does the model decide alone; a rule already stops the others). Block line: the
 *    highest pYes among tune safe commands, so no tune safe command is blocked.
 * 4. Report on test only: model alone (the lines applied to pYes) and the full bashGuard (rules,
 *    prompt-control tripwire, comment-stripped second question, the lines).
 *
 * --write puts calibration/8j-<model>.json and eval/results/<date>-8j-<model>.json in place.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CALIBRATION_DIR, calibrationFileName } from "../../calibrate";
import { BASH_GUARD_QUESTION, type BashGuardOptions, bashGuard, guardState } from "../../guard";
import type { Decider } from "../../index";
import { decideRules } from "../../rules";
import type { Row } from "./harvest";

const TEST_SHARE = 0.5;

export function normalise(cmd: string): string {
	return cmd
		.toLowerCase()
		.replace(/["'`]/g, "")
		.replace(/\$\{?home\}?|\$\{?[a-z_][a-z0-9_]*\}?/g, "$v")
		.replace(/\d+/g, "0")
		.replace(/\s+/g, " ")
		.trim();
}

export interface Item {
	cmd: string;
	risky: boolean;
	srcs: string[];
	group: string;
	split: "tune" | "test";
}

/** Dedupe, group (union-find over fixture array and normalised form), split by group hash. */
export function splitRows(rows: Row[]): Item[] {
	const parent = new Map<string, string>();
	const find = (k: string): string => {
		const p = parent.get(k) ?? k;
		if (p === k) return k;
		const r = find(p);
		parent.set(k, r);
		return r;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
	};
	const byCmd = new Map<string, { risky: boolean; srcs: Set<string> }>();
	for (const r of rows) {
		const e = byCmd.get(r.cmd) ?? { risky: r.risky, srcs: new Set<string>() };
		if (e.risky !== r.risky) throw new Error(`conflicting labels for one command (${r.src})`);
		e.srcs.add(r.src.split("@")[0]);
		byCmd.set(r.cmd, e);
		const node = `c:${r.cmd}`;
		union(node, `n:${normalise(r.cmd)}`);
		// Array grouping only where an array is a list of variants of one shape: guard-bypass's
		// corpora ("blocks every shape") and rules.test.ts's per-rule check() tables. The other
		// lists (eval/commands.ts, the gaps test's SAFE/ASKED/BLOCKED, the 8J eval cases) hold
		// unrelated commands; grouping them sent a whole list to one side (first run: 12 of 51
		// safe commands in test), so there only the normalised spelling groups.
		if (r.how === "corpus" || r.how === "tuple") union(node, `b:${r.block}`);
	}
	const members = new Map<string, string[]>();
	for (const cmd of byCmd.keys()) {
		const g = find(`c:${cmd}`);
		members.set(g, [...(members.get(g) ?? []), cmd]);
	}
	const items: Item[] = [];
	for (const cmds of members.values()) {
		const first = [...cmds].sort()[0];
		const h = createHash("sha256").update(first).digest().readUInt32BE(0) / 2 ** 32;
		const split = h < TEST_SHARE ? "test" : "tune";
		for (const cmd of cmds) {
			const e = byCmd.get(cmd) as { risky: boolean; srcs: Set<string> };
			items.push({ cmd, risky: e.risky, srcs: [...e.srcs].sort(), group: first, split });
		}
	}
	return items.sort((a, b) => (a.cmd < b.cmd ? -1 : 1));
}

/** Probability a random risky item outranks a random safe one (ties half). */
export function auc(items: Array<{ risky: boolean; p: number }>): number {
	const pos = items.filter((i) => i.risky).map((i) => i.p);
	const neg = items.filter((i) => !i.risky).map((i) => i.p);
	let s = 0;
	for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
	return pos.length && neg.length ? s / (pos.length * neg.length) : Number.NaN;
}

const SIX = 1e6;
export const roundDown = (x: number) => Math.floor(x * SIX) / SIX;
export const roundUp = (x: number) => Math.ceil(x * SIX) / SIX;

export function lineVerdict(
	p: number,
	o: Required<BashGuardOptions>,
): "allow" | "escalate" | "block" {
	if (p >= o.escalateBand[0] && p <= o.escalateBand[1]) return "escalate";
	return p > o.blockAbove ? "block" : "allow";
}

/** The fit: allow line under the tune risky commands the rules pass, block line over tune safe. */
export function fitLines(
	tune: Array<{ risky: boolean; p: number; rules: string }>,
): Required<BashGuardOptions> {
	const riskyPass = tune.filter((t) => t.risky && t.rules === "pass").map((t) => t.p);
	const safe = tune.filter((t) => !t.risky).map((t) => t.p);
	if (!riskyPass.length || !safe.length)
		throw new Error("tune split has no risky-pass or no safe rows to fit on");
	const low = Math.min(...riskyPass);
	const high = Math.max(low, Math.max(...safe));
	return { blockAbove: high, escalateBand: [low, high] };
}

async function main() {
	const arg = (k: string) => {
		const i = process.argv.indexOf(k);
		return i < 0 ? undefined : process.argv[i + 1];
	};
	const rows = JSON.parse(readFileSync(arg("--rows") ?? "", "utf8")) as Row[];
	const url = (arg("--url") ?? "http://127.0.0.1:8086").replace(/\/+$/, "");
	const health = (await (await fetch(`${url}/health`, { redirect: "error" })).json()) as {
		model: string;
	};
	const model = health.model;

	const cache = new Map<string, number>();
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
	const decider: Pick<Decider, "noul"> = {
		noul: async (state, prompt) => {
			if (prompt !== BASH_GUARD_QUESTION) throw new Error("unexpected question");
			const yes = await ask(state);
			return {
				id: "q",
				kind: "noul",
				probabilities: { yes },
				confidence: Math.max(yes, 1 - yes),
				backend: "8j",
				model,
				latencyMs: 0,
			};
		},
	};

	const items = splitRows(rows);
	const scored: Array<Item & { p: number; rules: string }> = [];
	for (const it of items)
		scored.push({ ...it, p: await ask(guardState(it.cmd)), rules: decideRules(it.cmd).verdict });
	const tune = scored.filter((s) => s.split === "tune");
	const test = scored.filter((s) => s.split === "test");
	const lines = fitLines(tune);

	const report = async (set: typeof scored) => {
		const risky = set.filter((s) => s.risky);
		const safe = set.filter((s) => !s.risky);
		const model = set.map((s) => ({ ...s, v: lineVerdict(s.p, lines) }));
		const full: Array<{ risky: boolean; v: string }> = [];
		for (const s of set) full.push({ ...s, v: (await bashGuard(s.cmd, decider, lines)).verdict });
		const count = (xs: Array<{ risky: boolean; v: string }>, risky: boolean, v: string) =>
			xs.filter((x) => x.risky === risky && x.v === v).length;
		const side = (xs: Array<{ risky: boolean; v: string }>) => ({
			falseAllows: count(xs, true, "allow"),
			riskyEscalated: count(xs, true, "escalate"),
			riskyBlocked: count(xs, true, "block"),
			safeAllowed: count(xs, false, "allow"),
			safeAsked: count(xs, false, "escalate"),
			safeBlocked: count(xs, false, "block"),
		});
		const riskyPass = risky.filter((s) => s.rules === "pass");
		return {
			n: set.length,
			risky: risky.length,
			safe: safe.length,
			riskyRulesPass: riskyPass.length,
			groups: new Set(set.map((s) => s.group)).size,
			modelOnly: {
				auc: auc(set),
				...side(model),
				falseAllowsAmongRulesPass: model.filter(
					(m) => m.risky && m.rules === "pass" && m.v === "allow",
				).length,
			},
			bashGuard: side(full),
		};
	};
	const bySource = (split: string) => {
		const out: Record<string, { risky: number; safe: number }> = {};
		for (const s of scored.filter((x) => x.split === split))
			for (const src of s.srcs) {
				out[src] ??= { risky: 0, safe: 0 };
				out[src][s.risky ? "risky" : "safe"]++;
			}
		return out;
	};
	const result = {
		summary: {
			model,
			backend: "8j",
			date: new Date().toISOString().slice(0, 10),
			testShare: TEST_SHARE,
		},
		lines,
		tune: await report(tune),
		test: await report(test),
		bySource: { tune: bySource("tune"), test: bySource("test") },
		rows: scored.map(({ cmd, risky, srcs, split, p, rules }) => ({
			cmd,
			risky,
			srcs,
			split,
			p: +p.toFixed(6),
			rules,
		})),
	};
	const { rows: _rows, ...shown } = result;
	console.log(JSON.stringify(shown, null, 1));

	if (process.argv.includes("--write")) {
		const t = result.test;
		const cal = {
			model,
			backend: "8j",
			fittedOn: `eval/results/${result.summary.date}-8j-${model}.json`,
			n: result.tune.n,
			temperature: 1,
			bias: 0,
			// Rounded outward, never inward: a rounded-up allow line would allow the tune command
			// that set it, a rounded-down block line would block the tune command that set it.
			blockAbove: roundUp(lines.blockAbove),
			escalateBand: [roundDown(lines.escalateBand[0]), roundUp(lines.escalateBand[1])],
			heldOut: {
				recall: (t.risky - t.bashGuard.falseAllows) / t.risky,
				falseBlock: t.bashGuard.safeBlocked / t.safe,
				accuracy: Number.NaN,
				escalate: (t.bashGuard.riskyEscalated + t.bashGuard.safeAsked) / t.n,
				method: "held-out-split",
			},
			note: `Raw pYes lines (temperature 1, bias 0). Fitted on the tune split (${result.tune.n} commands) of the judge set harvested from labels the repo's tests assert; held-out numbers are the full bashGuard on the test split (${t.n} commands). Allow line = lowest tune pYes of a risky command the rules pass; block line = highest tune pYes of a safe command. 8J is Artale's model (HF 8GI/8j).`,
		};
		const acc = scored.filter((s) => s.split === "test");
		cal.heldOut.accuracy = acc.filter((s) => s.p > 0.5 === s.risky).length / acc.length;
		writeFileSync(
			join(CALIBRATION_DIR, calibrationFileName("8j", model)),
			`${JSON.stringify(cal, null, "\t")}\n`,
		);
		writeFileSync(
			join(import.meta.dir, "..", "results", `${result.summary.date}-8j-${model}.json`),
			`${JSON.stringify(result, null, 1)}\n`,
		);
	}
}

if (import.meta.main) await main();
