/**
 * locate(query): one cheap answer to "where is X?" with no model.
 *
 * Deterministic fast paths, tried in order (routeQuery). Each is a pure
 * function of the query text and one symbol-map lookup:
 *
 *   1. quoted       "..." '...' `...`            -> grep the quoted text
 *   2. member       a::b                         -> symbol b (grep a::b if absent)
 *   3. path         a token with "/" or a known  -> fuzzy match over the file list
 *                   file extension (optional :line)
 *   4. error_like   error words, ": " or regex   -> grep the whole query
 *                   characters, not a question
 *   5. identifier   camel, Pascal, snake, dotted -> symbol when the name is in
 *                   (or a lone word)                the symbol map, else grep
 *   6. hybrid       anything else (prose)        -> symbol + path + grep, merged
 *
 * Prose (rule 6) may be routed by System One when env EIGHT_SYSTEM_ONE_LOCATE=1
 * (off by default; see locate-system-one.ts). A mode the model gives at or
 * above its threshold replaces hybrid: that mode's own search runs on each
 * query word, or for semantic, on the whole query (nearest symbol signatures
 * by embedding, semantic.ts). Anything else (unsure, slow, failed, or a kept
 * mode that finds nothing, including semantic while its index is building or
 * with no embedding model) leaves the hybrid answer exactly as the rules
 * give it, with a note when semantic was the reason.
 *
 * Grep is ripgrep with -F (the query is a literal, never a regex), spawned
 * with an argv array (never a shell string) and confined to the repo root.
 * The answer is at most five "file:line kind text" rows, about 300 tokens.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Symbol } from "../types";
import { getFileOutline, getFileTree, refreshIndexAsync, searchSymbols } from "./index";
import { type ProseRouter, type ProseRouting, defaultProseRouter } from "./locate-system-one";
import { type SemanticAnswer, semanticSearch } from "./semantic";

export type LocateMode = "path" | "symbol" | "grep" | "hybrid" | "semantic";

export interface LocateRoute {
	mode: LocateMode;
	/** The rule that decided the mode. */
	rule:
		| "empty"
		| "quoted"
		| "member"
		| "member_no_symbol"
		| "path"
		| "error_like"
		| "identifier"
		| "identifier_no_symbol"
		| "phrase"
		| "prose"
		| "system_one";
	/** What the mode searches for: a symbol name, a path, a literal, or the raw query. */
	term: string;
	/** Line asked for with a path ("a.ts:42"). */
	line?: number;
	/** Hybrid only: the content words searched. */
	terms?: string[];
	/** Literal-first routes (error_like, phrase): how to read the query when the literal is absent. */
	fallback?: LocateRoute;
	/** Prose only, flag on: what System One answered, whether or not locate used it. */
	systemOne?: ProseRouting;
}

export interface LocateRow {
	/** Path relative to the repo root, "/" separated. */
	file: string;
	line: number;
	kind: string;
	text: string;
}

export interface LocateResult {
	query: string;
	route: LocateRoute;
	rows: LocateRow[];
	/** ripgrep could not be started, so grep and file listing had nothing to search. */
	rgMissing?: boolean;
	/** ripgrep hit its time limit, so text and file search saw only part of the tree. */
	incomplete?: boolean;
	/** The symbol index was still building, so symbol search did not run. */
	indexPending?: boolean;
	/** Semantic mode was chosen but could not answer, so the rows are hybrid's. */
	semantic?: Omit<SemanticAnswer, "hits">;
}

export const LOCATE_MAX_ROWS = 5;
/** Per-row text cap, so five rows stay near 300 tokens. */
const ROW_TEXT_MAX = 140;

// ------------------------------------------------------------------ routing

/** Extensions a bare token must end with to count as a path ("rules.ts", "package.json"). */
const PATH_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"mts",
	"cts",
	"json",
	"jsonc",
	"md",
	"mdx",
	"yml",
	"yaml",
	"toml",
	"css",
	"scss",
	"html",
	"sh",
	"bash",
	"zsh",
	"py",
	"go",
	"rs",
	"swift",
	"kt",
	"java",
	"rb",
	"sql",
	"txt",
	"lock",
	"env",
	"svg",
	"png",
	"gguf",
	"wasm",
]);
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const DOTTED_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
const MEMBER_RE = /^[A-Za-z_$][\w$]*(::[A-Za-z_$][\w$]*)+$/;
const PATH_LINE_RE = /^(.*?)(?::(\d+))?(?::\d+)?$/;
/** A quote that opens and closes at a word edge, so "user's" or "can't" is not a quote. */
const QUOTED_RE = /(?:^|[^\w])(["'`])([^"'`]*[^"'`\s][^"'`]*)\1(?!\w)/;
const QUESTION_RE = /^(where|how|what|which|who|why|when|find|show|locate|look|list|get me)\b/i;
const ERROR_WORD_RE =
	/\b(error|errors|failed|failure|fails|cannot|can't|could not|couldn't|unable|invalid|unexpected|missing|not found|not available|unavailable|not supported|unsupported|denied|refused|timed out|timeout|exception|no such|not allowed|must be|is required|undefined is not|already exists)\b/i;
