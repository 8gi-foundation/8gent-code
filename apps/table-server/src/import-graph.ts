/**
 * Static walk of a TypeScript module's runtime import graph, for the
 * "no node:child_process" guard. Bun's bundler tree-shakes an unused
 * `spawnSync` import away, so a bundle grep would pass even when the module
 * that imports it is still loaded (and executed) at startup. This walk follows
 * every value import, re-export, dynamic import and require; `import type` and
 * `export type` lines are skipped because they are erased before runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SPEC_RE =
	/(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(fromFile: string, spec: string): string | undefined {
	const base = path.resolve(path.dirname(fromFile), spec);
	const stem = base.replace(/\.(js|mjs|ts|tsx)$/, "");
	const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, path.join(base, "index.ts")];
	return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

export interface ImportGraph {
	/** Absolute paths of every local module reached. */
	files: Set<string>;
	/** Bare specifiers (node:*, bun:*, packages) with the files that import them. */
	external: Map<string, string[]>;
}

export function walkImports(entry: string): ImportGraph {
	const files = new Set<string>();
	const external = new Map<string, string[]>();
	const queue = [path.resolve(entry)];
	while (queue.length) {
		const file = queue.pop() as string;
		if (files.has(file)) continue;
		files.add(file);
		if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue; // e.g. schema.sql, inlined as text
		// Comments are NOT stripped: an import named in a comment can only add a false
		// positive, while a stripping regex fooled by "/*" inside a string could hide a real one.
		const src = fs.readFileSync(file, "utf8");
		for (const m of src.matchAll(SPEC_RE)) {
			if (m[2]) continue; // import type / export type
			const spec = (m[3] ?? m[4]) as string;
			if (spec.startsWith(".")) {
				const hit = resolveLocal(file, spec);
				if (!hit) throw new Error(`unresolved import ${spec} in ${file}`);
				queue.push(hit);
			} else {
				const by = external.get(spec) ?? [];
				by.push(file);
				external.set(spec, by);
			}
		}
	}
	return { files, external };
}
