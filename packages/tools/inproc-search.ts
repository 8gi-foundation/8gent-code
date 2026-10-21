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
import { WORKER_SOURCE } from "./inproc-search-worker-source";

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
	/** Required: veto an absolute path (the permissions path-guard). A denied directory is not entered, a denied file is not read; both are skipped silently. */
	allow: (absPath: string) => boolean;
	/** Wall-clock limit for the content scan; the worker is terminated at it. Default 5000. */
	deadlineMs?: number;
	/** Walk entry cap. Default 200000. */
	maxEntries?: number;
}

export interface SearchResult {
	hits: SearchHit[];
	files: string[];
	filesScanned: number;
	truncated: boolean;
	/** The scan hit its deadline; hits are partial. */
	timedOut?: boolean;
	/** The pattern was refused (too long or not a valid regex). */
	error?: string;
}

const ALWAYS_SKIP = new Set(["node_modules", "dist", ".git"]);
export const MAX_PATTERN_CHARS = 512;
const SKIP_FILE = /\.(lock|min\.js|map)$/;

export const MAX_GLOB_CHARS = 256;
const MAX_WILDCARDS = 8;

/** One path segment against one glob segment: `*` and `?`, linear two-pointer, no regex backtracking. */
function segMatch(p: string, s: string): boolean {
	let pi = 0;
	let si = 0;
	let star = -1;
	let mark = 0;
	while (si < s.length) {
		if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
			pi++;
			si++;
		} else if (pi < p.length && p[pi] === "*") {
			star = pi++;
			mark = si;
		} else if (star >= 0) {
			pi = star + 1;
			si = ++mark;
		} else return false;
	}
	while (pi < p.length && p[pi] === "*") pi++;
	return pi === p.length;
}

/**
 * Compile a glob to a matcher over a "/"-separated relative path, or null when it is too
 * long or has too many wildcards. No RegExp: a hostile glob or .gitignore line cannot
 * hang the walk. A "**" segment spans any number of directories; anchored=false matches
 * the pattern against the tail of the path (gitignore rules without a slash).
 */
export function globMatcher(glob: string, anchored = true): ((rel: string) => boolean) | null {
	const collapsed = glob.replace(/\*{2,}/g, (m, off: number, all: string) =>
		(off === 0 || all[off - 1] === "/") &&
		(off + m.length === all.length || all[off + m.length] === "/")
			? "**"
			: "*",
	);
	if (
		collapsed.length > MAX_GLOB_CHARS ||
		(collapsed.match(/[*?]/g)?.length ?? 0) > MAX_WILDCARDS
	) {
		return null;
	}
	const pat = collapsed.split("/");
	return (rel: string) => {
		const segs = rel.split("/");
		const starts = anchored
			? [0]
			: segs.map((_, i) => i).filter((i) => segs.length - i === pat.length);
		const memo = new Map<number, boolean>();
		const go = (pi: number, si: number): boolean => {
			const k = pi * 100003 + si;
			const hit = memo.get(k);
			if (hit !== undefined) return hit;
			let r: boolean;
			if (pi === pat.length) r = si === segs.length;
			else if (pat[pi] === "**") r = go(pi + 1, si) || (si < segs.length && go(pi, si + 1));
			else r = si < segs.length && segMatch(pat[pi], segs[si]) && go(pi + 1, si + 1);
			memo.set(k, r);
			return r;
		};
		return starts.some((st) => go(0, st));
	};
}

interface IgnoreRule {
	match: (rel: string) => boolean;
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
		const match = globMatcher(line, anchored);
		if (match) rules.push({ match, negate, dirOnly }); // a rule over the caps is dropped
	}
	return rules;
}

function isIgnored(rel: string, isDir: boolean, scopes: Scope[]): boolean {
	let ignored = false;
	for (const { base, rules } of scopes) {
		const sub = base ? rel.slice(base.length + 1) : rel;
		for (const r of rules) {
			if (r.dirOnly && !isDir) continue;
			if (r.match(sub)) ignored = !r.negate;
		}
	}
	return ignored;
}

