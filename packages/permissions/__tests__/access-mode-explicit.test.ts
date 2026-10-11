/**
 * Every tool that resolves a path through the guard must say whether it reads or writes.
 * A call that leaves the access mode out silently takes the strict default and hides intent.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SKIP = new Set(["node_modules", ".git", "dist", "__tests__"]);

function sources(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(e.name)) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) sources(full, out);
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
	}
	return out;
}

/** Top-level arguments of the call whose "(" is at `open`. */
function args(src: string, open: number): string[] {
	const list: string[] = [];
	let depth = 0;
	let cur = "";
	let q = "";
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (q) {
			cur += c;
			if (c === "\\") cur += src[++i] ?? "";
			else if (c === q) q = "";
			continue;
		}
		if (c === '"' || c === "'" || c === "`") q = c;
		if ("([{".includes(c)) {
			if (depth++ === 0) continue;
		} else if (")]}".includes(c)) {
			if (--depth === 0) {
				if (cur.trim()) list.push(cur.trim());
				return list;
			}
		} else if (c === "," && depth === 1) {
			list.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	return list;
}

/** Function name -> position of its access argument. */
const GUARDED: Record<string, number> = { safePath: 3, guardPath: 4, validatePath: 4, resolvePath: 2 };

describe("path guard callers name their access mode", () => {
	const offenders: string[] = [];
	for (const dir of ["packages", "apps"]) {
		const base = path.join(ROOT, dir);
		if (!fs.existsSync(base)) continue;
		for (const file of sources(base)) {
			const src = fs.readFileSync(file, "utf8");
			for (const [fn, want] of Object.entries(GUARDED)) {
				// resolvePath is a common name; only the tool layer's guarded one counts
				if (fn === "resolvePath" && !file.endsWith(path.join("ai", "tools.ts"))) continue;
				for (const m of src.matchAll(new RegExp(`(?<![\\w.])${fn}\\(`, "g"))) {
					// skip declarations (function safePath(...), imports)
					if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 12), m.index))) continue;
					const a = args(src, m.index! + fn.length);
					if (a.length < want || !/^("read"|"write"|access|.*\?\s*"read"\s*:\s*"write")$/.test(a[want - 1]))
						offenders.push(`${path.relative(ROOT, file)}: ${fn}(${a.join(", ").slice(0, 60)})`);
				}
			}
		}
	}
	test("no safePath, validatePath or resolvePath call leaves the access mode implicit", () => {
		expect(offenders).toEqual([]);
	});
});
