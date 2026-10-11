/**
 * Deterministic extractors: the ONLY things that read values.
 *
 * Every extractor is a pure read of real state - a file, a git object, a
 * ledger chain. No shell strings (argv arrays only, so model-authored text can
 * never be interpreted by a shell), no network, no writes. The model supplies
 * locators; code supplies values.
 *
 * Safety model (Karen's requirements):
 *  - every path resolves inside an allowlisted root (no traversal escapes),
 *  - secret-shaped paths are denied outright (.env*, keys, .ssh, credentials),
 *  - git refs/ranges are validated against a strict charset and may not begin
 *    with "-" (no argv injection into git flags).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ZERO_HASH, canonical } from "../goal/ledger.js";

/** Read-only roots references may point into. Mirrors the Helm cwd allowlist,
 *  plus 8gi-governance (decision records live there and are fact sources). */
export function defaultRoots(): string[] {
	return [
		"8gent-glasses",
		"8gent-worktrees",
		"8gent-code",
		"8gi-governance",
		"Foodstackai",
		"Documents",
		"Desktop",
		"Downloads",
		"Projects",
		"code",
		"src",
	].map((d) => path.join(os.homedir(), d));
}

/** Paths that are never readable through a claim, wherever they live. */
const DENIED_PATH = [
	/\/\.env(\.[^/]*)?$/i, // .env, .env.local, ...
	/\/\.ssh(\/|$)/,
	/\/\.aws(\/|$)/,
	/\/keys?(\/|$)/i, // any keys/ directory (e.g. ~/.8gent/keys)
	/secret/i,
	/credential/i,
	/\.pem$/i,
	/\.key$/i,
];

function expandHome(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1).replace(/^\//, "")) : p;
}

/**
 * Resolve a model-supplied path safely: expand ~, make absolute, require it
 * inside an allowed root, refuse secret-shaped locations. Throws on refusal -
 * the pipeline turns that into a stripped "error" claim.
 */
export function resolveSafePath(p: string, roots: string[]): string {
	const abs = path.resolve(expandHome(p));
	const inRoot = roots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
	if (!inRoot) throw new Error(`path outside allowed roots: ${abs}`);
	// The deny patterns are written with "/"; a Windows path uses a backslash.
	const slashed = abs.split(path.sep).join("/");
	if (DENIED_PATH.some((re) => re.test(slashed))) {
		throw new Error(`path denied (secret-shaped): ${abs}`);
	}
	return abs;
}

/** Strict charset for git refs/ranges; leading "-" is refused (no flag injection). */
const GIT_ARG = /^[A-Za-z0-9][A-Za-z0-9._/^~@{}-]*(\.\.\.?[A-Za-z0-9][A-Za-z0-9._/^~@{}-]*)?$/;

function safeGitArg(v: string, label: string): string {
	if (!GIT_ARG.test(v)) throw new Error(`invalid git ${label}: ${JSON.stringify(v)}`);
	return v;
}

/** Run git read-only with argv array (never a shell). */
function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		timeout: 15_000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export interface Extractor {
	/** Args the marker must carry. */
	required: string[];
	/** Resolve the reference to a canonical string value. Throws on failure. */
	resolve(args: Record<string, string>, roots: string[]): string;
	/** One-line description surfaced to officers in their prompt. */
	describe: string;
}

