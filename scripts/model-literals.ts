#!/usr/bin/env bun
/**
 * Inventory of hardcoded model-name literals in product code.
 *
 * For every 8gent user, so the model they run is one their provider offers
 * today, never a name frozen in our code that has gone stale.
 *
 * DEFINITION (the one this file and its guard test use):
 *   A "model literal" is a single-line quoted string ('...', "..." or `...`)
 *   that contains no whitespace and contains, at a token boundary
 *   (not preceded by a letter or digit), one of these families, case-insensitive:
 *     qwen | llama | gemma | gpt- | claude- | mistral- | minimax- | deepseek- | eight-<digit>
 *   (the runtime names llama-server, llamacpp and the CLI name claude-code are
 *   not models and do not match; neither do file paths ending .json/.ts/.js etc.), or that ends in the OpenRouter alias suffix ":free" (covers `auto:free`
 *   and `vendor/model:free`).
 *   Scanned: git-tracked .ts .tsx .js .jsx .mjs .cjs files.
 *   Excluded: tests (*.test.*, *.spec.*), any path segment __tests__, test,
 *   tests, fixture(s), snapshot(s), __snapshots__, node_modules, markdown,
 *   and this script, its guard test and its allow-list.
 *
 * Usage: bun scripts/model-literals.ts [--json]
 *   default: per-file counts, then total; lists file:line literal.
 *   --json:  machine output {total, byFile, hits:[{file,line,literal}]}.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Hit {
	file: string;
	line: number;
	literal: string;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDED_PATH =
	/(^|\/)(node_modules|__tests__|__snapshots__|tests?|fixtures?|snapshots?)\/|\.(test|spec)\.[a-z]+$/i;
const SELF = new Set([
	"scripts/model-literals.ts",
	"scripts/model-literals.allow.json",
	"packages/ci/model-literals-guard.test.ts",
]);
const FAMILY =
	/(?<![a-z0-9])(qwen|llama(?!cpp|-cpp|\.cpp|-server|$)|gemma|gpt-|claude-(?!code)|mistral-|minimax-|deepseek-|eight-\d)/i;
const FREE_ALIAS = /:free$/i;
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

export function isProductFile(path: string): boolean {
	return CODE_EXT.test(path) && !EXCLUDED_PATH.test(path) && !SELF.has(path);
}

export function findLiteralsInText(file: string, text: string): Hit[] {
	const hits: Hit[] = [];
	text.split("\n").forEach((line, i) => {
		for (const m of line.matchAll(QUOTED)) {
			const lit = m[2];
			if (!lit || /\s/.test(lit)) continue;
			if (/^\.{1,2}\//.test(lit) || /\.(json|jsx?|tsx?|mjs|cjs|md)$/i.test(lit)) continue;
			if (FAMILY.test(lit) || FREE_ALIAS.test(lit)) {
				hits.push({ file, line: i + 1, literal: lit });
			}
		}
	});
	return hits;
}

export function scan(root: string = ROOT): Hit[] {
	const r = spawnSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
	const hits: Hit[] = [];
	for (const f of r.stdout.split("\0").filter(Boolean).sort()) {
		if (!isProductFile(f)) continue;
		let text: string;
		try {
			text = readFileSync(join(root, f), "utf8");
		} catch {
			continue;
		}
		hits.push(...findLiteralsInText(f, text));
	}
	return hits;
}

export function countByFile(hits: Hit[]): Array<[string, number]> {
	const m = new Map<string, number>();
	for (const h of hits) m.set(h.file, (m.get(h.file) ?? 0) + 1);
	return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

if (import.meta.main) {
	const hits = scan();
	const byFile = countByFile(hits);
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify({ total: hits.length, byFile, hits }, null, 2));
	} else {
		for (const h of hits) console.log(`${h.file}:${h.line}  ${h.literal}`);
		console.log("\nPer file:");
		for (const [f, n] of byFile) console.log(`${String(n).padStart(5)}  ${f}`);
		console.log(`\nTOTAL ${hits.length} literals in ${byFile.length} files`);
	}
}
