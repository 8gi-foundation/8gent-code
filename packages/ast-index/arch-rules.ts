/**
 * 8gent Architecture Rules
 *
 * Checks the package-to-package import graph (built by dep-graph.ts) against
 * rules kept as data in architecture.rules.json:
 *   - forbidden: package A must not import package B
 *   - cycles: every import cycle among packages must sit inside a baseline
 *     cycle group, so the gate starts green and fails only on a new cycle.
 *
 * Usage: bun packages/ast-index/arch-rules.ts [--rules file] [--root dir] [--print-cycles]
 * Exit 0 = rules hold, 1 = violation, 2 = usage or read error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildDepGraph } from "./dep-graph";

export interface ArchRules {
	forbidden: { from: string; to: string; reason?: string }[];
	baselineCycleGroups: string[][];
}

/** pkg -> imported pkg -> one example "file -> file" edge, for the report */
export type PackageEdges = Map<string, Map<string, string>>;

const isTest = (f: string) => /\.(test|spec)\.[jt]sx?$|[\\/]__tests__[\\/]/.test(f);

/** Collapse the file graph under packagesDir to package edges (tests excluded). */
export function packageEdges(packagesDir: string): PackageEdges {
	const dir = path.resolve(packagesDir);
	const graph = buildDepGraph(dir, { "@8gent/": dir });
	const pkgOf = (f: string) => path.relative(dir, f).split(path.sep)[0];
	const edges: PackageEdges = new Map();
	for (const [file, node] of graph.nodes) {
		if (isTest(file)) continue;
		const from = pkgOf(file);
		if (!edges.has(from)) edges.set(from, new Map());
		for (const target of node.imports) {
			const to = pkgOf(target);
			if (to === from || isTest(target) || edges.get(from)!.has(to)) continue;
			edges.get(from)!.set(to, `${path.relative(dir, file)} -> ${path.relative(dir, target)}`);
		}
	}
	return edges;
}

/** Strongly connected components with more than one package (Tarjan). */
export function cycleGroups(edges: PackageEdges): string[][] {
	let next = 0;
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const groups: string[][] = [];
	const visit = (v: string) => {
		index.set(v, next);
		low.set(v, next++);
		stack.push(v);
		onStack.add(v);
		for (const w of edges.get(v)?.keys() ?? []) {
			if (!index.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
		}
		if (low.get(v) !== index.get(v)) return;
		const group: string[] = [];
		let w: string;
		do {
			w = stack.pop()!;
			onStack.delete(w);
			group.push(w);
		} while (w !== v);
		if (group.length > 1) groups.push(group.sort());
	};
	for (const v of [...edges.keys()].sort()) if (!index.has(v)) visit(v);
	return groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

export function mutualPairs(edges: PackageEdges): string[][] {
	const pairs: string[][] = [];
	for (const [a, tos] of edges)
		for (const b of tos.keys()) if (a < b && edges.get(b)?.has(a)) pairs.push([a, b]);
	return pairs.sort();
}

/** Returns one line per violation; empty means the rules hold. */
export function checkRules(edges: PackageEdges, rules: ArchRules): string[] {
	const out: string[] = [];
	for (const r of rules.forbidden) {
		const via = edges.get(r.from)?.get(r.to);
		if (via)
			out.push(
				`forbidden: ${r.from} must not import ${r.to}${r.reason ? ` (${r.reason})` : ""}; ${via}`,
			);
	}
	for (const group of cycleGroups(edges)) {
		const overlap = (b: string[]) => group.filter((p) => b.includes(p)).length;
		const best = [...rules.baselineCycleGroups].sort((x, y) => overlap(y) - overlap(x))[0] ?? [];
		const added = group.filter((p) => !best.includes(p));
		if (added.length)
			out.push(`new cycle: ${added.join(", ")} now in a cycle with ${group.join(", ")}`);
	}
	return out;
}

if (import.meta.main) {
	const arg = (flag: string, def: string) => {
		const i = process.argv.indexOf(flag);
		return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
	};
	const root = path.resolve(arg("--root", "."));
	let rules: ArchRules;
	try {
		rules = JSON.parse(
			fs.readFileSync(path.resolve(root, arg("--rules", "architecture.rules.json")), "utf-8"),
		);
		if (!Array.isArray(rules.forbidden) || !Array.isArray(rules.baselineCycleGroups))
			throw new Error("rules file needs forbidden[] and baselineCycleGroups[]");
	} catch (e) {
		console.error(`arch-rules: ${(e as Error).message}`);
		process.exit(2);
	}
	const edges = packageEdges(path.join(root, "packages"));
	const groups = cycleGroups(edges);
	const edgeCount = [...edges.values()].reduce((n, m) => n + m.size, 0);
	console.log(
		`arch-rules: ${edges.size} packages, ${edgeCount} edges, ${mutualPairs(edges).length} mutual pairs, ${groups.length} cycle groups (sizes ${groups.map((g) => g.length).join(", ") || "none"})`,
	);
	if (process.argv.includes("--print-cycles")) console.log(JSON.stringify(groups));
	const violations = checkRules(edges, rules);
	for (const v of violations) console.error(`  FAIL ${v}`);
	console.log(
		violations.length ? `arch-rules: ${violations.length} violation(s)` : "arch-rules: OK",
	);
	process.exit(violations.length ? 1 : 0);
}
