/**
 * In-process file search (#4633): a directory walk plus a fixed-string line match, in
 * plain node:fs and node:path. It spawns no process and starts no worker, so it behaves
 * the same on macOS, Linux, Windows PowerShell and Termux, and no shell string can carry
 * injection. The pattern is LITERAL: there is no model-supplied regex, so a catastrophic
 * pattern cannot exist (indexOf is linear). Globs and .gitignore rules use a linear
 * matcher, not RegExp. Respects .gitignore (root and nested), skips binary and oversize
 * files, caps results and walk size, and returns hits in sorted path order so the same
 * tree gives the same answer on every host. Paths in results are always "/".
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
	/** Required: veto an absolute path (the permissions path-guard). A denied directory is not entered, a denied file is not read; both are skipped silently. */
	allow: (absPath: string) => boolean;
	/** Plain text to find. Omit to list files only. */
	pattern?: string;
	/** Default is smart case: insensitive unless the pattern has a capital. */
	ignoreCase?: boolean;
	/** Only files whose relative path matches this glob (for example "*.ts"). */
	glob?: string;
	maxResults?: number;
	maxPerFile?: number;
	maxFileBytes?: number;
	/** Walk entry cap. Default 200000. */
	maxEntries?: number;
	/** Wall-clock limit for the whole search in ms. Default 2000. */
	deadlineMs?: number;
}

export interface SearchResult {
	hits: SearchHit[];
	files: string[];
	filesScanned: number;
	/** True when the answer is partial for any reason below. */
	truncated: boolean;
	/** maxResults was reached: more matches exist than are shown. */
	capped?: boolean;
	/** The walk entry cap was reached. */
	entryCap?: number;
	/** Rule-check budget spent: the walk stopped after this many files and was not continued unfiltered. */
	rulesIncomplete?: { filesWalked: number; cause?: "cost" };
	/** The wall-clock deadline passed; total is unknown when the walk itself was cut. */
	deadline?: { searched: number; total?: number; seconds: number; unit?: "entries" };
	/** The request was refused (for example a glob over the caps). */
	error?: string;
}

const ALWAYS_SKIP = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILE = /\.(lock|min\.js|map)$/;
export const MAX_GLOB_CHARS = 256;
const MAX_WILDCARDS = 8;

type Tok =
	| { k: "lit"; c: string }
	| { k: "any" }
	| { k: "star" }
	| { k: "class"; set: string; neg: boolean };

/** Parse one glob segment: * ? [class] \escape. Unclosed "[" is a literal. */
function tokenize(seg: string): Tok[] {
	const out: Tok[] = [];
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i];
		if (c === "\\" && i + 1 < seg.length) out.push({ k: "lit", c: seg[++i] });
		else if (c === "*") {
			if (out[out.length - 1]?.k !== "star") out.push({ k: "star" });
		} else if (c === "?") out.push({ k: "any" });
		else if (c === "[") {
			let j = i + 1;
			const neg = seg[j] === "!" || seg[j] === "^";
			if (neg) j++;
			const from = j;
			if (seg[j] === "]") j++; // a leading "]" is a member
			while (j < seg.length && seg[j] !== "]") j++;
			if (j >= seg.length) out.push({ k: "lit", c });
			else {
				out.push({ k: "class", set: seg.slice(from, j), neg });
				i = j;
			}
		} else out.push({ k: "lit", c });
	}
	return out;
}

function inClass(set: string, ch: string): boolean {
	for (let i = 0; i < set.length; i++) {
		if (set[i + 1] === "-" && i + 2 < set.length) {
			// the start of a range always matches itself, so a reversed [z-a] matches "z" as in git
			if (ch === set[i] || (ch >= set[i] && ch <= set[i + 2])) return true;
			i += 2;
		} else if (set[i] === ch) return true;
	}
	return false;
}

const tokMatch = (t: Tok, ch: string): boolean =>
	t.k === "lit"
		? t.c === ch
		: t.k === "any"
			? true
			: t.k === "class"
				? inClass(t.set, ch) !== t.neg
				: false;