export const EXTRACTORS: Readonly<Record<string, Extractor>> = Object.freeze({
	"file.sha256": {
		required: ["path"],
		describe: "sha256 hex of a file: path=",
		resolve(a, roots) {
			const p = resolveSafePath(a.path, roots);
			return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
		},
	},
	"file.lines": {
		required: ["path"],
		describe: "line count of a file: path=",
		resolve(a, roots) {
			const p = resolveSafePath(a.path, roots);
			const raw = fs.readFileSync(p, "utf8");
			if (raw.length === 0) return "0";
			// Count lines the way `wc -l` does not: a trailing newline does not
			// start an extra line. "a\nb\n" = 2 lines, "a\nb" = 2 lines.
			const n = raw.split("\n").length;
			return String(raw.endsWith("\n") ? n - 1 : n);
		},
	},
	"file.line": {
		required: ["path", "line"],
		describe: "exact text of 1-based line N: path= line=",
		resolve(a, roots) {
			const p = resolveSafePath(a.path, roots);
			const n = Number(a.line);
			if (!Number.isInteger(n) || n < 1) throw new Error(`invalid line: ${a.line}`);
			const lines = fs.readFileSync(p, "utf8").split("\n");
			if (n > lines.length) throw new Error(`line ${n} out of range (${lines.length})`);
			return lines[n - 1].trim();
		},
	},
	"dir.count": {
		required: ["path", "glob"],
		describe: "count of entries matching a glob under a directory: path= glob=",
		resolve(a, roots) {
			const p = resolveSafePath(a.path, roots);
			if (!fs.statSync(p).isDirectory()) throw new Error(`not a directory: ${p}`);
			let count = 0;
			for (const _ of new Bun.Glob(a.glob).scanSync({ cwd: p, dot: false })) count++;
			return String(count);
		},
	},
	"git.head": {
		required: ["repo"],
		describe: "HEAD commit hash of a repo: repo=",
		resolve(a, roots) {
			const repo = resolveSafePath(a.repo, roots);
			return git(repo, ["rev-parse", "HEAD"]);
		},
	},
	"git.rev": {
		required: ["repo", "ref"],
		describe: "commit hash a ref resolves to: repo= ref=",
		resolve(a, roots) {
			const repo = resolveSafePath(a.repo, roots);
			return git(repo, ["rev-parse", "--verify", safeGitArg(a.ref, "ref")]);
		},
	},
	"git.count": {
		required: ["repo", "range"],
		describe: "commit count of a rev range: repo= range= (e.g. main..HEAD)",
		resolve(a, roots) {
			const repo = resolveSafePath(a.repo, roots);
			return git(repo, ["rev-list", "--count", safeGitArg(a.range, "range")]);
		},
	},
	"git.branch": {
		required: ["repo"],
		describe: "current branch name: repo=",
		resolve(a, roots) {
			const repo = resolveSafePath(a.repo, roots);
			const b = git(repo, ["branch", "--show-current"]);
			if (!b) throw new Error("detached HEAD (no current branch)");
			return b;
		},
	},
	"ledger.head": {
		required: ["path"],
		describe: "head hash of a hash-chained ledger.jsonl, chain recomputed first: path=",
		resolve(a, roots) {
			const p = resolveSafePath(a.path, roots);
			const raw = fs.readFileSync(p, "utf8").trim();
			if (!raw) throw new Error("empty ledger");
			let prev = ZERO_HASH;
			const lines = raw.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const e = JSON.parse(lines[i]) as {
					seq: number;
					prev_hash: string;
					hash: string;
					payload: Record<string, unknown>;
				};
				if (e.seq !== i + 1) throw new Error(`chain broken at line ${i + 1}: seq`);
				if (e.prev_hash !== prev) throw new Error(`chain broken at line ${i + 1}: prev_hash`);
				const expected = createHash("sha256")
					.update(prev + canonical(e.payload ?? {}))
					.digest("hex");
				if (e.hash !== expected) throw new Error(`chain broken at line ${i + 1}: hash`);
				prev = e.hash;
			}
			// HMAC sigs are NOT checked here (the key is daemon-resident and this
			// extractor must stay key-free). Chain integrity only. Documented limit.
			return prev;
		},
	},
});

/**
 * Resolve a claim reference ONCE. The pipeline calls this twice per claim and
 * requires the two independent resolutions to agree ("unstable" otherwise).
 */
export function resolveReference(
	src: string,
	args: Record<string, string>,
	roots: string[],
): string {
	const ex = EXTRACTORS[src];
	if (!ex) throw new Error(`unknown extractor: ${src}`);
	for (const k of ex.required) {
		if (!args[k]) throw new Error(`${src}: missing required arg ${k}=`);
	}
	return ex.resolve(args, roots);
}