const REGEX_CHAR_RE = /[\\^()[\]{}*+?|]/;
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"are",
	"was",
	"where",
	"what",
	"which",
	"who",
	"why",
	"when",
	"how",
	"does",
	"did",
	"is",
	"it",
	"its",
	"this",
	"that",
	"with",
	"from",
	"into",
	"code",
	"file",
	"files",
	"function",
	"defined",
	"define",
	"definition",
	"located",
	"live",
	"lives",
	"find",
	"show",
	"locate",
	"look",
	"get",
	"set",
	"use",
	"used",
	"uses",
	"handle",
	"handled",
	"handles",
	"there",
	"some",
	"any",
	"all",
	"our",
	"has",
	"have",
	"can",
	"should",
	"would",
	"about",
]);

/** A token that names a file: has a "/" or ends in a known extension, maybe with ":line". */
export function pathToken(token: string): { path: string; line?: number } | null {
	const t = token.replace(/^[(<[{]+|[)>\]},;.]+$/g, "");
	if (!t || /\s/.test(t) || /^[a-z]+:\/\//i.test(t)) return null;
	const m = PATH_LINE_RE.exec(t);
	const p = (m?.[1] ?? t).replace(/^\.\//, "");
	const line = m?.[2] ? Number(m[2]) : undefined;
	if (!p || REGEX_CHAR_RE.test(p)) return null;
	const ext = /\.([A-Za-z0-9]{1,5})$/.exec(p)?.[1]?.toLowerCase();
	const hasSlash = p.includes("/") && /[\w.-]\/|\/[\w.-]/.test(p);
	if (!hasSlash && !(ext && PATH_EXTENSIONS.has(ext) && /[\w-]\.[A-Za-z0-9]+$/.test(p)))
		return null;
	return line ? { path: p, line } : { path: p };
}

/** camel hump, snake underscore, $ or a dot: a token that reads as code, not a word. */
function codeShaped(token: string): boolean {
	return /[a-z0-9][A-Z]|[A-Z]{2}[a-z]|_|\$/.test(token) || DOTTED_RE.test(token);
}

function words(query: string): string[] {
	return query.split(/\s+/).filter(Boolean);
}

/** Content words of a prose query, lowered, stopwords dropped, at most four. */
export function contentTerms(query: string): string[] {
	const seen = new Set<string>();
	for (const raw of query.split(/[^A-Za-z0-9_$]+/)) {
		const w = raw.toLowerCase();
		if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
		seen.add(w);
		if (seen.size === 4) break;
	}
	return [...seen];
}

/**
 * Pick the retrieval mode for a query. Pure: the only outside fact is
 * `symbolExists(name)`, true when the symbol map holds that exact name
 * (case-insensitive).
 */
export function routeQuery(query: string, symbolExists: (name: string) => boolean): LocateRoute {
	const q = query.trim();
	if (!q) return { mode: "hybrid", rule: "empty", term: "", terms: [] };

	const quoted = QUOTED_RE.exec(q);
	if (quoted) return { mode: "grep", rule: "quoted", term: quoted[2].trim() };

	const tokens = words(q);
	const single = tokens.length === 1;
	const question = QUESTION_RE.test(q);

	const member = tokens.find((t) => MEMBER_RE.test(t));
	if (member) {
		const name = member.slice(member.lastIndexOf("::") + 2);
		return symbolExists(name)
			? { mode: "symbol", rule: "member", term: name }
			: { mode: "grep", rule: "member_no_symbol", term: member };
	}

	// One token that is not a name or a path ("->", "foo(bar)") is text.
	if (single && !IDENT_RE.test(q) && !DOTTED_RE.test(q) && !pathToken(q)) {
		return { mode: "grep", rule: "error_like", term: q };
	}

	const reading = interpret(q, tokens, single, symbolExists);

	// Pasted text (an error message, a log line, or three or more words that
	// are not a question) is looked up literally first. When the literal is
	// not in the repo, locate uses the fallback: the same query read as a
	// path, an identifier or prose.
	if (!question && !single) {
		if (ERROR_WORD_RE.test(q) || /\w: \S/.test(q) || REGEX_CHAR_RE.test(q)) {
			return { mode: "grep", rule: "error_like", term: q, fallback: reading };
		}
		if (tokens.length >= 3) return { mode: "grep", rule: "phrase", term: q, fallback: reading };
	}
	return reading;
}

/** The query read as a path, then an identifier, then prose. */
function interpret(
	q: string,
	tokens: string[],
	single: boolean,
	symbolExists: (name: string) => boolean,
): LocateRoute {
	for (const t of tokens) {
		const p = pathToken(t);
		if (p) return { mode: "path", rule: "path", term: p.path, ...(p.line ? { line: p.line } : {}) };
	}

	const idents = tokens
		.map((t) => t.replace(/^[(<[{]+|[)>\]},;:?!.]+$/g, "").replace(/\(\)$/, ""))
		.filter((t) => IDENT_RE.test(t) || DOTTED_RE.test(t))
		.filter((t) => single || codeShaped(t));
	if (idents.length > 0) {
		// Most code-shaped first, then longest: "createDecider" beats "decider".
		const pick = [...idents].sort(
			(a, b) => Number(codeShaped(b)) - Number(codeShaped(a)) || b.length - a.length,
		)[0];
		const name = pick.includes(".") ? pick.slice(pick.lastIndexOf(".") + 1) : pick;
		return symbolExists(name)
			? { mode: "symbol", rule: "identifier", term: name }
			: { mode: "grep", rule: "identifier_no_symbol", term: pick };
	}

	return { mode: "hybrid", rule: "prose", term: q, terms: contentTerms(q) };
}

// ------------------------------------------------------------------ path mode

/**
 * Fuzzy-rank `files` against a path query, best first:
 *   0 exact path, 1 path ends with "/query", 2 contains query,
 *   3 same basename, 4 query characters appear in order.
 * Ties: shorter path, then path order. Case-insensitive except tier 0.
 */
export function rankPaths(query: string, files: string[], limit = LOCATE_MAX_ROWS): string[] {
	const q = query.replace(/^\.\//, "").replace(/\\/g, "/");
	if (!q) return [];
	const ql = q.toLowerCase();
	const qBase = ql.slice(ql.lastIndexOf("/") + 1);
	const scored: { file: string; tier: number; span: number }[] = [];
	for (const file of files) {
		const fl = file.toLowerCase();
		let tier: number;
		let span = 0;
		if (file === q) tier = 0;
		else if (fl === ql || fl.endsWith(`/${ql}`)) tier = 1;
		else if (fl.includes(ql)) tier = 2;
		else if (fl.slice(fl.lastIndexOf("/") + 1) === qBase) tier = 3;
		else {
			span = subsequenceSpan(fl, ql);
			if (span < 0) continue;
			tier = 4;
		}
		scored.push({ file, tier, span });
	}
	scored.sort(
		(a, b) =>
			a.tier - b.tier ||
			a.span - b.span ||
			a.file.length - b.file.length ||
			(a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
	);
	return scored.slice(0, limit).map((s) => s.file);
}

/** Length of the shortest window where `needle` appears in order in `hay`, or -1. Greedy. */
function subsequenceSpan(hay: string, needle: string): number {
	let start = -1;
	let j = 0;
	for (let i = 0; i < hay.length && j < needle.length; i++) {
		if (hay[i] === needle[j]) {
			if (j === 0) start = i;
			j++;
			if (j === needle.length) return i - start + 1;
		}
	}
	return -1;
}

// ------------------------------------------------------------------ grep mode

export interface GrepHit {
	file: string;
	line: number;
	text: string;
}

/**
 * Parse "path NUL line:text" lines from rg --no-heading -n --null. The NUL
 * ends the path, so a file name holding ":12:" is not split inside it.
 * Leading "./" is dropped.
 */
export function parseRgLines(out: string): GrepHit[] {
	const hits: GrepHit[] = [];
	for (const raw of out.split("\n")) {
		const m = /^([^\0]+)\0(\d+):(.*)$/.exec(raw);
		if (!m) continue;
		hits.push({ file: m[1].replace(/^\.\//, ""), line: Number(m[2]), text: m[3] });
	}
	return hits;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TEST_PATH_RE = /(^|\/)(__tests__|tests?|spec|fixtures?)\/|\.(test|spec)\.[a-z]+$/i;
const DOC_PATH_RE = /\.(md|mdx|txt|json|jsonl|ya?ml|html|csv)$/i;

/**
 * Order grep hits, best first: a definition of the term, then source over
 * tests over docs, then shorter path, path order, line. At most `perFile`
 * rows from one file, so one noisy file cannot fill the answer.
 */
export function rankGrepHits(
	term: string,
	hits: GrepHit[],
	limit = LOCATE_MAX_ROWS,
	perFile = 2,
): GrepHit[] {
	const name = term.includes(".") ? term.slice(term.lastIndexOf(".") + 1) : term;
	const n = escapeRe(name);
	// A declaration keyword before the name, a method head ending in "{", or a
	// function assigned to the name. A bare call "name()" is a use.
	const defRe = IDENT_RE.test(name)
		? new RegExp(
				`\\b(function\\*?|class|interface|type|enum|const|let|var|def|fn|struct|func)\\s+${n}\\b` +
					`|^\\s*((public|private|protected|static|async|override|get|set)\\s+)*${n}\\s*(<[^>]*>)?\\([^)]*\\)\\s*(:[^{]*)?\\{\\s*$` +
					`|\\b${n}\\s*[:=]\\s*(async\\s*)?(function\\b|\\([^)]*\\)\\s*(:[^=]*)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
			)
		: null;
	// Exported definition 0, top-level 1, nested 2, any use 10; then +2 for a
	// test file, +3 for a doc.
	const defScore = (text: string) =>
		!defRe?.test(text) ? 10 : /\bexport\b/.test(text) ? 0 : /^\s/.test(text) ? 2 : 1;
	const score = (h: GrepHit) =>
		defScore(h.text) + (TEST_PATH_RE.test(h.file) ? 2 : DOC_PATH_RE.test(h.file) ? 3 : 0);
	const sorted = hits
		.map((h) => ({ h, s: score(h) }))
		.sort(
			(a, b) =>
				a.s - b.s ||
				a.h.file.length - b.h.file.length ||
				(a.h.file < b.h.file ? -1 : a.h.file > b.h.file ? 1 : 0) ||
				a.h.line - b.h.line,
		);
	const perFileCount = new Map<string, number>();
	const out: GrepHit[] = [];
	for (const { h } of sorted) {
		const n = perFileCount.get(h.file) ?? 0;
		if (n >= perFile) continue;
		perFileCount.set(h.file, n + 1);
		out.push(h);
		if (out.length === limit) break;
	}
	return out;
}

/**
 * Safety cap on rg output lines. Hits are ranked only after the whole output
 * is read, so the cap exists to bound memory on a pathological tree, not to
 * shorten the normal answer. File listings have no line cap.
 */
const RG_MAX_LINES = 100_000;
/** Default time limit for one rg run. */
const RG_TIMEOUT_MS = 3000;
const RG_EXCLUDES = ["!node_modules", "!dist", "!.git", "!*.lock", "!*.min.js", "!*.map"];

export interface RgOutput {
	text: string;
	/** Stopped at the line cap or the timeout, so `text` is a prefix of the full output. */
	truncated: boolean;
	/** The stop was the time limit, not the line cap. */
	timedOut: boolean;
	/** The rg binary could not be started (ENOENT or similar). */
	missing: boolean;
}

/**
 * Run ripgrep with an argv array, confined to `root`. Output is collected up
 * to `maxLines` lines (Infinity for none) or `timeoutMs`, then the process is
 * stopped.
 */
export function runRg(
	root: string,
	args: string[],
	opts: { bin?: string; maxLines?: number; timeoutMs?: number } = {},
): Promise<RgOutput> {
	const maxLines = opts.maxLines ?? RG_MAX_LINES;
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(
				opts.bin ?? "rg",
				["--no-config", ...RG_EXCLUDES.flatMap((g) => ["--glob", g]), ...args],
				{ cwd: root, stdio: ["ignore", "pipe", "ignore"], shell: false },
			);
		} catch {
			resolve({ text: "", truncated: false, timedOut: false, missing: true });
			return;
		}
		const chunks: string[] = [];
		let lines = 0;
		let done = false;
		const finish = (truncated: boolean, missing = false, timedOut = false) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ text: missing ? "" : chunks.join(""), truncated, timedOut, missing });
		};
		const timer = setTimeout(() => {
			proc.kill();
			finish(true, false, true);
		}, opts.timeoutMs ?? RG_TIMEOUT_MS);
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			if (done) return;
			chunks.push(chunk);
			lines += chunk.split("\n").length - 1;
			if (lines >= maxLines) {
				proc.kill();
				finish(true);
			}
		});
		proc.on("error", () => finish(false, true));
		proc.on("close", () => finish(false));
	});
}

/** Per-call state: which rg to run, and whether it turned out missing or slow. */
interface RunState {
	bin?: string;
	timeoutMs?: number;
	rgMissing: boolean;
	rgTimedOut: boolean;
	/** Set when a kept semantic mode could not answer. */
	semantic?: Omit<SemanticAnswer, "hits">;
}

async function rg(
	state: RunState,
	root: string,
	args: string[],
	maxLines?: number,
): Promise<RgOutput> {
	const out = await runRg(root, args, { bin: state.bin, maxLines, timeoutMs: state.timeoutMs });
	if (out.missing) state.rgMissing = true;
	if (out.timedOut) state.rgTimedOut = true;
	return out;
}

/** Literal content search: rg -F, smart case, a few hits per file. */
async function grepLiteral(
	state: RunState,
	root: string,
	patterns: string[],
	ignoreCase = false,
): Promise<GrepHit[]> {
	const args = [
		"-F",
		"-n",
		"--no-heading",
		"--null",
		"--color",
		"never",
		"--max-columns",
		"300",
		"--max-count",
		"20",
		"--max-filesize",
		"1M",
		ignoreCase ? "-i" : "--smart-case",
		...patterns.flatMap((p) => ["-e", p]),
		"--",
		"./",
	];
	let out = await rg(state, root, args);
	// Hits are ranked after a complete read, so walk order does not matter.
	// When the safety cap cut the output, re-run in path order so the cut
	// (and so the answer) is the same on every run. Not after a timeout:
	// --sort path is single-threaded, so it would only be slower; the time
	// limit is reported instead (LocateResult.incomplete).
	if (out.truncated && !out.timedOut) out = await rg(state, root, ["--sort", "path", ...args]);
	return parseRgLines(out.text);
}

/**
 * Every file rg would search under `root` (respects .gitignore), NUL
 * separated so any file name survives. No line cap: a partial listing would
 * rank a random subset of the tree. When rg hits its time limit (or gives
 * nothing), the files in the symbol index are added, so every indexed source
 * file is still ranked; the answer is then marked incomplete.
 */
async function listFiles(ctx: RunCtx): Promise<string[]> {
	const out = await rg(
		ctx.state,
		ctx.root,
		["--files", "--null", "--", "./"],
		Number.POSITIVE_INFINITY,
	);
	const files = out.text
		.split("\0")
		.filter(Boolean)
		.map((f) => f.replace(/^\.\//, ""));
	if ((out.timedOut || files.length === 0) && ctx.repoId) {
		const seen = new Set(files);
		for (const f of getFileTree(ctx.repoId).map(toPosix)) if (!seen.has(f)) files.push(f);
	}
	return files;
}

// ------------------------------------------------------------------ symbol mode

const KIND_RANK: Record<string, number> = {
	function: 0,
	class: 0,
	interface: 0,
	type: 0,
	method: 1,
	module: 1,
	constant: 2,
	variable: 2,
};

/**
 * Rank symbol hits for locate: the index's order (exact name first), then
 * among exact names a top-level declaration before a nested one, and a
 * function, class or type before a local constant of the same name.
 */
export function rankSymbols(query: string, hits: Symbol[]): Symbol[] {
	const ql = query.toLowerCase();
	return hits
		.map((s, i) => ({ s, i }))
		.sort((a, b) => {
			const ea = a.s.name.toLowerCase() === ql ? 0 : 1;
			const eb = b.s.name.toLowerCase() === ql ? 0 : 1;
			if (ea !== eb || ea === 1) return ea - eb || a.i - b.i;
			const na = a.s.id.split("::").length > 2 ? 1 : 0;
			const nb = b.s.id.split("::").length > 2 ? 1 : 0;
			return na - nb || (KIND_RANK[a.s.kind] ?? 3) - (KIND_RANK[b.s.kind] ?? 3) || a.i - b.i;
		})
		.map((x) => x.s);
}

// ------------------------------------------------------------------ locate

export interface LocateContext {
	/** Repo root; grep and path search never leave it. */
	root: string;
	/** AST index id for `root` (ensureIndexed(root).id), or null when there is none. */
	repoId: string | null;
	/** Refresh the index against disk first. Default true. */
	refresh?: boolean;
	/** ripgrep binary. Default "rg" from PATH. */
	rg?: string;
	/** Time limit for one rg run, in ms. Default 3000. */
	rgTimeoutMs?: number;
	/** The index is still building (repoId is null for that reason); the answer says so. */
	indexPending?: boolean;
	/**
	 * System One router for prose queries. Undefined: the process router when
	 * env EIGHT_SYSTEM_ONE_LOCATE is on, else none. null: none.
	 */
	systemOne?: ProseRouter | null;
	/**
	 * Semantic search for a kept semantic mode. Undefined: semanticSearch
	 * with the nomic client over Ollama. null: none (semantic falls back to hybrid).
	 */
	semantic?: ((repoId: string, query: string) => Promise<SemanticAnswer>) | null;
}

/** How long a locate call waits for a first index build before answering without it. */
export const LOCATE_INDEX_WAIT_MS = 200;

/**
 * Wait for an index build at most `ms`. A build that finishes in time gives
 * its repo id; one still running gives pending, so locate answers with path
 * and text search now instead of stalling for the whole build. A failed
 * build gives no id and is not pending.
 */
export async function awaitIndex(
	build: Promise<string | null>,
	ms: number,
): Promise<{ repoId: string | null; pending: boolean }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), ms);
	});
	try {
		const r = await Promise.race([build.catch(() => null), late]);
		return r === "late" ? { repoId: null, pending: true } : { repoId: r, pending: false };
	} finally {
		clearTimeout(timer);
	}
}

type RunCtx = LocateContext & { state: RunState };

/** When the last refresh of a repo's index finished, and how long it took. */
export interface RefreshStamp {
	at: number;
	costMs: number;
}

/** A refresh cheaper than this runs before every call. */
const REFRESH_CHEAP_MS = 50;
/** Longest an expensive refresh may be skipped. */
const REFRESH_MAX_SKIP_MS = 5000;

/**
 * Whether to refresh the index before this call. A cheap refresh always runs,
 * so a file written a moment ago is seen. An expensive one (a very large
 * tree) is skipped until ten times its cost has passed, capped at five
 * seconds, so refreshing never takes more than about a tenth of the time.
 */
export function refreshDue(last: RefreshStamp | undefined, now: number): boolean {
	if (!last || last.costMs < REFRESH_CHEAP_MS) return true;
	return now - last.at >= Math.min(last.costMs * 10, REFRESH_MAX_SKIP_MS);
}

const lastRefresh = new Map<string, RefreshStamp>();

function clip(text: string): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > ROW_TEXT_MAX ? `${t.slice(0, ROW_TEXT_MAX - 3)}...` : t;
}

function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

function symbolRow(root: string, s: Symbol): LocateRow {
	const rel = path.isAbsolute(s.filePath) ? path.relative(root, s.filePath) : s.filePath;
	return { file: toPosix(rel), line: s.startLine, kind: s.kind, text: clip(s.signature || s.name) };
}

function fileSummary(root: string, repoId: string | null, rel: string): string {
	if (repoId) {
		const outline = getFileOutline(repoId, rel.split("/").join(path.sep));
		if (outline) {
			const top = outline.symbols.filter((s) => s.id.split("::").length === 2).map((s) => s.name);
			if (top.length) return `${top.length} symbols: ${top.slice(0, 6).join(", ")}`;
		}
	}
	try {
		const fd = fs.openSync(path.join(root, rel), "r");
		const buf = Buffer.alloc(2048);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		const first = buf
			.subarray(0, n)
			.toString("utf8")
			.split("\n")
			.find((l) => l.trim());
		return first ?? "";
	} catch {
		return "";
	}
}

function symbolHits(repoId: string | null, name: string, limit = 20): Symbol[] {
	if (!repoId) return [];
	return searchSymbols(repoId, name, { limit, matchSignature: false });
}

async function pathRows(ctx: RunCtx, term: string, line?: number): Promise<LocateRow[]> {
	const files = await listFiles(ctx);
	return rankPaths(term, files).map((file) => ({
		file,
		line: line ?? 1,
		kind: "file",
		text: clip(fileSummary(ctx.root, ctx.repoId, file)),
	}));
}

async function grepRows(ctx: RunCtx, term: string): Promise<LocateRow[]> {
	let hits = await grepLiteral(ctx.state, ctx.root, [term]);
	if (hits.length === 0 && /[A-Z]/.test(term) && !ctx.state.rgMissing && !ctx.state.rgTimedOut) {
		hits = await grepLiteral(ctx.state, ctx.root, [term], true);
	}
	return rankGrepHits(term, hits).map((h) => ({
		file: h.file,
		line: h.line,
		kind: "match",
		text: clip(h.text),
	}));
}

/** Prose: symbols, text lines and files that carry at least two query words, interleaved. */
async function hybridRows(ctx: RunCtx, terms: string[]): Promise<LocateRow[]> {
	if (terms.length === 0) return [];
	const need = Math.min(2, terms.length);
	const count = (s: string) => {
		const l = s.toLowerCase();
		return terms.filter((t) => l.includes(t)).length;
	};

	// Symbols whose name carries the most query words.
	const bySymbol = new Map<string, { s: Symbol; n: number }>();
	for (const t of terms) {
		for (const s of symbolHits(ctx.repoId, t, 50)) {
			if (!bySymbol.has(s.id)) bySymbol.set(s.id, { s, n: count(s.name) });
		}
	}
	const symbols = [...bySymbol.values()]
		.filter((x) => x.n >= need)
		.sort((a, b) => b.n - a.n)
		.slice(0, 3)
		.map((x) => symbolRow(ctx.root, x.s));

	const files = (await listFiles(ctx))
		.map((f) => ({ f, n: count(f) }))
		.filter((x) => x.n >= need)
		.sort((a, b) => b.n - a.n || a.f.length - b.f.length || (a.f < b.f ? -1 : 1))
		.slice(0, 2)
		.map(({ f }) => ({
			file: f,
			line: 1,
			kind: "file",
			text: clip(fileSummary(ctx.root, ctx.repoId, f)),
		}));

	const lines = (await grepLiteral(ctx.state, ctx.root, terms, true))
		.map((h) => ({ h, n: count(h.text) }))
		.filter((x) => x.n >= need)
		.sort(
			(a, b) =>
				b.n - a.n ||
				Number(TEST_PATH_RE.test(a.h.file)) - Number(TEST_PATH_RE.test(b.h.file)) ||
				a.h.file.length - b.h.file.length ||
				(a.h.file < b.h.file ? -1 : a.h.file > b.h.file ? 1 : 0) ||
				a.h.line - b.h.line,
		)
		.slice(0, 3)
		.map(({ h }) => ({ file: h.file, line: h.line, kind: "match", text: clip(h.text) }));

	return mergeRows([symbols, lines, files]);
}

/** A mode System One may pick for prose that runs a per-word search. */
type KeptMode = "symbol" | "grep" | "path";

/**
 * A kept semantic mode: the symbols nearest the whole query in meaning.
 * When semantic cannot answer (building, no model, slow, no index) the
 * reason is recorded and no rows come back, so locate falls back to hybrid.
 */
async function semanticRows(ctx: RunCtx, query: string): Promise<LocateRow[]> {
	const search = ctx.semantic === undefined ? semanticSearch : ctx.semantic;
	if (!search || !ctx.repoId) {
		ctx.state.semantic = {
			status: "unavailable",
			detail: ctx.indexPending ? "the symbol index is still building" : "no semantic search",
		};
		return [];
	}
	let answer: SemanticAnswer;
	try {
		answer = await search(ctx.repoId, query);
	} catch (err) {
		answer = {
			status: "error",
			hits: [],
			detail: err instanceof Error ? err.message : String(err),
		};
	}
	if (answer.status !== "ready" || answer.hits.length === 0) {
		const { hits: _hits, ...rest } = answer;
		ctx.state.semantic = rest;
		return [];
	}
	return answer.hits.slice(0, LOCATE_MAX_ROWS).map((h) => {
		if (h.symbol) return symbolRow(ctx.root, h.symbol);
		const rel = toPosix(path.relative(ctx.root, h.file));
		return { file: rel, line: 1, kind: "file", text: clip(fileSummary(ctx.root, ctx.repoId, rel)) };
	});
}

/** How many hits per query word a kept mode pools before ranking by word count. */
const KEPT_POOL_PER_WORD = 50;

/**
 * Prose routed by System One: only the chosen mode's own search (the symbol
 * index, rg -F, or the path ranker) over the query words, pooled and ordered
 * by how many query words a row carries (file path plus text), then by the
 * search's own order. At most two rows from one file.
 */
async function keptModeRows(
	ctx: RunCtx,
	mode: KeptMode,
	terms: string[],
	lookup: (name: string) => Symbol[],
): Promise<LocateRow[]> {
	const lists: LocateRow[][] = [];
	if (mode === "symbol") {
		for (const t of terms) lists.push(lookup(t).map((s) => symbolRow(ctx.root, s)));
	} else if (mode === "path") {
		const files = await listFiles(ctx);
		for (const t of terms) {
			lists.push(
				rankPaths(t, files, KEPT_POOL_PER_WORD).map((file) => ({
					file,
					line: 1,
					kind: "file",
					text: "",
				})),
			);
		}
	} else {
		// One rg run for all words, as hybrid does, so a line with several of them is seen.
		const hits = await grepLiteral(ctx.state, ctx.root, terms, true);
		lists.push(
			hits
				.sort(
					(a, b) =>
						Number(TEST_PATH_RE.test(a.file)) - Number(TEST_PATH_RE.test(b.file)) ||
						a.file.length - b.file.length ||
						(a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
						a.line - b.line,
				)
				.map((h) => ({ file: h.file, line: h.line, kind: "match", text: clip(h.text) })),
		);
	}
	const count = (r: LocateRow) => {
		const l = `${r.file} ${r.text}`.toLowerCase();
		return terms.filter((t) => l.includes(t)).length;
	};
	const perFile = new Map<string, number>();
	const out: LocateRow[] = [];
	for (const { row } of mergeRows(lists, Number.POSITIVE_INFINITY)
		.map((row, i) => ({ row, i, n: count(row) }))
		.sort((a, b) => b.n - a.n || a.i - b.i)) {
		const n = perFile.get(row.file) ?? 0;
		if (n >= 2) continue;
		perFile.set(row.file, n + 1);
		out.push(row);
		if (out.length === LOCATE_MAX_ROWS) break;
	}
	// File rows get their summary only once chosen: reading every pooled file would be slow.
	return out.map((r) =>
		r.kind === "file" ? { ...r, text: clip(fileSummary(ctx.root, ctx.repoId, r.file)) } : r,
	);
}

/** Interleave row lists (first of each, then second of each ...), drop repeats of file:line. */
export function mergeRows(lists: LocateRow[][], limit = LOCATE_MAX_ROWS): LocateRow[] {
	const out: LocateRow[] = [];
	const seen = new Set<string>();
	const longest = Math.max(0, ...lists.map((l) => l.length));
	for (let i = 0; i < longest && out.length < limit; i++) {
		for (const list of lists) {
			const row = list[i];
			if (!row) continue;
			const key = `${row.file}:${row.line}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(row);
			if (out.length === limit) break;
		}
	}
	return out;
}

async function runRoute(
	ctx: RunCtx,
	route: LocateRoute,
	lookup: (name: string) => Symbol[],
): Promise<LocateRow[]> {
	if (route.rule === "system_one") {
		const mode = route.mode;
		if (mode === "semantic") return semanticRows(ctx, route.term);
		if (mode !== "hybrid") return keptModeRows(ctx, mode, route.terms ?? [], lookup);
	}
	switch (route.mode) {
		case "symbol":
			return lookup(route.term)
				.slice(0, LOCATE_MAX_ROWS)
				.map((s) => symbolRow(ctx.root, s));
		case "path": {
			const rows = await pathRows(ctx, route.term, route.line);
			// A path-looking token that names no file may still be text in one.
			return rows.length > 0 ? rows : grepRows(ctx, route.term);
		}
		case "grep":
			return grepRows(ctx, route.term);
		case "hybrid":
		case "semantic":
			return hybridRows(ctx, route.terms ?? []);
	}
}

const KEPT_MODES = new Set<string>(["symbol", "grep", "path", "semantic"]);

/**
 * Ask System One about a prose route. Its mode replaces hybrid only when the
 * router kept it (at or above threshold); the answer is recorded either way.
 * A router that throws counts as an error: hybrid.
 */
async function consultSystemOne(
	route: LocateRoute,
	router: ProseRouter | null,
): Promise<LocateRoute> {
	if (!router || route.rule !== "prose" || !route.terms?.length) return route;
	let s: ProseRouting;
	const t0 = performance.now();
	try {
		s = await router(route.term);
	} catch (err) {
		s = {
			mode: "hybrid",
			reason: "error",
			latencyMs: Math.round(performance.now() - t0),
			error: err instanceof Error ? err.message : String(err),
		};
	}
	if (s.reason === "model" && KEPT_MODES.has(s.mode)) {
		return { ...route, mode: s.mode as LocateMode, rule: "system_one", systemOne: s };
	}
	return { ...route, systemOne: s };
}

/** Answer "where is X?" for `query` under `ctx.root`. Read-only. */
export async function locate(query: string, context: LocateContext): Promise<LocateResult> {
	const q = (query ?? "").trim();
	const ctx: RunCtx = {
		...context,
		state: { bin: context.rg, timeoutMs: context.rgTimeoutMs, rgMissing: false, rgTimedOut: false },
	};
	if (ctx.repoId && ctx.refresh !== false && refreshDue(lastRefresh.get(ctx.repoId), Date.now())) {
		// Awaited, so a file written a moment ago is seen, but in batches that
		// give the event loop a turn, so a very large tree does not stall it.
		const t0 = performance.now();
		await refreshIndexAsync(ctx.repoId);
		lastRefresh.set(ctx.repoId, { at: Date.now(), costMs: performance.now() - t0 });
	}

	const cache = new Map<string, Symbol[]>();
	const lookup = (name: string) => {
		let hits = cache.get(name);
		if (!hits) {
			hits = rankSymbols(name, symbolHits(ctx.repoId, name));
			cache.set(name, hits);
		}
		return hits;
	};
	const router = context.systemOne === undefined ? defaultProseRouter() : context.systemOne;
	const answer = async (r: LocateRoute) => {
		const routed = await consultSystemOne(r, router);
		const found = await runRoute(ctx, routed, lookup);
		// The kept mode found nothing: fail open to the rules' hybrid answer.
		if (found.length === 0 && routed.rule === "system_one" && routed.systemOne) {
			const back: LocateRoute = {
				...r,
				systemOne: { ...routed.systemOne, mode: "hybrid", reason: "no_rows" },
			};
			return { route: back, rows: await runRoute(ctx, back, lookup) };
		}
		return { route: routed, rows: found };
	};
	let { route, rows } = await answer(
		routeQuery(q, (name) => lookup(name)[0]?.name.toLowerCase() === name.toLowerCase()),
	);
	// Pasted text that is not in the repo: read it as a path, name or prose.
	if (rows.length === 0 && route.fallback) ({ route, rows } = await answer(route.fallback));
	const result: LocateResult = { query: q, route, rows: rows.slice(0, LOCATE_MAX_ROWS) };
	if (ctx.state.rgMissing) result.rgMissing = true;
	if (ctx.state.rgTimedOut) result.incomplete = true;
	if (ctx.indexPending) result.indexPending = true;
	if (ctx.state.semantic) result.semantic = ctx.state.semantic;
	return result;
}

/** "prose", or what System One said about it: "system_one path 0.91", "prose, system_one timeout". */
function ruleLabel(route: LocateRoute): string {
	const s = route.systemOne;
	if (!s) return route.rule;
	const said = [s.chosen, typeof s.confidence === "number" ? s.confidence.toFixed(2) : undefined]
		.filter(Boolean)
		.join(" ");
	if (route.rule === "system_one") return `system_one ${said}`.trim();
	return `${route.rule}, system_one ${s.reason}${said ? ` ${said}` : ""}`;
}

/** The tool's text answer: one header line, then at most five rows. */
export function formatLocate(result: LocateResult): string {
	const { route, rows } = result;
	// Semantic searches the whole query; the other System One modes, like hybrid, its words.
	const byTerms =
		route.mode === "hybrid" || (route.rule === "system_one" && route.mode !== "semantic");
	const head = `locate ${route.mode} (${ruleLabel(route)}): ${clip(byTerms ? (route.terms ?? []).join(" ") : route.term) || "(empty)"}`;
	// When a search did not run or did not finish, say so rather than
	// reporting that the text does not exist.
	const notes: string[] = [];
	if (result.rgMissing) {
		notes.push(
			"ripgrep (rg) was not found on PATH, so text and file search did not run. Install ripgrep or use search_symbols.",
		);
	} else if (result.incomplete) {
		notes.push(
			"ripgrep stopped after its time limit on this tree, so text and file search are partial. A longer term or a path narrows it.",
		);
	}
	if (result.indexPending) {
		notes.push(
			"The symbol index is still building, so this answer used text and file search only.",
		);
	}
	const sem = result.semantic;
	if (sem?.status === "building") {
		notes.push(
			`The semantic index is still being built (${sem.done ?? 0} of ${sem.total ?? 0} texts embedded), so this is the hybrid answer.`,
		);
	} else if (sem?.status === "unavailable") {
		notes.push(
			`Semantic search is not available${sem.detail ? ` (${sem.detail})` : ""}, so this is the hybrid answer.`,
		);
	} else if (sem) {
		notes.push(
			`Semantic search did not answer (${sem.status}${sem.detail ? `: ${sem.detail}` : ""}), so this is the hybrid answer.`,
		);
	}
	if (rows.length > 0) {
		return [head, ...rows.map((r) => `${r.file}:${r.line} ${r.kind} ${r.text}`), ...notes].join(
			"\n",
		);
	}
	if (notes.length > 0) return [head, ...notes].join("\n");
	// Prose needs two of its words on one row; name the likeliest single word.
	const terms = route.mode === "hybrid" ? (route.terms ?? []) : [];
	if (terms.length >= 2) {
		const word = [...terms].sort((a, b) => b.length - a.length)[0];
		return `${head}\nno row holds two of: ${terms.join(", ")}. Try one word, e.g. locate("${word}").`;
	}
	return `${head}\nno matches. Try a shorter term, a symbol name, or a path fragment.`;
}
