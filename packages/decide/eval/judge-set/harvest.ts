#!/usr/bin/env bun
/**
 * Harvest the judge set from labels the repo's tests already assert. No command is written
 * here: every row is a string literal from a test fixture (or the 23 Oct 8J eval cases), and
 * its label is the verdict that test asserts for it.
 *
 *   bun harvest.ts --cases <cases.json> > harvested.json
 *
 * Sources are read at pinned git refs (SOURCES) through the TypeScript AST. Label rule (8EO,
 * 23 Oct 2026): an asserted block or escalate is risky, an asserted allow (or "ran") is safe;
 * an asserted "pass" (the rules decline to decide) is not a safety label and is skipped.
 *
 * Patterns read, per file:
 *   tuple    [cmd, "block" | "escalate" | "pass", ...] inside an array literal (rules.test.ts check())
 *   rules    expect(decideRules(cmd, ...).verdict).toBe(V)
 *   corpus   expect(verdicts(ARR, ...)).toEqual(all(ARR, V)), ARR a literal array or a const naming one
 *   loop     for (const [cmd, ...] | cmd of ARR) { ... .verdict).toBe(V) ... | .run).toBe(true) ... }
 *   rows     { command: cmd, expect: ALL("ran" | "blocked") | { default: ..., ... } } (run_command corpus)
 *   gate     const r = await systemOneGate(cmd, ...); expect(r.run).toBe(true) in the same block
 *   arrays   const DESTRUCTIVE / SAFE string arrays (eval/commands.ts)
 * Commands carrying the gate tests' stub markers (SYS1_) are judge stubs, not commands: skipped.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface Row {
	cmd: string;
	risky: boolean;
	/** "<file>@<short sha>" or "8j-eval-2026-10-23". */
	src: string;
	/** Which pattern read it. */
	how: string;
	/** Rows read from one array literal share this: variants of one shape. */
	block: string;
}

export const SOURCES: Array<{ ref: string; file: string }> = [
	{ ref: "44304d957555fba470be6e0d537dc721eec67d7e", file: "packages/decide/eval/commands.ts" },
	{ ref: "44304d957555fba470be6e0d537dc721eec67d7e", file: "packages/decide/rules.test.ts" },
	{ ref: "44304d957555fba470be6e0d537dc721eec67d7e", file: "packages/decide/guard-bypass.test.ts" },
	{
		ref: "44304d957555fba470be6e0d537dc721eec67d7e",
		file: "packages/permissions/run-command-corpus.test.ts",
	},
	{
		ref: "44304d957555fba470be6e0d537dc721eec67d7e",
		file: "packages/permissions/system-one-gate.test.ts",
	},
	// branch fix/guard-rules-gaps, not yet on main
	{
		ref: "74d7903f54e8ca7c78d60559d727422a9fbb835e",
		file: "packages/permissions/guard-rules-gaps.test.ts",
	},
];

const STUB = /SYS1_/;

function text(n: ts.Node | undefined): string | null {
	if (!n) return null;
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
	return null;
}

function verdictRisky(v: string | null): boolean | null {
	if (v === "block" || v === "escalate" || v === "blocked" || v === "asked") return true;
	if (v === "allow" || v === "ran") return false;
	return null; // "pass" and anything else: no safety label
}

/** The const array literal an identifier names, searched from the whole file. */
function arrayOf(sf: ts.SourceFile, node: ts.Expression): ts.ArrayLiteralExpression | null {
	if (ts.isArrayLiteralExpression(node)) return node;
	if (!ts.isIdentifier(node)) return null;
	let found: ts.ArrayLiteralExpression | null = null;
	const visit = (n: ts.Node) => {
		if (found) return;
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === node.text) {
			let init = n.initializer;
			while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)))
				init = init.expression;
			if (init && ts.isArrayLiteralExpression(init)) found = init;
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return found;
}

/** First string of each element: "cmd" or ["cmd", ...]. Elements that are not literal are skipped. */
function commandsIn(arr: ts.ArrayLiteralExpression): string[] {
	const out: string[] = [];
	for (const e of arr.elements) {
		const t = text(e) ?? (ts.isArrayLiteralExpression(e) ? text(e.elements[0]) : null);
		if (t !== null) out.push(t);
	}
	return out;
}

function callName(n: ts.Node): string | null {
	return ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text : null;
}

/** expect(X).toBe(V) / toEqual(V): returns [X, V-node] */
function expectation(n: ts.Node): [ts.Expression, ts.Expression, string] | null {
	if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return null;
	const m = n.expression.name.text;
	if (m !== "toBe" && m !== "toEqual") return null;
	const inner = n.expression.expression;
	if (callName(inner) !== "expect") return null;
	return [(inner as ts.CallExpression).arguments[0], n.arguments[0], m];
}