/** One path segment against its tokens: two-pointer with star backtracking, no RegExp. */
function segMatch(p: Tok[], s: string): boolean {
	let pi = 0;
	let si = 0;
	let star = -1;
	let mark = 0;
	while (si < s.length) {
		if (pi < p.length && p[pi].k !== "star" && tokMatch(p[pi], s[si])) {
			pi++;
			si++;
		} else if (pi < p.length && p[pi].k === "star") {
			star = pi++;
			mark = si;
		} else if (star >= 0) {
			pi = star + 1;
			si = ++mark;
		} else return false;
	}
	while (pi < p.length && p[pi].k === "star") pi++;
	return pi === p.length;
}

/**
 * Compile a glob to a matcher over a "/"-separated relative path, or null when it is too
 * long or has too many wildcards. A "**" segment spans any number of directories;
 * anchored=false matches the pattern against the tail of the path (gitignore rules
 * without a slash). Backtracking is bounded by memoised segment positions.
 */
export function globMatcher(glob: string, anchored = true): ((rel: string) => boolean) | null {
	const t = compileGlob(glob, anchored);
	return t ? (rel: string) => t(rel, rel.split("/")) : null;
}

/** Segments precompiled once per glob; callers that already split the path pass the parts in. */
type PartsMatcher = (rel: string, parts: string[]) => boolean;

function compileGlob(glob: string, anchored: boolean): PartsMatcher | null {
	if (glob.length > MAX_GLOB_CHARS) return null;
	const segs = glob.split("/").map((g) => (g === "**" ? "**" : tokenize(g)));
	const wild = segs.reduce<number>(
		(n, g) => n + (g === "**" ? 1 : g.filter((t) => t.k !== "lit").length),
		0,
	);
	if (wild > MAX_WILDCARDS) return null;
	const hasDeep = segs.some((g) => g === "**");
	if (wild === 0) {
		// Literal rule: plain string compare, no split and no memo (the hot path for big .gitignore files).
		const lit = (segs as Tok[][])
			.map((g) => g.map((t) => (t.k === "lit" ? t.c : "")).join(""))
			.join("/");
		return anchored
			? (rel) => rel === lit
			: (rel) =>
					rel === lit ||
					(rel.length > lit.length &&
						rel.endsWith(lit) &&
						rel[rel.length - lit.length - 1] === "/");
	}
	if (!hasDeep) {
		// No "**": segments pair one to one, so no recursion and no memo.
		const toks = segs as Tok[][];
		const n = toks.length;
		return (_rel, parts) => {
			const start = anchored ? 0 : parts.length - n;
			if (anchored ? parts.length !== n : start < 0) return false;
			for (let i = 0; i < n; i++) if (!segMatch(toks[i], parts[start + i])) return false;
			return true;
		};
	}
	return (_rel, parts) => {
		const starts = anchored
			? [0]
			: parts.map((_, i) => i).filter((i) => parts.length - i === segs.length);
		const memo = new Map<number, boolean>();
		const go = (pi: number, si: number): boolean => {
			const key = pi * 100003 + si;
			const hit = memo.get(key);
			if (hit !== undefined) return hit;
			const g = segs[pi];
			let r: boolean;
			if (pi === segs.length) r = si === parts.length;
			else if (g === "**") r = go(pi + 1, si) || (si < parts.length && go(pi, si + 1));
			else r = si < parts.length && segMatch(g, parts[si]) && go(pi + 1, si + 1);
			memo.set(key, r);
			return r;
		};
		return starts.some((st) => go(0, st));
	};
}

interface IgnoreRule {
	match: (rel: string) => boolean;
	matchParts: PartsMatcher;
	negate: boolean;
	dirOnly: boolean;
}
interface Scope {
	base: string;
	rules: IgnoreRule[];
}

export const MAX_GITIGNORE_BYTES = 1_000_000;
export const MAX_GITIGNORE_RULES = 10_000;
/** Longest .gitignore line looked at: the glob cap plus room for "!", "/" and trailing blanks. */
const MAX_LINE_CHARS = MAX_GLOB_CHARS + 16;

