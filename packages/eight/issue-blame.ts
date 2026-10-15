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
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const SOURCE_FILE =
	/(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|rs|java|rb|c|cc|cpp|h|hpp|cs|kt|swift|php))(?![\w-])/g;
const TEST_FILE = /(?:_test\.|\.test\.|\.spec\.|(?:^|\/)(?:tests?|__tests__|testdata)\/)/;
const MAX_BODY_BYTES = 64 * 1024;

/** Distinct non-test source files a ticket body names, keyed by base name. */
export function sourceFilesNamed(body: string): string[] {
	const byBase = new Map<string, string>();
	for (const m of body.matchAll(SOURCE_FILE)) {
		const file = m[1];
		if (TEST_FILE.test(file)) continue;
		const base = file.slice(file.lastIndexOf("/") + 1);
		const kept = byBase.get(base);
		if (!kept || file.length > kept.length) byBase.set(base, file);
	}
	return [...byBase.values()];
}

function unquote(raw: string): string {
	const q = raw[0];
	return (q === '"' || q === "'") && raw.endsWith(q) && raw.length > 1 ? raw.slice(1, -1) : raw;
}

/** The body a `gh issue create` command will file, or null when it is not one or the body is unreadable. */
export function issueBodyOf(command: string, workingDirectory: string): string | null {
	if (!/(?:^|[;&|]\s*|\s)gh\s+issue\s+create\b/.test(command)) return null;
	const fileArg = /(?:--body-file|-F)(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command)?.[1];
	if (fileArg) {
		const name = unquote(fileArg);
		if (name === "-") return null;
		try {
			const root = realpathSync(workingDirectory);
			const full = realpathSync(resolve(root, name));
			const rel = relative(root, full);
			if (rel.startsWith("..") || isAbsolute(rel)) return null;
			const st = lstatSync(full);
			if (!st.isFile() || st.size > MAX_BODY_BYTES) return null;
			return readFileSync(full, "utf8");
		} catch {
			return null;
		}
	}
	const inline = /(?:--body|-b)(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*')/.exec(command)?.[1];
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
