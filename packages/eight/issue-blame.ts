/**
 * issue-blame.ts - one owning file per ticket (#4320).
 *
 * The issue-file-practice pilot asks for a ticket naming the source file most
 * likely at fault. The model names config.go, then adds "the struct lives in
 * cors.go" and the ticket blames two files. A prompt line (#4317) did not
 * hold, so the check is in the tool path: the first `gh issue create` whose
 * body names more than one non-test source file is held once, the files are
 * listed back, and the model is asked to trim. The same file set sent again
 * goes through, so a ticket that really spans two files is never refused.
 *
 * The body file is read like the file tools read: path guard first, text refusal
 * of UNC, home and absolute names before any fs call, one O_NOFOLLOW open, and
 * the descriptor judged (regular file, one link, 64 KB). Files are keyed by full
 * path; a bare name merges into a full path with the same base name.
 */
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { cdPrefix } from "../permissions/cd-prefix";
import { validatePath } from "../permissions/path-guard";

const SOURCE_FILE =
	/(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|rs|java|rb|c|cc|cpp|h|hpp|cs|kt|swift|php))(?![\w-])(:\d+)?/g;
const TEST_FILE = /(?:_test\.|\.test\.|\.spec\.|(?:^|\/)(?:tests?|__tests__|testdata)\/)/;
/**
 * A bare name with these extensions is usually a product (Next.js, Node.js,
 * vue.js), so it counts only with a directory or a :line suffix.
 */
const PRODUCT_LIKE = /\.(?:js|ts|py|rs|cs)$/;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Distinct non-test source files a ticket body names. Keyed by full path
 * (two dirs holding a same-named file are two files); a bare name merges into
 * a full path with the same base name, because it means that file.
 */
export function sourceFilesNamed(body: string): string[] {
	const full = new Set<string>();
	const bare = new Set<string>();
	for (const m of body.matchAll(SOURCE_FILE)) {
		const file = m[1].replace(/^\.\//, "");
		if (TEST_FILE.test(file)) continue;
		if (file.includes("/")) full.add(file);
		else if (!PRODUCT_LIKE.test(file) || m[2]) bare.add(file);
	}
	const bases = new Set([...full].map((f) => f.slice(f.lastIndexOf("/") + 1)));
	return [...full, ...[...bare].filter((b) => !bases.has(b))];
}

function unquote(raw: string): string {
	const q = raw[0];
	return (q === '"' || q === "'") && raw.endsWith(q) && raw.length > 1 ? raw.slice(1, -1) : raw;
}

/** `command` from `gh issue create` to the next unquoted ; & | or newline. */
function ghSegment(command: string): string | null {
	const at = command.search(/(?:^|[\s;&|])gh\s+issue\s+create\b/);
	if (at < 0) return null;
	let quote = "";
	let out = "";
	for (const ch of command.slice(at).replace(/^[\s;&|]+/, "")) {
		if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") break;
		out += ch;
	}
	return out;
}

/**
 * Read a body file the way the file tools would: the path guard first, then one
 * open that cannot follow a link or block on a FIFO, judged on the descriptor.
 */
function readBodyFile(name: string, dir: string): string | null {
	// Text-only refusals before any filesystem call (a UNC path opens SMB on Windows).
	if (/^(?:~|[\\/]{2}|[A-Za-z]:)/.test(name) || isAbsolute(name) || name.includes("\\"))
		return null;
	if (!validatePath(name, dir, {}, "read").ok) return null;
	let fd = -1;
	try {
		const root = realpathSync(dir);
		const full = realpathSync(join(root, name));
		const rel = relative(root, full);
		if (rel.startsWith("..") || isAbsolute(rel)) return null;
		fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		const st = fstatSync(fd);
		if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BODY_BYTES) return null;
		const buf = Buffer.alloc(Math.min(st.size, MAX_BODY_BYTES));
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, got);
			if (n <= 0) break;
			got += n;
		}
		return buf.subarray(0, got).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd >= 0) closeSync(fd);
	}
}

/** The body a `gh issue create` command will file, or null when it is not one or the body is unreadable. */
export function issueBodyOf(command: string, workingDirectory: string): string | null {
	let dir = workingDirectory;
	let text = command;
	const cd = cdPrefix(command, workingDirectory);
	if (cd.kind === "cd") {
		dir = cd.dir;
		text = cd.rest;
	} else if (cd.kind === "refused") return null;
	const seg = ghSegment(text);
	if (seg === null) return null;
	const fileArg = /(?:^|\s)(?:--body-file|-F)(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(seg)?.[1];
	if (fileArg) {
		const name = unquote(fileArg);
		return name === "-" ? null : readBodyFile(name, dir);
	}
	const inline = /(?:^|\s)(?:--body|-b)(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*')/.exec(seg)?.[1];
	return inline ? unquote(inline) : null;
}

/** Remembers which file sets were already held, so each is held once. */
export class IssueBlameGate {
	private held = new Set<string>();

	/** A message to return in place of running the command, or null to let it run. */
	check(body: string): string | null {
		const files = sourceFilesNamed(body);
		if (files.length < 2) return null;
		const key = files
			.map((f) => f.slice(f.lastIndexOf("/") + 1))
			.sort()
			.join("|");
		if (this.held.has(key)) return null;
		this.held.add(key);
		return [
			"[HOLD] The ticket was NOT filed. Its body names more than one source file:",
			...files.map((f) => `  - ${f}`),
			"A ticket blames the one file that owns the change. Keep that file, remove the others from the body (a file only read for context does not belong in it), rewrite the body, then run the same command again.",
		].join("\n");
	}
}
