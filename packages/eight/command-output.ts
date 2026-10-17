/**
 * command-output.ts - what run_command hands back to the model.
 *
 * #3373: on exit 0 run_command returned `stdout || stderr`, so a command that writes to
 * both streams lost stderr. `bun test` prints its header to stdout and every test line plus
 * the "N pass / N fail" summary to stderr, so a passing suite showed only
 * "bun test v1.4.2". The agent could not see that its fix worked, re-ran the suite, and
 * redirected output into stray files in the user's repo (pilot ops-test-config and
 * l3-feature-tdd, 2026-10-03). On success both streams are now returned, stderr labelled.
 *
 * Success output is capped to the first HEAD_BYTES plus the last TAIL_BYTES. Anything over
 * ArtifactStore's 50,000-byte threshold is replaced by a 1,024-byte preview of its start,
 * which is exactly where bun's summary is not. Keeping the end keeps the summary.
 *
 * Secrets are scrubbed on the full text BEFORE the cut. ToolExecutor.execute scrubs again
 * after executeRaw, but by then a token straddling a cut is two fragments the scanner no
 * longer matches, and one of them reaches the model (#2464, 8SO review of #3376).
 */
import {
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isWindowsDeviceName } from "../permissions/path-guard";
import { redirectTargets } from "../permissions/s1-created-files";
import { scrub } from "./secret-scanner";

export const HEAD_BYTES = 2 * 1024;
export const TAIL_BYTES = 12 * 1024;

// Step a byte offset off a UTF-8 continuation byte so no character is split.
function charBoundary(buf: Buffer, i: number, dir: 1 | -1): number {
	while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i += dir;
	return i;
}

export function capOutput(text: string): string {
	if (Buffer.byteLength(text) <= HEAD_BYTES + TAIL_BYTES) return text;
	const clean = scrub(text);
	if (clean.redactedCount > 0) {
		// Same telemetry line execute() emits; it would see nothing left to redact.
		console.warn(
			`[secret-scanner] tool=run_command redacted=${clean.redactedCount} rules=${clean.rules.join(",")}`,
		);
	}
	const buf = Buffer.from(clean.scrubbed);
	if (buf.length <= HEAD_BYTES + TAIL_BYTES) return clean.scrubbed;
	const headEnd = charBoundary(buf, HEAD_BYTES, -1);
	const tailStart = charBoundary(buf, buf.length - TAIL_BYTES, 1);
	return `${buf.subarray(0, headEnd)}\n[${tailStart - headEnd} bytes omitted]\n${buf.subarray(tailStart)}`;
}

/**
 * Files a silent command wrote on purpose. (browser_operation pilot, 11 Oct: curl -o printed
 * nothing, the model could not tell it had worked, repeated the identical call and ran out its
 * 600 s turn. Its fallback paths in /tmp were then refused by read_file.)
 *   readable: curl -o/--output, wget -O/--output-document, wget -o/--output-file (a log), `>` redirects.
 *   private:  curl -c/--cookie-jar and -D/--dump-header. They hold session cookies and headers,
 *             so they are named but never offered to read_file.
 */
