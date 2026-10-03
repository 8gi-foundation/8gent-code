/**
 * command-output.ts - what run_command hands back to the model.
 *
 * #3373: on exit 0 run_command returned `stdout || stderr`, so a command that writes to
 * both streams lost stderr. `bun test` prints its header to stdout and every test line plus
 * the "N pass / N fail" summary to stderr, so a passing suite showed only
 * "bun test v1.4.2". The agent could not see that its fix worked, re-ran the suite, and
 * redirected output into stray files in the user's repo (pilot ops-test-config and
 * l3-feature-tdd, 2026-10-03). On success both streams are now returned.
 */
export function formatCommandOutput(code: number | null, stdout: string, stderr: string): string {
	if (code === 0) {
		const out = stdout.trimEnd();
		const err = stderr.trimEnd();
		if (out && err) return `${out}\n${err}`;
		return out || err || "Command completed successfully.";
	}
	return `Exit code ${code}:\n${stdout}\n${stderr}`;
}