export function harvestFile(source: string, file: string, src: string): Row[] {
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const rows: Row[] = [];
	const at = (n: ts.Node) => `${src}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
	const add = (cmd: string, risky: boolean | null, how: string, block: string) => {
		if (risky === null || STUB.test(cmd) || cmd.trim() === "") return;
		rows.push({ cmd, risky, src, how, block });
	};

	const visit = (n: ts.Node) => {
		// tuple: [cmd, "block" | "escalate", ...] inside an array literal
		if (ts.isArrayLiteralExpression(n)) {
			const tuples = n.elements.filter(
				(e): e is ts.ArrayLiteralExpression =>
					ts.isArrayLiteralExpression(e) &&
					text(e.elements[0]) !== null &&
					["block", "escalate", "pass"].includes(text(e.elements[1]) ?? ""),
			);
			for (const t of tuples)
				add(text(t.elements[0]) as string, verdictRisky(text(t.elements[1])), "tuple", at(n));
		}
		const ex = expectation(n);
		if (ex) {
			const [subject, value] = ex;
			// rules: expect(decideRules(cmd, ...).verdict).toBe(V)
			if (
				ts.isPropertyAccessExpression(subject) &&
				subject.name.text === "verdict" &&
				callName(subject.expression) === "decideRules"
			) {
				const cmd = text((subject.expression as ts.CallExpression).arguments[0]);
				if (cmd !== null) add(cmd, verdictRisky(text(value)), "rules", at(n));
			}
			// corpus: expect(verdicts(ARR, ...)).toEqual(all(ARR, V))
			if (callName(subject) === "verdicts" && callName(value) === "all") {
				const arr = arrayOf(sf, (subject as ts.CallExpression).arguments[0]);
				const v = text((value as ts.CallExpression).arguments[1]);
				if (arr) for (const cmd of commandsIn(arr)) add(cmd, verdictRisky(v), "corpus", at(arr));
			}
		}
		// loop: for (const ... of ARR) { asserted verdict or run }
		if (ts.isForOfStatement(n)) {
			const arr = arrayOf(sf, n.expression);
			const body = n.statement.getText(sf);
			const v =
				/\.verdict\)\.toBe\("(block|escalate)"\)/.exec(body)?.[1] ??
				(/\.run\)\.toBe\(true\)/.test(body) ? "allow" : null);
			if (arr && v) for (const cmd of commandsIn(arr)) add(cmd, verdictRisky(v), "loop", at(arr));
		}
		// rows: { command: cmd, expect: ALL("ran") | { mode: decision } }
		if (ts.isObjectLiteralExpression(n)) {
			const prop = (k: string) =>
				n.properties.find(
					(p): p is ts.PropertyAssignment =>
						ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === k,
				)?.initializer;
			const cmd = text(prop("command"));
			const exp = prop("expect");
			if (cmd !== null && exp) {
				const decisions =
					callName(exp) === "ALL"
						? [text((exp as ts.CallExpression).arguments[0])]
						: ts.isObjectLiteralExpression(exp)
							? exp.properties.map((p) => (ts.isPropertyAssignment(p) ? text(p.initializer) : null))
							: [];
				const labels = decisions.map(verdictRisky);
				const risky = labels.includes(true)
					? true
					: labels.length && labels.every((l) => l === false)
						? false
						: null;
				add(cmd, risky, "rows", at(n));
			}
		}
		// gate: const r = await systemOneGate(cmd, ...); expect(r.run).toBe(true) in the same block
		if (ts.isBlock(n)) {
			for (const st of n.statements) {
				if (!ts.isVariableStatement(st)) continue;
				for (const d of st.declarationList.declarations) {
					let init = d.initializer;
					if (init && ts.isAwaitExpression(init)) init = init.expression;
					if (!init || callName(init) !== "systemOneGate" || !ts.isIdentifier(d.name)) continue;
					const args = (init as ts.CallExpression).arguments;
					const cmd = text(args[0]);
					// A budget override or a mode flag in the env makes the outcome about the gate, not the command.
					if (cmd === null || /TIMEOUT|FLAG/.test(args[1]?.getText(sf) ?? "")) continue;
					const name = d.name.text;
					if (new RegExp(`expect\\(${name}\\.run\\)\\.toBe\\(true\\)`).test(n.getText(sf)))
						add(cmd, false, "gate", at(st));
				}
			}
		}
		// arrays: eval/commands.ts DESTRUCTIVE / SAFE
		if (
			ts.isVariableDeclaration(n) &&
			ts.isIdentifier(n.name) &&
			/^(DESTRUCTIVE|SAFE)$/.test(n.name.text) &&
			file.endsWith("eval/commands.ts")
		) {
			const arr = arrayOf(sf, n.name);
			if (arr)
				for (const cmd of commandsIn(arr))
					add(cmd, n.name.text === "DESTRUCTIVE", "arrays", at(arr));
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return rows;
}

export function harvest(casesPath: string, repo: string): Row[] {
	const rows: Row[] = [];
	for (const s of SOURCES) {
		const body = execFileSync("git", ["-C", repo, "show", `${s.ref}:${s.file}`], {
			encoding: "utf8",
		});
		rows.push(...harvestFile(body, s.file, `${s.file}@${s.ref.slice(0, 9)}`));
	}
	const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Array<{
		cmd: string;
		risky: boolean;
		src: string;
	}>;
	for (const c of cases)
		rows.push({
			cmd: c.cmd,
			risky: c.risky,
			src: "8j-eval-2026-10-23",
			how: c.src,
			block: `8j-eval:${c.src}`,
		});
	return rows;
}

if (import.meta.main) {
	const i = process.argv.indexOf("--cases");
	if (i < 0) throw new Error("usage: bun harvest.ts --cases <cases.json>");
	const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	process.stdout.write(`${JSON.stringify(harvest(process.argv[i + 1], repo), null, 1)}\n`);
}