export async function searchFiles(opts: SearchOptions): Promise<SearchResult> {
	const root = path.resolve(opts.root);
	const maxResults = opts.maxResults ?? 200;
	const allow = opts.allow;
	const fileGlob = opts.glob ? globMatcher(opts.glob, opts.glob.includes("/")) : null;
	const out: SearchResult = { hits: [], files: [], filesScanned: 0, truncated: false };
	if (opts.glob && !fileGlob) {
		return {
			...out,
			error: `glob longer than ${MAX_GLOB_CHARS} characters or with more than ${MAX_WILDCARDS} wildcards`,
		};
	}
	if (opts.pattern) {
		if (opts.pattern.length > MAX_PATTERN_CHARS) {
			return { ...out, error: `pattern longer than ${MAX_PATTERN_CHARS} characters` };
		}
		try {
			new RegExp(opts.pattern);
		} catch (e) {
			return { ...out, error: `invalid regex: ${(e as Error).message}` };
		}
	}

	// 1. Walk: sorted, ignore-aware, guard-filtered list of candidate files.
	const candidates: string[] = [];
	let entriesSeen = 0;
	const maxEntries = opts.maxEntries ?? 200_000;
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
			if (out.truncated) return;
			if (++entriesSeen > maxEntries) {
				out.truncated = true;
				return;
			}
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			const isDir = e.isDirectory();
			if (!isDir && !e.isFile()) continue; // symlinks are not followed
			if (isDir ? ALWAYS_SKIP.has(e.name) : SKIP_FILE.test(e.name)) continue;
			if (isIgnored(childRel, isDir, scopes)) continue;
			const abs = path.join(dir, e.name);
			if (!allow(abs)) continue; // path-guard denied: never entered, never read, never listed
			if (isDir) walk(abs, childRel, scopes);
			else if (!fileGlob || fileGlob(childRel)) candidates.push(childRel);
		}
	};
	walk(root, "", []);

	if (!opts.pattern) {
		if (candidates.length > maxResults) out.truncated = true;
		out.files = candidates.slice(0, maxResults);
		return out;
	}

	// 2. Scan in a worker with a hard deadline: a catastrophic regex cannot hang this thread.
	const job = {
		root,
		candidates,
		pattern: opts.pattern,
		literal: opts.literal === true,
		ignoreCase: opts.ignoreCase,
		maxResults,
		maxPerFile: opts.maxPerFile ?? 20,
		maxBytes: opts.maxFileBytes ?? 1_000_000,
	};
	const deadlineMs = opts.deadlineMs ?? 5000;
	return new Promise<SearchResult>((resolve) => {
		let done = false;
		let worker: Worker | undefined;
		let blobUrl: string | undefined;
		const finish = (extra: Partial<SearchResult> = {}) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			void worker?.terminate();
			if (blobUrl) URL.revokeObjectURL(blobUrl);
			resolve({ ...out, ...extra });
		};
		const timer = setTimeout(() => finish({ timedOut: true }), deadlineMs);
		const fail = (why: string) => finish({ error: `search worker failed: ${why}` });
		try {
			// The worker source is embedded (a blob), so it exists inside a bun --compile binary too.
			blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
			worker = new Worker(blobUrl);
		} catch (e) {
			fail((e as Error).message);
			return;
		}
		worker.onmessage = (ev: MessageEvent) => {
			const m = ev.data as {
				hits: SearchHit[];
				scanned: number;
				truncated?: boolean;
				done?: boolean;
				error?: string;
			};
			if (m.error) return fail(m.error);
			out.hits.push(...m.hits);
			out.filesScanned = Math.max(out.filesScanned, m.scanned);
			if (m.truncated) out.truncated = true;
			if (m.done) finish();
		};
		worker.onerror = (e: ErrorEvent) => fail(e.message || "worker error");
		worker.postMessage(job);
	});
}

/** Render a result as "file:line:text" rows (or file names), with cap, timeout and refusal notes. */
export function formatSearch(r: SearchResult): string {
	if (r.error) return `Search refused: ${r.error}.`;
	const rows = r.hits.length > 0 ? r.hits.map((h) => `${h.file}:${h.line}:${h.text}`) : r.files;
	const notes = [
		r.timedOut ? "[search timed out: results are partial, use a simpler pattern]" : "",
		r.truncated ? "[truncated: result cap reached, narrow the pattern or glob]" : "",
	].filter(Boolean);
	if (rows.length === 0 && notes.length === 0) return "No matches.";
	return [...rows, ...notes].join("\n");
}
