import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Footer for read_file on a code file: which files it imports, and which files
 * import it, that this session has not read yet. A value traced through a
 * chain (config -> worker -> retry) otherwise ends at the first file the model
 * thinks it can answer from; the pilot scenario conv-trace-config skipped
 * retry.ts three runs running because nothing named it.
 *
 * Deterministic, no model: a regex over import specifiers, a capped walk of the
 * working tree for importers.
 */

const CODE = /\.(ts|tsx|js|jsx|mts|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const MAX_LISTED = 8;
const SPEC =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;

export type Limits = { maxFiles: number; maxDirs: number; maxMs: number; now: () => number };
const LIMITS: Limits = { maxFiles: 600, maxDirs: 400, maxMs: 150, now: Date.now };

/** True when `file` really lives inside `root` once symlinks are resolved. */
function inside(file: string, root: string): boolean {
	try {
		const r = fs.realpathSync(root);
		const f = fs.realpathSync(file);
		return f === r || f.startsWith(r + path.sep);
	} catch {
		return false;
	}
}

/** Which files may be named: inside cwd by realpath, and whatever else `allow` says (the read deny policy). */
type Allow = (abs: string) => boolean;

function resolveSpec(fromFile: string, spec: string, ok: Allow): string | undefined {
	const base = path.resolve(path.dirname(fromFile), spec);
	const stem = base.replace(/\.(js|jsx|mjs)$/, "");
	const tries = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"].map((e) => stem + e)];
	for (const e of [".ts", ".tsx", ".js", ".jsx"]) tries.push(path.join(base, `index${e}`));
	return tries.find((p) => CODE.test(p) && fs.existsSync(p) && fs.statSync(p).isFile() && ok(p));
}

/** Absolute paths of the existing, allowed local files `content` imports. */
export function localImports(file: string, content: string, ok: Allow = () => true): string[] {
	const out = new Set<string>();
	for (const m of content.matchAll(SPEC)) {
		const hit = resolveSpec(file, m[1], ok);
		if (hit && hit !== file) out.add(hit);
	}
	return [...out];
}

function codeFiles(root: string, lim: Limits, t0: number): { files: string[]; truncated: boolean } {
	const files: string[] = [];
	const stack = [root];
	let dirs = 0;
	while (stack.length) {
		if (files.length >= lim.maxFiles || dirs >= lim.maxDirs || lim.now() - t0 > lim.maxMs) {
			return { files, truncated: true };
		}
		const dir = stack.pop() as string;
		dirs++;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(path.join(dir, e.name));
			} else if (e.isFile() && CODE.test(e.name)) {
				if (files.length >= lim.maxFiles) return { files, truncated: true };
				files.push(path.join(dir, e.name));
			}
		}
	}
	return { files, truncated: false };
}

function list(files: string[], cwd: string): string {
	const rel = files.map((f) => path.relative(cwd, f)).sort();
	const shown = rel.slice(0, MAX_LISTED).join(", ");
	return rel.length > MAX_LISTED ? `${shown} (+${rel.length - MAX_LISTED} more)` : shown;
}

/** "" when `file` is not code or every linked file has been read. `allow` adds the caller's read policy. */
export function linksFooter(
	file: string,
	content: string,
	seen: ReadonlySet<string>,
	cwd: string,
	allow: Allow = () => true,
	limits: Partial<Limits> = {},
): string {
	if (!CODE.test(file)) return "";
	const ok: Allow = (abs) => inside(abs, cwd) && allow(abs);
	const imports = localImports(file, content, ok).filter((f) => !seen.has(f));
	const lim = { ...LIMITS, ...limits };
	const t0 = lim.now();
	const walk = codeFiles(cwd, lim, t0);
	let truncated = walk.truncated;
	const importers = walk.files.filter((f) => {
		// One budget covers the walk and every importer read after it.
		if (lim.now() - t0 > lim.maxMs) {
			truncated = true;
			return false;
		}
		if (f === file || seen.has(f) || !ok(f)) return false;
		try {
			return localImports(f, fs.readFileSync(f, "utf-8"), ok).includes(file);
		} catch {
			return false;
		}
	});
	const parts: string[] = [];
	if (imports.length) parts.push(`Local imports not read yet: ${list(imports, cwd)}.`);
	if (importers.length) parts.push(`Imported by, not read yet: ${list(importers, cwd)}.`);
	if (truncated) parts.push("Importer search stopped early, so this list may be incomplete.");
	return parts.length ? `[${parts.join(" ")}]` : "";
}
