/**
 * Local bug report (Pi parity row D11, module side).
 *
 * Builds a folder under <home>/.8gent/bug-reports/ holding report.json
 * (version, OS, runtime), the current session file and the last log lines,
 * with secrets redacted by secret-scanner's scrub and the home directory
 * shortened to "~". Nothing is uploaded or sent: the person looks at the
 * folder and shares it themselves. A folder, not a zip: no zip library is a
 * dependency of this repo. Wired to /bug (TUI) and `8gent bug` (CLI) by bug-command.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome } from "../core/home.js";
import { scrub } from "./secret-scanner.js";
import { listSessions } from "./session-store.js";

export interface BugReportOptions {
	env?: NodeJS.ProcessEnv;
	/** Session file to include. Default: newest session started in `cwd`. */
	sessionFile?: string;
	cwd?: string;
	sessionsDir?: string;
	/** Log files to tail. Default: ~/.8gent/{tui,debug,daemon}.log that exist. */
	logFiles?: string[];
	logLines?: number;
	/** 8gent version. Default: package.json found above this file. */
	version?: string;
	/** What the person typed after /bug, stored as given (redacted). */
	note?: string;
	now?: Date;
}

const MAX_SESSION_BYTES = 5 * 1024 * 1024;

function redact(text: string, home: string): { text: string; redacted: number } {
	const r = scrub(text);
	const shortened = home.length > 1 ? r.scrubbed.split(home).join("~") : r.scrubbed;
	return { text: shortened, redacted: r.redactedCount };
}

function readTail(file: string, maxBytes: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const len = Math.min(size, maxBytes);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, size - len);
		let s = buf.toString("utf8");
		if (size > len) s = s.slice(s.indexOf("\n") + 1);
		return s;
	} finally {
		fs.closeSync(fd);
	}
}

function packageVersion(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		try {
			const v = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
			if (typeof v === "string") return v;
		} catch {}
		dir = path.dirname(dir);
	}
	return "unknown";
}

/** Write the report folder and return its path. Throws only if the folder cannot be created. */
export function createBugReport(opts: BugReportOptions = {}): string {
	const env = opts.env ?? process.env;
	const home = resolveHome(env);
	const now = opts.now ?? new Date();
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const root = path.join(home, ".8gent", "bug-reports");
	let dir = path.join(root, `bug-${stamp}`);
	for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, `bug-${stamp}-${n}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

	const files: string[] = [];
	let redacted = 0;
	const put = (name: string, raw: string) => {
		const r = redact(raw, home);
		redacted += r.redacted;
		fs.writeFileSync(path.join(dir, name), r.text, { mode: 0o600 });
		files.push(name);
	};

	let sessionFile = opts.sessionFile;
	if (!sessionFile) {
		try {
			const dataDir = env.EIGHT_DATA_DIR;
			const sessionsDir =
				opts.sessionsDir ??
				(dataDir ? path.join(dataDir, "sessions") : path.join(home, ".8gent", "sessions"));
			sessionFile = listSessions({ cwd: opts.cwd ?? process.cwd(), limit: 1, sessionsDir })[0]
				?.file;
		} catch {}
	}
	if (sessionFile) {
		try {
			put("session" + path.extname(sessionFile), readTail(sessionFile, MAX_SESSION_BYTES));
		} catch {}
	}

	const logFiles =
		opts.logFiles ??
		["tui.log", "debug.log", "daemon.log"].map((f) => path.join(home, ".8gent", f));
	const n = opts.logLines ?? 200;
	const logParts: string[] = [];
	for (const f of logFiles) {
		try {
			const lines = readTail(f, 256 * 1024)
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(-n);
			logParts.push(
				`=== ${path.basename(f)} (last ${lines.length} lines) ===\n${lines.join("\n")}`,
			);
		} catch {}
	}
	if (logParts.length) put("log-tail.txt", logParts.join("\n\n") + "\n");

	// The report is our own JSON, so it is not run through the scrubber: the name-based rule (#4018) reads
	// the key "redactedSecrets" as a secret name and would blank its value. The only free text in it, the
	// note, is scrubbed on its own and counted.
	const note = opts.note === undefined ? null : redact(opts.note, home);
	if (note) redacted += note.redacted;
	// version is free text when passed in, so it goes through the same scrubber as the note.
	const version = redact(opts.version ?? packageVersion(), home);
	redacted += version.redacted;
	fs.writeFileSync(
		path.join(dir, "report.json"),
		JSON.stringify(
			{
				createdAt: now.toISOString(),
				version: version.text,
				os: { platform: process.platform, release: os.release(), arch: process.arch },
				runtime: { bun: process.versions.bun ?? null, node: process.versions.node },
				note: note ? note.text : null,
				files: files.filter((f) => f !== "report.json"),
				redactedSecrets: redacted,
				uploaded: false,
				before_sharing:
					"Read every file in this folder before you share it. Secrets are redacted on a best-effort basis, so check for anything private.",
			},
			null,
			2,
		) + "\n",
		{ mode: 0o600 },
	);
	return dir;
}
