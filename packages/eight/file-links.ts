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
const MAX_FILES = 600;
const MAX_LISTED = 8;
const SPEC =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;

function resolveSpec(fromFile: string, spec: string): string | undefined {
	const base = path.resolve(path.dirname(fromFile), spec);
	const stem = base.replace(/\.(js|jsx|mjs)$/, "");
	const tries = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"].map((e) => stem + e)];
	for (const e of [".ts", ".tsx", ".js", ".jsx"]) tries.push(path.join(base, `index${e}`));
	return tries.find((p) => CODE.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
}

/** Absolute paths of the existing local files `content` imports. */
export function localImports(file: string, content: string): string[] {
	const out = new Set<string>();
	for (const m of content.matchAll(SPEC)) {
		const hit = resolveSpec(file, m[1]);
		if (hit && hit !== file) out.add(hit);
	}
	return [...out];
}

function codeFiles(root: string): string[] {
	const found: string[] = [];
	const stack = [root];
	while (stack.length && found.length < MAX_FILES) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(path.join(dir, e.name));
			} else if (e.isFile() && CODE.test(e.name) && found.length < MAX_FILES) {
				found.push(path.join(dir, e.name));
			}
		}
	}
	return found;
}

function list(files: string[], cwd: string): string {
	const rel = files.map((f) => path.relative(cwd, f)).sort();
	const shown = rel.slice(0, MAX_LISTED).join(", ");
	return rel.length > MAX_LISTED ? `${shown} (+${rel.length - MAX_LISTED} more)` : shown;
}

/** "" when `file` is not code or every linked file has been read. */
export function linksFooter(
	file: string,
	content: string,
	seen: ReadonlySet<string>,
	cwd: string,
): string {
	if (!CODE.test(file)) return "";
	const imports = localImports(file, content).filter((f) => !seen.has(f));
	const importers = codeFiles(cwd).filter((f) => {
		if (f === file || seen.has(f)) return false;
		try {
			return localImports(f, fs.readFileSync(f, "utf-8")).includes(file);
		} catch {
			return false;
		}
	});
	const parts: string[] = [];
	if (imports.length) parts.push(`Local imports not read yet: ${list(imports, cwd)}.`);
	if (importers.length) parts.push(`Imported by, not read yet: ${list(importers, cwd)}.`);
	return parts.length ? `[${parts.join(" ")}]` : "";
}
