/**
 * When a python command fails with "No module named X" but a binary named X is on
 * PATH, say so in the tool result so the model re-runs it as one plain command.
 * Pure and deterministic: no shell, no network, no install attempts.
 */
const ALIASES: Record<string, string> = { pip: "pip3" };

export function moduleHint(
	command: string,
	output: string,
	which: (bin: string) => string | null,
): string | null {
	const missing = /No module named ['"]?([A-Za-z0-9_.-]+)/.exec(output)?.[1]?.split(".")[0];
	if (!missing) return null;
	const bin = ALIASES[missing] ?? missing;
	if (!which(bin)) return null;
	const m = /\bpython[\d.]*\s+-m\s+\S+\s*(.*)$/.exec(command.trim());
	const args = (m ? m[1] : "").trim();
	return `hint: ${missing} is not installed for this python, but \`${bin}\` is on PATH; run \`${bin}${args ? ` ${args}` : ""}\` as one command.`;
}

export function moduleHintFor(command: string, output: string): string | null {
	return moduleHint(command, output, (b) => Bun.which(b));
}