export function writtenFiles(command: string): { readable: string[]; private: string[] } {
	const readable: string[] = [];
	const priv: string[] = [];
	const clean = (f?: string) => f?.replace(/^["']|["']$/g, "");
	const add = (list: string[], f?: string) => {
		const t = clean(f);
		if (t && t !== "-" && !t.startsWith("/dev/") && !t.startsWith("&") && !list.includes(t))
			list.push(t);
	};
	const flags = (re: RegExp, list: string[]) => {
		for (const m of command.matchAll(re)) add(list, m[1]);
	};
	const val = (names: string) => new RegExp(`(?:^|\\s)(?:${names})(?:\\s+|=)(\\S+)`, "g");
	if (/\bcurl\b/.test(command)) {
		flags(val("-o|--output"), readable);
		flags(val("-c|--cookie-jar|-D|--dump-header"), priv);
	}
	if (/\bwget\b/.test(command)) {
		flags(val("-O|--output-document|-o|--output-file"), readable);
	}
	// `=>` is an arrow function, not a redirect.
	for (const t of redirectTargets(command.replace(/=>/g, "= "))) add(readable, t);
	return { readable, private: priv };
}

function isOutsideCwd(f: string, workingDirectory?: string, projectRoot?: string): boolean {
	if (f.startsWith("~/") || f === "~") return true;
	if (!workingDirectory) return f === ".." || f.startsWith("../") || f.includes("/../");
	// Inside means under the directory the command ran in, or under the project root (after a `cd sub`).
	const abs = resolve(workingDirectory, f);
	return ![workingDirectory, projectRoot].some((root) => {
		if (!root) return false;
		const back = relative(root, abs);
		return back !== "" && !back.startsWith("..") && !isAbsolute(back);
	});
}

/**
 * The login-note recipe (sed -n with a Label line copied by the w flag into .tmp/NAME). It prints nothing and the
 * value is scrubbed from read_file, so the model had no record of where it went. #4303 (run
 * 2026-10-15_132220): it posted `password@.tmp/pw.txt` for a file it had written as .tmp/login,
 * lost four minutes on the missing file and ran out the 600 s turn. The note names the file.
 */
const LOGIN_COPY =
	/^sed -n 's\/\^[A-Za-z][A-Za-z0-9 _-]*: \*\/[a-z][a-z0-9_-]*=\/w (\.tmp\/[A-Za-z0-9._-]+)' \S+$/;

/**
 * The value-only variant: a sed print of the Label line's value redirected into .tmp/NAME leaves the bare value, no field name.
 * #4324 (run 2026-10-16_004027): the model posted that file as a curl form body, which sent the value as a
 * field name (401), and spent the rest of the 600 s turn on the wrong cause. The note says what the file
 * holds and gives the w-flag recipe that writes field=value into a new file.
 */
const LOGIN_VALUE_ONLY =
	/^sed -n 's\/\^([A-Za-z][A-Za-z0-9 _-]*): \*?\/\/p' (\S+) > (\.tmp\/[A-Za-z0-9._-]+)$/;

/**
 * Where a curl -D dump-header says the server redirected to. #4318 (run 2026-10-15_232213): a
 * login POST answered 302 /settings, but the header file is private ("do not read it") and
 * curl -L is refused with "read the Location header", so the model never learned the target,
 * re-fetched the sign-in page and ran out the 600 s turn. Only the status line and a plain
 * path or loopback URL from Location are surfaced; Set-Cookie and every other header stay unread.
 */
export function redirectNote(
	command: string | undefined,
	workingDirectory?: string,
	projectRoot?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!command || !/\bcurl\b/.test(command) || !workingDirectory) return "";
	const m = /(?:^|\s)(?:-D|--dump-header)(?:\s+|=)(\S+)/.exec(command);
	const rel = m?.[1]?.replace(/^["']|["']$/g, "");
	if (!rel || rel.startsWith("~")) return "";
	const abs = resolve(workingDirectory, rel);
	const back = relative(workingDirectory, abs);
	if (back === "" || back.startsWith("..") || isAbsolute(back)) return "";
	// O_NOFOLLOW guards only the last component: the real parent directory must stay inside the real cwd
	// (and the real project root), so a symlinked directory cannot lead the read out.
	try {
		const parent = realpathSync(dirname(abs));
		for (const root of [workingDirectory, projectRoot]) {
			if (!root) continue;
			const rel = relative(realpathSync(root), parent);
			if (rel.startsWith("..") || isAbsolute(rel)) return "";
		}
	} catch {
		return "";
	}
	// A header file is a regular file we opened ourselves: no symlink, no FIFO or device, 8 KB at most.
	let head = "";
	let fd: number | undefined;
	// Windows leaves O_NOFOLLOW and O_NONBLOCK undefined, so the open below would not refuse a
	// link or device: refuse a device name and any non-regular file first.
	if (platform === "win32") {
		if (isWindowsDeviceName(basename(abs))) return "";
		try {
			if (!lstatSync(abs).isFile()) return "";
		} catch {
			return "";
		}
	}
	try {
		fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) return "";
		const buf = Buffer.alloc(8192);
		head = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
	// Status and Location must come from the same block, the last one (a 100 Continue or an earlier hop is skipped).
	const block =
		head
			.split(/\r?\n\r?\n/)
			.filter((b) => /^HTTP\//.test(b.trimStart()))
			.pop() ?? "";
	const status = /^HTTP\/[\d.]+ (30[1-8])\b/m.exec(block)?.[1];
	const loc =
		/^location:[ \t]*(\/(?!\/)[A-Za-z0-9._~\/?&=%#@+,-]{0,199}|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/[A-Za-z0-9._~\/?&=%#@+,-]{0,199})\r?$/im.exec(
			block,
		)?.[1];
	if (!status || !loc) return "";
	// Query and fragment can carry a code or session id, and the page to fetch does not need them shown.
	const target = loc.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
	return ` The server answered ${status} and redirected to ${target}. Fetch that address with a separate curl (no -L).`;
}

/**
 * Shown up front after a plain loopback page fetch, so the model has the rule before its first form
 * post and not only after a refusal. #4326 (run 2026-10-16_022237, 21/22): the first login post used
 * -L, System One refused it (correctly), and the run lost no_system_one_blocked although the task
 * passed. Two other runs the same hour never used -L, so it is a habit, not a hint or the task text.
 * Only a curl to 127.0.0.1, localhost or [::1] that sends no body and has no -L gets the sentence.
 */
export function loopbackFormHint(command: string | undefined): string {
	if (!command || !/\bcurl\b/.test(command)) return "";
	if (
		!/(?:^|[\s'"])https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/\s'"]|(?:^|[\s'"])https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])$/i.test(
			command,
		)
	)
		return "";
	if (
		/(?:^|\s)(?:-[A-Za-z]*[LdFXT][A-Za-z]*|--(?:location|data\S*|form\S*|request|upload-file|json))(?:\s|=|$)/.test(
			command,
		)
	)
		return "";
	return " If this page has a form, post it with curl and no -L, saving headers with -D .tmp/h.txt: the redirect target is shown after the post, then fetch it with a separate curl.";
}

export function silentSuccessNote(
	command: string | undefined,
	workingDirectory?: string,
	projectRoot?: string,
): string {
	const base = "Command completed successfully.";
	const login = command ? LOGIN_COPY.exec(command.trim()) : null;
	if (login) {
		return `${base} It printed nothing. It copied the value into ${login[1]} and did not show it: do not read or retype it, do not repeat this command. Post it with curl -d @${login[1]} and no -L (add -d for the other fields).`;
	}
	const bare = command ? LOGIN_VALUE_ONLY.exec(command.trim()) : null;
	if (bare) {
		const field = bare[1].toLowerCase().replace(/[^a-z0-9]+/g, "_");
		const form = `${bare[3]}-form`;
		return `${base} It printed nothing. It copied only the value into ${bare[3]}, with no field name, so posting that file would send the value as a field name and be refused. Do not read it. Write the field too: sed -n 's/^${bare[1]}: */${field}=/w ${form}' ${bare[2]} (one command, a new file), then post it with curl -d @${form} and no -L (add -d for the other fields).`;
	}
	const w = command ? writtenFiles(command) : { readable: [], private: [] };
	if (w.readable.length === 0 && w.private.length === 0) return base;
	let note = `${base} It printed nothing.`;
	if (w.readable.length > 0) {
		note += ` It wrote ${w.readable.join(", ")}. Run read_file on ${w.readable.length > 1 ? "those files" : "that file"} to see the result, do not repeat the command.`;
		const outside = w.readable.filter((f) => isOutsideCwd(f, workingDirectory, projectRoot));
		if (outside.length > 0) {
			note += ` read_file can only open files inside the working directory, so write ${outside.join(", ")} somewhere under it (for example ./name) next time.`;
		}
	}
	if (w.private.length > 0) {
		note += ` ${w.private.join(", ")} ${w.private.length > 1 ? "hold" : "holds"} session cookies or headers: do not read ${w.private.length > 1 ? "them" : "it"}, just pass ${w.private.length > 1 ? "them" : "it"} to the next curl.`;
	}
	return note + redirectNote(command, workingDirectory, projectRoot) + loopbackFormHint(command);
}

export function formatCommandOutput(
	code: number | null,
	stdout: string,
	stderr: string,
	command?: string,
	workingDirectory?: string,
	projectRoot?: string,
): string {
	if (code === 0) {
		const out = stdout.trimEnd();
		const err = stderr.trimEnd();
		if (out && err) return capOutput(`${out}\n[stderr]\n${err}`);
		return capOutput(out || err) || silentSuccessNote(command, workingDirectory, projectRoot);
	}
	return `Exit code ${code}:\n${stdout}\n${stderr}`;
}
