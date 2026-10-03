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
 */
export const HEAD_BYTES = 2 * 1024;
export const TAIL_BYTES = 12 * 1024;

// Step a byte offset off a UTF-8 continuation byte so no character is split.
function charBoundary(buf: Buffer, i: number, dir: 1 | -1): number {
	while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i += dir;
	return i;
}

export function capOutput(text: string): string {
	const buf = Buffer.from(text);
	if (buf.length <= HEAD_BYTES + TAIL_BYTES) return text;
	const headEnd = charBoundary(buf, HEAD_BYTES, -1);
	const tailStart = charBoundary(buf, buf.length - TAIL_BYTES, 1);
	return `${buf.subarray(0, headEnd)}\n[${tailStart - headEnd} bytes omitted]\n${buf.subarray(tailStart)}`;
}

export function formatCommandOutput(code: number | null, stdout: string, stderr: string): string {
	if (code === 0) {
		const out = stdout.trimEnd();
		const err = stderr.trimEnd();
		if (out && err) return capOutput(`${out}\n[stderr]\n${err}`);
		return capOutput(out || err) || "Command completed successfully.";
	}
	return `Exit code ${code}:\n${stdout}\n${stderr}`;
}