/** Drop trailing spaces and tabs, but keep one that a backslash escapes. A backwards loop, no RegExp. */
function trimTrailingBlanks(line: string): string {
	let end = line.length;
	while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
		if (line[end - 1] === " " && end > 1 && line[end - 2] === "\\") break; // "\ " is a literal space
		end--;
	}
	return line.slice(0, end);
}

/** Parse .gitignore text into rules relative to the directory holding it. No RegExp anywhere. */
export function parseGitignore(text: string, limit = MAX_GITIGNORE_RULES): IgnoreRule[] {
	return parseGitignoreInfo(text, limit).rules;
}

/** As parseGitignore, and says whether rules were dropped for being over the limit. */
export function parseGitignoreInfo(
	text: string,
	limit = MAX_GITIGNORE_RULES,
): { rules: IgnoreRule[]; overCap: boolean } {
	const rules: IgnoreRule[] = [];
	let overCap = false;
	for (let line of text.split("\n")) {
		if (rules.length >= limit) {
			if (line.trim() && line[0] !== "#") overCap = true;
			continue;
		}
		if (line.length > MAX_LINE_CHARS) continue; // a line over the cap is dropped before any work
		if (line.endsWith("\r")) line = line.slice(0, -1);
		line = trimTrailingBlanks(line);
		if (!line || line[0] === "#") continue;
		const negate = line[0] === "!";
		if (negate) line = line.slice(1);
		const dirOnly = line.endsWith("/");
		if (dirOnly) line = line.slice(0, -1);
		const anchored = line.includes("/");
		if (line[0] === "/") line = line.slice(1);
		if (!line) continue;
		const matchParts = compileGlob(line, anchored);
		if (matchParts)
			rules.push({ match: (rel) => matchParts(rel, rel.split("/")), matchParts, negate, dirOnly }); // a rule over the caps is dropped
	}
	return { rules, overCap };
}

