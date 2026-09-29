/**
 * Mine the locate eval set from this repo's git history, deterministically.
 *
 *   bun packages/decide/eval/locate-mine.ts [repoRoot]
 *
 * Everything is read at one fixed commit (ANCHOR), so the same repo always
 * gives the same file. Three classes, walked newest commit first, at most
 * PER_COMMIT of each class from one commit so a single big commit cannot
 * dominate:
 *
 *   identifier - an exported declaration added in a commit's diff
 *                (export function|class|const|let|var|interface|type|enum X).
 *                Query "X". Label: its definition file:line at ANCHOR. Kept
 *                only when X has exactly one exported declaration in the
 *                whole tree, and it is in the file the commit touched.
 *   path       - a file added by a commit and still tracked at ANCHOR. Query
 *                cycles full path, last two segments, bare file name (the
 *                file name only when no other tracked file shares it).
 *                Label: file:1.
 *   string     - a message-like string literal (20-90 characters, three or
 *                more words, no quotes inside) on an added line that
 *                throws, logs an error or warning, or sets a reason/message/
 *                error field. Query cycles the bare text and the text in
 *                double quotes. Label: its only occurrence at ANCHOR (kept
 *                only when the text occurs exactly once in the tree).
 *
 * Labels come from git (git grep at ANCHOR), never from the locator under
 * test. Writes packages/decide/eval/locate-queries.json.
 *
 * Outside repo (a language the TS index cannot read, so locate falls through
 * to grep and path):
 *
 *   bun packages/decide/eval/locate-mine.ts <repoRoot> --lang go|py --anchor <sha> --name <slug>
 *
 * uses the same classes with that language's declarations (Go: exported
 * func/type; Python: top-level def/class) and error lines, and writes
 * locate-queries-<slug>.json with the repo's origin URL and anchor.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** main @ 551ef336, the base of the locate work. */
export const ANCHOR = "551ef3360acdb947cee54830af5a2e17257f8497";
const TARGET = { identifier: 70, path: 35, string: 35 } as const;
const PER_COMMIT = 2;
const LOG_COMMITS = "1200";
const CODE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx"];

export type QueryClass = keyof typeof TARGET;

export interface LocateQuery {
	id: string;
	class: QueryClass;
	query: string;
	/** Label: definition (or only occurrence) file, relative to the repo root. */
	file: string;
	/** Label line, 1-based. For the path class it is 1. */
	line: number;
	/** The commit whose diff the query was mined from. */
	commit: string;
}

export type Lang = "ts" | "go" | "py";

/** What a declaration and an error line look like in one language. */
interface LangProfile {
	globs: string[];
	/** git grep -E pattern that finds every candidate declaration line. */
	defGrep: string;
	/** Captures the declared name from one line. */
	def: RegExp;
	/** A line whose string literal reads as a message. */
	stringLine: RegExp;
}

