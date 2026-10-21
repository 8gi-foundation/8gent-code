/**
 * In-process file search (#4633): a directory walk plus a line regex, in plain
 * node:fs and node:path. It never spawns a process, so it behaves the same on
 * macOS, Linux, Windows PowerShell and Termux, and no shell string can carry
 * injection. Respects .gitignore (root and nested), skips binary and oversize
 * files, caps results, and returns hits in sorted path order so the same tree
 * gives the same answer on every host. Paths in results are always "/".
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SearchHit {
	file: string;
	line: number;
	text: string;
}

export interface SearchOptions {
	root: string;
	/** Content to find. Omit to list files only. */
	pattern?: string;
	/** Treat `pattern` as plain text instead of a regex. */
	literal?: boolean;
	/** Case-insensitive; default is smart case (insensitive unless the pattern has a capital). */
	ignoreCase?: boolean;
	/** Only files whose relative path matches this glob (for example "*.ts" or "src/**" plus "/*.tsx"). */
	glob?: string;
	maxResults?: number;
	maxPerFile?: number;
	maxFileBytes?: number;
}

export interface SearchResult {
	hits: SearchHit[];
	files: string[];
	filesScanned: number;
	truncated: boolean;
}

const ALWAYS_SKIP = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILE = /\.(lock|min\.js|map)$/;

/** Translate a glob to a RegExp over a "/"-separated relative path. */
export function globToRegExp(glob: string, anchored = true): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}$`);
}

interface IgnoreRule {
	re: RegExp;
	negate: boolean;
	dirOnly: boolean;
}
interface Scope {
	base: string;
	rules: IgnoreRule[];
}

/** Parse .gitignore text into rules relative to the directory holding it. */
export function parseGitignore(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (let line of text.split(/\r?\n/)) {
		line = line.replace(/\s+$/, "");
		if (!line || line.startsWith("#")) continue;
		const negate = line.startsWith("!");
		if (negate) line = line.slice(1);
		const dirOnly = line.endsWith("/");
		if (dirOnly) line = line.slice(0, -1);
		const anchored = line.includes("/");
		line = line.replace(/^\//, "");
		if (!line) continue;
		rules.push({ re: globToRegExp(line, anchored), negate, dirOnly });
	}
	return rules;
}

function isIgnored(rel: string, isDir: boolean, scopes: Scope[]): boolean {
	let ignored = false;
	for (const { base, rules } of scopes) {
		const sub = base ? rel.slice(base.length + 1) : rel;
		for (const r of rules) {
			if (r.dirOnly && !isDir) continue;
			if (r.re.test(sub)) ignored = !r.negate;
		}
	}
	return ignored;
}

export async function searchFiles(opts: SearchOptions): Promise<SearchResult> {
	const root = path.resolve(opts.root);
	const maxResults = opts.maxResults ?? 200;
	const maxPerFile = opts.maxPerFile ?? 20;
	const maxBytes = opts.maxFileBytes ?? 1_000_000;
	const fileGlob = opts.glob ? globToRegExp(opts.glob, opts.glob.includes("/")) : null;
	const out: SearchResult = { hits: [], files: [], filesScanned: 0, truncated: false };

	// 1. Walk: sorted, ignore-aware list of candidate files (relative, "/"-separated).
	const candidates: string[] = [];
	const walk = (dir: string, rel: string, inherited: Scope[]): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		let scopes = inherited;
		if (entries.some((e) => e.name === ".gitignore" && e.isFile())) {
			try {
				const rules = parseGitignore(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"));
				scopes = [...inherited, { base: rel, rules }];
			} catch {}
		}
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			const isDir = e.isDirectory();
			if (!isDir && !e.isFile()) continue; // symlinks are not followed
			if (isDir ? ALWAYS_SKIP.has(e.name) : SKIP_FILE.test(e.name)) continue;
			if (isIgnored(childRel, isDir, scopes)) continue;
			if (isDir) walk(path.join(dir, e.name), childRel, scopes);
			else if (!fileGlob || fileGlob.test(childRel)) candidates.push(childRel);
		}
	};
	walk(root, "", []);

	if (!opts.pattern) {
		out.truncated = candidates.length > maxResults;
		out.files = candidates.slice(0, maxResults);
		return out;
	}

	// 2. Scan: read files in parallel batches, judge them in path order.
	const src = opts.literal ? opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : opts.pattern;
	const insensitive = opts.ignoreCase ?? !/[A-Z]/.test(opts.pattern);
	const matcher = new RegExp(src, insensitive ? "i" : "");
	const whole = new RegExp(src, insensitive ? "im" : "m");
	// For an ASCII pattern, test raw bytes as latin1 (a 1:1 decode, far cheaper than
	// utf8) and decode properly only a candidate file.
	const asciiPattern = /^[\x20-\x7e]*$/.test(src);
	const BATCH = 64;
	for (let i = 0; i < candidates.length && !out.truncated; i += BATCH) {
		const batch = candidates.slice(i, i + BATCH);
		const bufs = await Promise.all(
			batch.map((rel) =>
				fs.promises.readFile(path.join(root, ...rel.split("/"))).catch(() => null),
			),
		);
		for (let j = 0; j < batch.length && !out.truncated; j++) {
			const buf = bufs[j];
			if (!buf || buf.length > maxBytes || buf.subarray(0, 8192).includes(0)) continue; // unreadable, big or binary
			out.filesScanned++;
			if (asciiPattern && !whole.test(buf.toString("latin1"))) continue;
			const text = buf.toString("utf8");
			if (!asciiPattern && !whole.test(text)) continue;
			let perFile = 0;
			const lines = text.split(/\r?\n/);
			for (let n = 0; n < lines.length; n++) {
				if (!matcher.test(lines[n])) continue;
				out.hits.push({ file: batch[j], line: n + 1, text: lines[n].slice(0, 300) });
				if (out.hits.length >= maxResults) {
					out.truncated = true;
					break;
				}
				if (++perFile >= maxPerFile) break;
			}
		}
	}
	return out;
}

/** Render a result as "file:line:text" rows (or file names), with a cap note. */
export function formatSearch(r: SearchResult): string {
	const rows = r.hits.length > 0 ? r.hits.map((h) => `${h.file}:${h.line}:${h.text}`) : r.files;
	if (rows.length === 0) return "No matches.";
	return (
		rows.join("\n") +
		(r.truncated ? "\n[truncated: result cap reached, narrow the pattern or glob]" : "")
	);
}
