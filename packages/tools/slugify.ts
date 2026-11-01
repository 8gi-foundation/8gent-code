/**
 * Convert any string into a URL- and filename-safe slug.
 *
 * Pipeline:
 * 1. NFKD-decompose and strip combining marks, so accented letters keep
 *    their base letter ("Crème Brûlée" -> "creme brulee") with no
 *    transliteration tables.
 * 2. Lowercase and trim.
 * 3. Replace every run of non-alphanumeric characters with a single
 *    separator, then collapse repeated separators and strip leading and
 *    trailing ones.
 *
 * For pure-ASCII input with the default separator this is byte-identical
 * to the legacy `packages/memory/wiki.ts` slugify, which existing wiki
 * filenames and links depend on (see the parity fixtures in
 * `__tests__/fixtures/wiki-slug-parity.json`). The only behavior change is
 * that decomposable non-ASCII letters are now kept as their base letter
 * instead of being dropped.
 *
 * @param input     Arbitrary string to slugify.
 * @param separator Separator inserted between words (default: "-").
 */
export function slugify(input: string, separator = "-"): string {
	const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return input
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, separator)
		.replace(new RegExp(`(?:${escaped}){2,}`, "g"), separator)
		.replace(new RegExp(`^(?:${escaped})+|(?:${escaped})+$`, "g"), "");
}
