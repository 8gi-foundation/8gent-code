/**
 * #70: hash-anchored edits. A range hash is the sha256 of the lines joined by
 * "\n" (no trailing newline), first 12 hex characters. read_file prints it for
 * the lines it shows; edit_file's expected_hash is checked against the lines
 * the edit would replace.
 */
import { createHash } from "node:crypto";

export function rangeHash(lines: string[]): string {
	return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}

/** Off unless EIGHT_EDIT_HASH=1: read output and tool definitions stay as pinned. */
export function editHashEnabled(): boolean {
	return process.env.EIGHT_EDIT_HASH === "1";
}

/** The footer read_file appends (empty when the flag is off), for lines first..last (1-based). */
export function hashFooter(lines: string[], first: number): string {
	if (!editHashEnabled()) return "";
	return `\n[sha256 ${rangeHash(lines)} lines ${first}-${first + lines.length - 1}]`;
}

const EXPECTED_HASH_PARAM = {
	type: "string",
	description:
		"Optional. The [sha256 ...] from read_file for exactly the lines oldText covers. If those lines changed since, the edit is refused and nothing is written.",
};

/** Adds expected_hash to the edit_file definition when the flag is on. */
export function withEditHash(defs: object[]): object[] {
	if (!editHashEnabled()) return defs;
	return defs.map((d) => {
		const def = d as { function?: { name?: string; parameters?: { properties?: object } } };
		if (def.function?.name !== "edit_file" || !def.function.parameters) return d;
		const parameters = def.function.parameters;
		return {
			...def,
			function: {
				...def.function,
				parameters: {
					...parameters,
					properties: { ...parameters.properties, expected_hash: EXPECTED_HASH_PARAM },
				},
			},
		};
	});
}

/**
 * Refusal text when `expectedHash` does not match the whole lines that
 * content[idx, idx+length) touches, else null. Nothing is written by the caller
 * on a refusal.
 */
export function staleHashRefusal(
	content: string,
	idx: number,
	length: number,
	expectedHash: string,
): string | null {
	const first = content.slice(0, idx).split("\n").length;
	const last = first + content.slice(idx, idx + length).replace(/\n$/, "").split("\n").length - 1;
	const lines = content.split("\n").slice(first - 1, last);
	if (rangeHash(lines) === expectedHash.trim().toLowerCase()) return null;
	return `Error: file changed since read, re-read lines ${first}-${last}. expected_hash ${expectedHash} no longer matches those lines. Nothing was written.`;
}
