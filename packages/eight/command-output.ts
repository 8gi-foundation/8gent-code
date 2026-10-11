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
 * Files a silent command wrote on purpose: curl/wget -o, --output, -c, -D and shell `>` redirects.
 * (browser_operation pilot, 11 Oct: curl -o printed nothing, the model could not tell it had
 * worked, repeated the identical call and ran out its 600 s turn. Its fallback paths in /tmp
 * were then refused by read_file.)
 */
export function writtenFiles(command: string): string[] {
	const files: string[] = [];
	const add = (f?: string) => {
		const t = f?.replace(/^["']|["']$/g, "");
		if (t && t !== "-" && !t.startsWith("/dev/") && !t.startsWith("&") && !files.includes(t)) files.push(t);
	};
	if (/\b(curl|wget)\b/.test(command)) {
		for (const m of command.matchAll(/(?:^|\s)(?:-o|-c|-D|-O|--output|--cookie-jar|--dump-header)(?:\s+|=)(\S+)/g)) add(m[1]);
	}
	for (const m of command.matchAll(/(?:^|[^>\d&])\d?>>?\s*([^\s&|;<>]+)/g)) add(m[1]);
	return files;
}

export function silentSuccessNote(command: string | undefined, workingDirectory?: string): string {
	const base = "Command completed successfully.";
	const files = command ? writtenFiles(command) : [];
	if (files.length === 0) return base;
	const outside = files.filter((f) => f.startsWith("/") && workingDirectory && !f.startsWith(`${workingDirectory}/`));
	let note = `${base} It printed nothing; it wrote ${files.join(", ")}. Run read_file on that file to see the result, do not repeat the command.`;
	if (outside.length > 0) {
		note += ` read_file can only open files inside the working directory, so write ${outside.join(", ")} somewhere under it (for example ./name) next time.`;
	}
	return note;
}

export function formatCommandOutput(
	code: number | null,
	stdout: string,
	stderr: string,
	command?: string,
	workingDirectory?: string,
): string {
	if (code === 0) {
		const out = stdout.trimEnd();
		const err = stderr.trimEnd();
		if (out && err) return capOutput(`${out}\n[stderr]\n${err}`);
		return capOutput(out || err) || silentSuccessNote(command, workingDirectory);
	}
	return `Exit code ${code}:\n${stdout}\n${stderr}`;
}
