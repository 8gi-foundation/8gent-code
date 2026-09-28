/**
 * Symbol-name ranking for the AST index.
 *
 * A query matches a symbol name in one of four tiers, best first:
 *   0 exact      "parse"     vs "parse"
 *   1 prefix     "parseFile" vs "parse"
 *   2 camelToken "fileParse" vs "parse"   (match starts at a camel/snake token)
 *   3 substring  "reparse"   vs "parse"
 * All tiers compare case-insensitively. Pure functions, no I/O.
 */

export type MatchTier = 0 | 1 | 2 | 3;

const TOKEN_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/** Split an identifier into camel, Pascal, snake, acronym and digit tokens. */
export function camelTokens(name: string): string[] {
	return name.match(TOKEN_RE) ?? [];
}

/** Character offsets where each token of `name` starts. */
function tokenStarts(name: string): number[] {
	const starts: number[] = [];
	for (const m of name.matchAll(TOKEN_RE)) {
		if (m.index !== undefined) starts.push(m.index);
	}
	return starts;
}

/** Tier of `query` against `name`, or null when the name does not contain it. */
export function matchTier(name: string, query: string): MatchTier | null {
	if (!query) return null;
	const n = name.toLowerCase();
	const q = query.toLowerCase();
	if (n === q) return 0;
	if (n.startsWith(q)) return 1;
	if (!n.includes(q)) return null;
	for (const start of tokenStarts(name)) {
		if (start > 0 && n.startsWith(q, start)) return 2;
	}
	return 3;
}
