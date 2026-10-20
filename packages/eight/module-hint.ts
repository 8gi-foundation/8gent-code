/**
 * When a python command fails with "No module named X" but a binary named X is on
 * PATH, say so in the tool result so the model re-runs it as one plain command.
 * Pure and deterministic: no shell, no network, no install attempts.
 */
const ALIASES: Record<string, string> = { pip: "pip3" };

const SCAN = 20000;
// Anything that would chain, redirect, substitute or span lines: the hint must be one plain command.
const UNSAFE_ARGS = /[;&|<>`$()\\\n\r]/;

export function moduleHint(
	command: string,
	output: string,
	which: (bin: string) => string | null,
): string | null {
	const missing = /No module named ['"]?([A-Za-z0-9_][A-Za-z0-9_.-]*)/
		.exec(output.slice(-SCAN))?.[1]
		?.split(".")[0];
	if (!missing) return null;
	// Only a bare `python -m <the missing module> ...` command: no cd prefix, no chain.
	const m = /^python[\d.]*\s+-m\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\s+(.*))?$/.exec(command.trim());
	if (!m || m[1].split(".")[0] !== missing) return null;
	const args = (m[2] ?? "").trim();
	if (UNSAFE_ARGS.test(args)) return null;
	const bin = ALIASES[missing] ?? missing;
	if (!which(bin)) return null;
	return `hint: ${missing} is not installed for this python, but \`${bin}\` is on PATH; run \`${bin}${args ? ` ${args}` : ""}\` as one command.`;
}

export function moduleHintFor(command: string, output: string): string | null {
	return moduleHint(command, output, (b) => Bun.which(b));
}
