/**
 * Subcommand matching for `8gent <word>`. Phone keyboards capitalise the first
 * word after Enter ("Keys set minimax"), so the word is lowercased before it is
 * matched; later arguments keep their case. A near miss gets a suggestion.
 */

export const KNOWN_SUBCOMMANDS = [
	"init",
	"outline",
	"symbol",
	"search",
	"benchmark",
	"demo",
	"tui",
	"run",
	"pipeline",
	"pet",
	"infinite",
	"chat",
	"agent",
	"session",
	"export",
	"preferences",
	"memory",
	"airdrop",
	"drop",
	"onboard",
	"status",
	"auth",
	"cron",
	"blueprint",
	"selfimprove",
	"scout",
	"daemon",
	"rpc",
	"mcp-server",
	"review",
	"doctor",
	"model-pin",
	"deck",
	"bug",
	"update",
	"upgrade",
	"permissions",
	"perms",
	"keys",
	"env",
	"install",
	"packages",
	"publish",
] as const;

/** The subcommand word as typed, matched without regard to case. */
export function normalizeSubcommand(word: string | undefined): string | undefined {
	return word === undefined ? undefined : word.toLowerCase();
}

/** Levenshtein distance, early-out above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length];
}

/** The closest known subcommand within edit distance 2, or null. */
export function suggestSubcommand(word: string): string | null {
	const w = word.toLowerCase();
	let best: string | null = null;
	let bestD = 3;
	for (const name of KNOWN_SUBCOMMANDS) {
		const d = editDistance(w, name);
		if (d < bestD) {
			best = name;
			bestD = d;
		}
	}
	return best;
}

/** The lines printed for an unknown subcommand. */
export function unknownSubcommandLines(word: string): string[] {
	const lines = [`Unknown command: ${word}`];
	const near = suggestSubcommand(word);
	if (near) lines.push(`Did you mean: 8gent ${near}?`);
	lines.push("Run '8 --help' for usage information.");
	return lines;
}
