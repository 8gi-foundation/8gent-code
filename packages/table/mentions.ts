/**
 * @mention scanning (contract section 3.8).
 *
 * Pure text -> handle extraction. Resolution to actual agent members lives in
 * wiring.ts (it needs the store). Kept dependency-free and deterministic so it
 * is trivially unit-testable and safe to run on UNTRUSTED channel text - it
 * never evaluates or interpolates the input anywhere.
 */

/**
 * Extract @handle tokens from message content.
 *
 * A handle is `@` followed by one or more of [A-Za-z0-9_-]. Duplicates are
 * removed preserving first-seen order. The leading `@` is stripped. Case is
 * preserved (handles like "8EO" are case-sensitive downstream).
 */
export function scanMentions(content: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const match of content.matchAll(/@([A-Za-z0-9_-]+)/g)) {
		const handle = match[1];
		if (!seen.has(handle)) {
			seen.add(handle);
			out.push(handle);
		}
	}
	return out;
}