/** Read a file only when it fits in max bytes: stat first, then read at most max+1. A larger file returns null. */
async function readCapped(file: string, max: number): Promise<Buffer | null> {
	// O_NONBLOCK: a FIFO swapped in after the walk must not block. O_NOFOLLOW: a swapped-in symlink is refused (ELOOP), not followed. fstat on the fd, not the path.
	const fh = await fs.promises.open(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
	);
	try {
		const st = await fh.stat();
		if (!st.isFile()) return null; // not a regular file: skipped
		const size = st.size;
		if (size > max) return null; // too big: never read, skipped
		const buf = Buffer.alloc(Math.min(size, max + 1));
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

/** Read at most MAX_GITIGNORE_BYTES of a .gitignore. */
function readGitignore(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(MAX_GITIGNORE_BYTES);
		const n = fs.readSync(fd, buf, 0, MAX_GITIGNORE_BYTES, 0);
		return buf.toString("utf8", 0, n);
	} finally {
		fs.closeSync(fd);
	}
}

/** Rule checks allowed per search; sized so the worst case stays near 2 s. */
export const MAX_RULE_CHECKS = 10_000_000;
interface Work {
	left: number;
	spent: boolean;
	costly: boolean; // spent by the rule-check budget, not by the rule-count cap
	deadline: number;
	late: boolean;
	tick: number;
}

/** Returns undefined when the rule budget or the deadline ran out: the caller must stop the walk. */
function isIgnored(rel: string, isDir: boolean, scopes: Scope[], work: Work): boolean | undefined {
	let ignored = false;
	for (const { base, rules } of scopes) {
		const sub = base ? rel.slice(base.length + 1) : rel;
		const parts = sub.split("/");
		if ((work.left -= rules.length) < 0) {
			work.spent = true;
			work.costly = true;
			return undefined;
		}
		for (const r of rules) {
			if ((++work.tick & 63) === 0 && Date.now() >= work.deadline) {
				work.late = true;
				return undefined;
			}
			if (r.dirOnly && !isDir) continue;
			if (r.matchParts(sub, parts)) ignored = !r.negate;
		}
	}
	return ignored;
}

export async function searchFiles(opts: SearchOptions): Promise<SearchResult> {
	const root = path.resolve(opts.root);
	const maxResults = opts.maxResults ?? 200;
	const maxPerFile = opts.maxPerFile ?? 20;
	const maxBytes = opts.maxFileBytes ?? 1_000_000;
	const maxEntries = opts.maxEntries ?? 200_000;
	const out: SearchResult = { hits: [], files: [], filesScanned: 0, truncated: false };
	const deadlineMs = opts.deadlineMs ?? 2000;
	let capHit = false;
	const finish = (total?: number, searched?: number): SearchResult => {
		if (capHit) out.capped = true;
		if (work.spent) out.rulesIncomplete = { filesWalked, cause: work.costly ? "cost" : undefined };
		if (work.late)
			out.deadline = {
				searched: searched ?? out.filesScanned,
				total,
				seconds: Math.max(0, deadlineMs) / 1000,
				unit: searched === undefined ? undefined : "entries", // list mode counts entries, content mode files
			};
		out.truncated = !!(out.capped || out.entryCap || out.rulesIncomplete || out.deadline);
		return out;
	};
	const fileGlob = opts.glob ? globMatcher(opts.glob, opts.glob.includes("/")) : null;
	if (opts.glob && !fileGlob) {
		return {
			...out,
			error: `glob longer than ${MAX_GLOB_CHARS} characters or with more than ${MAX_WILDCARDS} wildcards`,
		};
	}

	// 1. Walk: sorted, ignore-aware, guard-filtered list of candidate files.
	const candidates: string[] = [];
	let entriesSeen = 0;
	const work: Work = {
		left: MAX_RULE_CHECKS,
		spent: false,
		costly: false,
		deadline: Date.now() + deadlineMs,
		late: false,
		tick: 0,
	};
	let filesWalked = 0;
	let ruleBudget = MAX_GITIGNORE_RULES; // one budget per search, shared by every scope
	const walk = (dir: string, rel: string, inherited: Scope[]): void => {
		const entries: fs.Dirent[] = [];
		try {
			// opendir + readSync so the deadline is checked while a huge directory is listed.
			const d = fs.opendirSync(dir);
			try {
				for (let ent = d.readSync(); ent; ent = d.readSync()) {
					entries.push(ent);
					if ((entries.length & 255) === 0 && Date.now() >= work.deadline) {
						work.late = true;
						break;
					}
				}
			} finally {
				d.closeSync();
			}
		} catch {
			return;
		}
		if (work.late) return;
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		let scopes = inherited;
		const hasIgnore = entries.some((e) => e.name === ".gitignore" && e.isFile());
		if (hasIgnore && ruleBudget <= 0) {
			work.spent = true; // a .gitignore that cannot be read: stop, never list what it would hide
			return;
		}
		if (hasIgnore) {
			try {
				const info = parseGitignoreInfo(readGitignore(path.join(dir, ".gitignore")), ruleBudget);
				const rules = info.rules;
				if (info.overCap) {
					work.spent = true; // rules were dropped: stop, never list what they would hide
					return;
				}
				ruleBudget -= rules.length;
				scopes = [...inherited, { base: rel, rules }];
			} catch {}
		}
		for (const e of entries) {
			if (capHit || work.spent || work.late || out.entryCap) return;
			if (Date.now() >= work.deadline) {
				work.late = true;
				return;
			}
			if (++entriesSeen > maxEntries) {
				out.entryCap = maxEntries;
				return;
			}
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			const isDir = e.isDirectory();
			if (!isDir && !e.isFile()) continue; // symlinks are not followed
			if (isDir ? ALWAYS_SKIP.has(e.name) : SKIP_FILE.test(e.name)) continue;
			const ign = isIgnored(childRel, isDir, scopes, work);
			if (ign === undefined) return; // budget or deadline: stop the walk, never continue unfiltered
			if (ign) continue;
			if (!isDir) filesWalked++;
			const abs = path.join(dir, e.name);
			if (!opts.allow(abs)) continue; // path-guard denied: never entered, never read, never listed
			if (isDir) walk(abs, childRel, scopes);
			else if (!fileGlob || fileGlob(childRel)) candidates.push(childRel);
		}
	};
	walk(root, "", []);
	const walkCut = work.spent || work.late || !!out.entryCap; // total file count unknown

	if (!opts.pattern) {
		if (candidates.length > maxResults) capHit = true;
		out.files = candidates.slice(0, maxResults);
		return finish(walkCut ? undefined : candidates.length, entriesSeen);
	}

	// 2. Scan: read files in parallel batches, judge them in path order. indexOf is linear.
	const insensitive = opts.ignoreCase ?? !/[A-Z]/.test(opts.pattern);
	const needle = insensitive ? opts.pattern.toLowerCase() : opts.pattern;
	const fold = (s: string) => (insensitive ? s.toLowerCase() : s);
	// An ASCII needle is tested against the raw bytes (memmem, or a latin1 1:1 decode when
	// folding case); only a candidate file is decoded as utf8.
	const ascii = /^[\x20-\x7e]*$/.test(needle);
	for (let i = 0; i < candidates.length && !capHit && !work.late; i += 64) {
		if (Date.now() >= work.deadline) {
			work.late = true;
			break;
		}
		const batch = candidates.slice(i, i + 64);
		const bufs = await Promise.all(
			batch.map((rel) =>
				readCapped(path.join(root, ...rel.split("/")), maxBytes).catch(() => null),
			),
		);
		for (let j = 0; j < batch.length && !capHit; j++) {
			if (Date.now() >= work.deadline) {
				work.late = true;
				break;
			}
			const buf = bufs[j];
			if (!buf || buf.length > maxBytes || buf.subarray(0, 8192).includes(0)) continue; // unreadable, big or binary
			out.filesScanned++;
			if (
				ascii &&
				!(insensitive
					? buf.toString("latin1").toLowerCase().includes(needle)
					: buf.includes(needle))
			) {
				continue;
			}
			const lines = buf.toString("utf8").split(/\r?\n/);
			let perFile = 0;
			for (let n = 0; n < lines.length; n++) {
				if (!fold(lines[n]).includes(needle)) continue;
				out.hits.push({ file: batch[j], line: n + 1, text: lines[n].slice(0, 300) });
				if (out.hits.length >= maxResults) capHit = true;
				if (capHit || ++perFile >= maxPerFile) break;
			}
		}
	}
	return finish(walkCut ? undefined : candidates.length);
}

/** Render a result as "file:line:text" rows (or file names), then one line per partial state. */
export function formatSearch(r: SearchResult): string {
	if (r.error) return `Search refused: ${r.error}.`;
	const rows = r.hits.length > 0 ? r.hits.map((h) => `${h.file}:${h.line}:${h.text}`) : r.files;
	const notes: string[] = [];
	if (r.capped)
		notes.push(
			`[truncated: showing first ${rows.length} matches. Narrow the pattern or glob to see the rest.]`,
		);
	if (r.entryCap)
		notes.push(
			`[stopped after ${r.entryCap} entries: only part of the tree was walked. Add a glob to narrow the search.]`,
		);
	if (r.rulesIncomplete)
		notes.push(
			r.rulesIncomplete.cause === "cost"
				? `[ignore rules incomplete: search stopped after ${r.rulesIncomplete.filesWalked} files because .gitignore rules were too costly to apply. Results so far are shown. Add a glob to narrow the search.]`
				: `[ignore rules incomplete: search stopped after ${r.rulesIncomplete.filesWalked} files because .gitignore rules exceeded the limit. Results so far are shown. Add a glob to narrow the search.]`,
		);
	if (r.deadline) {
		const of = r.deadline.total === undefined ? "" : ` of ${r.deadline.total}`;
		notes.push(
			`[stopped after ${r.deadline.seconds}s: searched ${r.deadline.searched}${of} ${r.deadline.unit ?? "files"}. Results so far are shown. Narrow the pattern or glob to search the rest.]`,
		);
	}
	if (rows.length === 0) {
		if (notes.length === 0) return "No matches.";
		return [
			"No matches in the part searched.",
			...notes,
			"This does not mean the pattern is absent from the repo.",
		].join("\n");
	}
	return [...rows, ...notes].join("\n");
}