const PROFILES: Record<Lang, LangProfile> = {
	ts: {
		globs: CODE_GLOBS,
		defGrep: "^[[:space:]]*export[[:space:]]",
		def: /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
		stringLine: /\bthrow\b|\bError\(|console\.(error|warn)\(|\b(reason|message|error)\s*:/,
	},
	go: {
		globs: ["*.go"],
		defGrep: "^(func|type)[[:space:]]",
		// Exported (capitalised) funcs, methods and types, the Go analogue of export.
		def: /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Z]\w*)/,
		stringLine: /\berrors\.New\(|\bfmt\.Errorf\(|\blog\w*\.(Error|Warn|Fatal)\w*\(|\bpanic\(/,
	},
	py: {
		globs: ["*.py"],
		defGrep: "^(async[[:space:]]+)?(def|class)[[:space:]]",
		// Top-level only: an indented def is a method or a nested helper.
		def: /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/,
		stringLine: /\braise\b|\blog\w*\.(error|warning|exception|critical)\(|\bwarnings\.warn\(/,
	},
};
/** A quoted run with no quote, backslash or ${ inside, so it never spans two literals. */
const STRING_RE = /(["'`])([^"'`\\$\n]{20,90})\1/g;

function git(root: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 });
	if (r.error) throw r.error;
	// git grep exits 1 on no match; that is an empty answer, not a failure.
	if (r.status !== 0 && !(args[0] === "grep" && r.status === 1)) {
		throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr}`);
	}
	return r.stdout;
}

/** Excluded from every class: dot folders, dependencies, build output. */
function excluded(file: string): boolean {
	return file
		.split("/")
		.some((seg) => seg.startsWith(".") || seg === "node_modules" || seg === "dist");
}

interface DiffFile {
	commit: string;
	file: string;
	added: string[];
}

/** Parse `git log -p -U0` into (commit, file, added lines). */
function parseLog(out: string): DiffFile[] {
	const files: DiffFile[] = [];
	let commit = "";
	let current: DiffFile | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("@@COMMIT ")) {
			commit = line.slice(9).trim();
			current = null;
		} else if (line.startsWith("+++ ")) {
			const f = line.slice(4).trim();
			current = f === "/dev/null" ? null : { commit, file: f.replace(/^b\//, ""), added: [] };
			if (current) files.push(current);
		} else if (current && line.startsWith("+") && !line.startsWith("+++")) {
			current.added.push(line.slice(1));
		}
	}
	return files;
}

export function mine(root: string, lang: Lang = "ts", anchor: string = ANCHOR): LocateQuery[] {
	const { globs, defGrep, def: DEF_RE, stringLine: STRING_LINE_RE } = PROFILES[lang];
	const tracked = new Set(
		git(root, ["ls-tree", "-r", "--name-only", anchor]).split("\n").filter(Boolean),
	);
	const baseCount = new Map<string, number>();
	for (const f of tracked) {
		const b = f.slice(f.lastIndexOf("/") + 1);
		baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
	}

	// Every exported declaration at ANCHOR: name -> sites.
	const defs = new Map<string, { file: string; line: number }[]>();
	const grep = git(root, ["grep", "-n", "-E", defGrep, anchor, "--", ...globs]);
	for (const raw of grep.split("\n")) {
		const m = /^[0-9a-f]+:(.+?):(\d+):(.*)$/.exec(raw);
		if (!m) continue;
		const name = DEF_RE.exec(m[3])?.[1];
		if (!name) continue;
		const sites = defs.get(name) ?? [];
		sites.push({ file: m[1], line: Number(m[2]) });
		defs.set(name, sites);
	}

	const log = git(root, [
		"log",
		anchor,
		"--no-merges",
		"-n",
		LOG_COMMITS,
		"--format=@@COMMIT %H",
		"-p",
		"-U0",
		"--no-color",
		"--no-ext-diff",
		"--diff-filter=AM",
		"--",
		...globs,
	]);
	const diffs = parseLog(log);

	const out: LocateQuery[] = [];
	const seen = new Set<string>();
	const perCommit = new Map<string, number>();
	const count = (c: QueryClass) => out.filter((q) => q.class === c).length;
	const take = (q: Omit<LocateQuery, "id">): void => {
		const key = `${q.class}:${q.commit}`;
		if ((perCommit.get(key) ?? 0) >= PER_COMMIT) return;
		if (seen.has(`${q.class}:${q.query}`) || count(q.class) >= TARGET[q.class]) return;
		perCommit.set(key, (perCommit.get(key) ?? 0) + 1);
		seen.add(`${q.class}:${q.query}`);
		out.push({ id: `${q.class}-${String(count(q.class) + 1).padStart(3, "0")}`, ...q });
	};

	// identifier + string, from added code lines.
	for (const d of diffs) {
		if (!tracked.has(d.file) || excluded(d.file)) continue;
		for (const line of d.added) {
			const name = DEF_RE.exec(line)?.[1];
			if (name && name.length >= 4 && count("identifier") < TARGET.identifier) {
				const sites = defs.get(name);
				if (sites?.length === 1 && sites[0].file === d.file) {
					take({
						class: "identifier",
						query: name,
						file: d.file,
						line: sites[0].line,
						commit: d.commit,
					});
				}
			}
			if (count("string") < TARGET.string && STRING_LINE_RE.test(line)) {
				// The first literal on the line that reads as a message: starts with a
				// word character and has at least three words.
				const text = [...line.matchAll(STRING_RE)]
					.map((m) => m[2].trim())
					.find((t) => t.length >= 20 && /^[\w[]/.test(t) && t.split(/\s+/).length >= 3);
				if (!text || seen.has(`string:${text}`)) continue;
				const hits = git(root, ["grep", "-n", "-F", "-e", text, anchor])
					.split("\n")
					.filter(Boolean)
					.map((h) => /^[0-9a-f]+:(.+?):(\d+):/.exec(h))
					.filter((m): m is RegExpExecArray => m !== null);
				if (hits.length !== 1 || excluded(hits[0][1])) continue;
				const n = count("string");
				take({
					class: "string",
					query: n % 2 === 0 ? text : `"${text}"`,
					file: hits[0][1],
					line: Number(hits[0][2]),
					commit: d.commit,
				});
			}
		}
		if (count("identifier") >= TARGET.identifier && count("string") >= TARGET.string) break;
	}

	// path, from files added by a commit (any file type).
	const added = git(root, [
		"log",
		anchor,
		"--no-merges",
		"-n",
		LOG_COMMITS,
		"--format=@@COMMIT %H",
		"--name-only",
		"--diff-filter=A",
		"--no-color",
	]);
	let commit = "";
	for (const raw of added.split("\n")) {
		if (count("path") >= TARGET.path) break;
		if (raw.startsWith("@@COMMIT ")) {
			commit = raw.slice(9).trim();
			continue;
		}
		const file = raw.trim();
		if (!file || !tracked.has(file) || excluded(file) || !file.includes("/")) continue;
		const segs = file.split("/");
		const base = segs[segs.length - 1];
		const tail = segs.slice(-2).join("/");
		const form = count("path") % 3;
		const query = form === 0 ? file : form === 2 && baseCount.get(base) === 1 ? base : tail;
		take({ class: "path", query, file, line: 1, commit });
	}

	return out;
}

/** The value after `--name` in argv, if any. */
function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
	const root = path.resolve(positional[0] ?? path.join(import.meta.dir, "..", "..", ".."));
	const lang = (flag(argv, "lang") ?? "ts") as Lang;
	if (!PROFILES[lang]) throw new Error(`--lang must be one of ${Object.keys(PROFILES).join(", ")}`);
	const name = flag(argv, "name");
	const anchor = flag(argv, "anchor") ?? (name ? undefined : ANCHOR);
	if (!anchor) throw new Error("an outside repo needs --anchor <sha>, so the set is reproducible");
	const queries = mine(root, lang, anchor);
	const counts = { identifier: 0, path: 0, string: 0 } as Record<QueryClass, number>;
	for (const q of queries) counts[q.class]++;
	const file = path.join(
		import.meta.dir,
		name ? `locate-queries-${name}.json` : "locate-queries.json",
	);
	const origin = name ? git(root, ["remote", "get-url", "origin"]).trim() : undefined;
	fs.writeFileSync(
		file,
		`${JSON.stringify({ anchor, ...(name ? { repo: origin, lang } : {}), minedBy: "packages/decide/eval/locate-mine.ts", counts, queries }, null, "\t")}\n`,
	);
	console.log(
		`mined ${queries.length} queries at ${anchor.slice(0, 8)}: ${JSON.stringify(counts)}`,
	);
	console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
