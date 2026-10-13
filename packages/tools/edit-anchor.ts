/**
 * Anchored edits (#3472), behind EIGHT_EDIT_FORMAT=hashline, off by default.
 *
 * Pilot runs refused edit_file about one call in three because the model could
 * not echo oldText byte for byte (interior whitespace, template strings). With
 * the flag, read_file tags each row with a short hash of that line's bytes
 * (`    12#k7q3\t...`), and edit_file can name the line by that anchor instead
 * of copying it. The hash is checked against the file now, so an edit made
 * from a stale read is refused, never applied to the wrong line.
 *
 * Shared by both tool catalogs (packages/eight/tools.ts, packages/ai/tools.ts).
 */

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const ANCHOR = /(\d+)#([a-z2-7]{4})/g;
/** A hashline gutter row: right-aligned number, `#`, 4-char hash, tab. */
const HASH_GUTTER = /^ *\d+#[a-z2-7]{4}\t/;
/** Rows of fresh anchors returned after an edit; past this the model re-reads. */
const MAX_ECHO_ROWS = 20;

export const HASHLINE_READ_DESC =
	"[FILE] Pass path; returns the file one row per line as `N#hash<tab>text`, where N#hash is that line's anchor for edit_file. The anchor and tab are not file text. Use offset and limit to read part of a file; the numbers stay the file's real line numbers.";
export const HASHLINE_EDIT_DESC =
	"[FILE] Replaces the lines at anchor (N#hash from read_file; a block lists each, comma-separated) in file path with newText in place. Or pass oldText instead of anchor. A stale anchor (the line changed since read_file) is refused and nothing is written. Empty newText deletes the lines.";
export const ANCHOR_PARAM_DESC =
	"Anchor of the line to replace, e.g. 12#k7q3; for a block, every line's anchor in order, comma-separated (12#k7q3,13#ab2c)";
export const ANCHORED_NEWTEXT_DESC =
	"Replacement for the anchored lines (or for oldText), in place, without the N#hash prefix";
export const OPTIONAL_OLDTEXT_DESC =
	"Use instead of anchor: the exact existing text being changed, a whole line or block";

/** True only when EIGHT_EDIT_FORMAT is exactly "hashline". */
export function hashlineEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_EDIT_FORMAT === "hashline";
}

/** 4-char base32 of FNV-1a over the line's UTF-8 bytes (20 bits). */
export function lineHash(line: string): string {
	let h = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(line)) {
		h ^= byte;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	let out = "";
	for (let i = 0; i < 4; i++) out += BASE32[(h >>> (i * 5)) & 31];
	return out;
}

/** Rows as numberLines prints them, with `#hash` after the number. */
export function hashLines(lines: string[], first: number): string {
	return lines
		.map((line, i) => `${String(first + i).padStart(6)}#${lineHash(line)}\t${line}`)
		.join("\n");
}

/** True when every non-empty line of `text` starts with a hashline gutter. */
export function hasHashGutter(text: string): boolean {
	const rows = text.split("\n").filter((l) => l.trim() !== "");
	return rows.length > 0 && rows.every((l) => HASH_GUTTER.test(l));
}

export type AnchoredEdit =
	| { ok: true; content: string; first: number; removed: number; added: string[] }
	| { ok: false; error: string };

/**
 * Replace the anchored lines of `content` with `newText`. Anchors must name a
 * contiguous ascending run of lines, and each hash must match the line as it
 * is now. One trailing newline on newText is dropped (it ends the block, it
 * does not add a line). CRLF lines keep their `\r`.
 */
export function applyAnchoredEdit(
	content: string,
	anchor: unknown,
	newText: string,
	filePath: string,
): AnchoredEdit {
	const raw = Array.isArray(anchor) ? anchor.join(",") : String(anchor ?? "");
	const anchors = [...raw.matchAll(ANCHOR)].map((m) => ({ line: Number(m[1]), hash: m[2] }));
	if (anchors.length === 0) {
		return {
			ok: false,
			error: `Error: anchor "${raw.slice(0, 60)}" has no N#hash anchor. Nothing was written to ${filePath}: copy the anchor from read_file, e.g. 12#k7q3.`,
		};
	}
	if (hasHashGutter(newText)) {
		return {
			ok: false,
			error: `Error: newText starts each line with a read_file N#hash prefix. That prefix would be written into ${filePath} as file text. Nothing was written: send newText without the prefix.`,
		};
	}
	const lines = content.split("\n");
	const trailing = lines.length > 1 && lines[lines.length - 1] === "";
	const count = trailing ? lines.length - 1 : lines.length;
	for (let i = 0; i < anchors.length; i++) {
		const { line, hash } = anchors[i];
		if (i > 0 && line !== anchors[i - 1].line + 1) {
			return {
				ok: false,
				error: `Error: anchors must be consecutive lines; line ${line} follows line ${anchors[i - 1].line}. Nothing was written to ${filePath}: list every line of the block in order.`,
			};
		}
		if (line < 1 || line > count) {
			return {
				ok: false,
				error: `Error: line ${line} is past the end of ${filePath} (${count} lines). Nothing was written: read_file again and use the new anchors.`,
			};
		}
		const now = lineHash(lines[line - 1]);
		if (now !== hash) {
			return {
				ok: false,
				error: `Error: line ${line} of ${filePath} changed since read_file (anchor ${line}#${hash}, now ${line}#${now}). Nothing was written: read_file those lines again and use the new anchors.`,
			};
		}
	}
	const first = anchors[0].line;
	const removed = anchors.length;
	const crlf = lines.slice(first - 1, first - 1 + removed).every((l) => l.endsWith("\r"));
	const body = newText.endsWith("\n") ? newText.slice(0, -1) : newText;
	const added = newText === "" ? [] : body.split("\n").map((l) => (crlf ? `${l}\r` : l));
	lines.splice(first - 1, removed, ...added);
	return { ok: true, content: lines.join("\n"), first, removed, added };
}

/** The success line, with the edited lines' fresh anchors so the next edit needs no re-read. */
export function anchoredEditMessage(
	absolutePath: string,
	edit: AnchoredEdit & { ok: true },
): string {
	const { first, removed, added } = edit;
	const head = `File edited: ${absolutePath}\nReplaced lines ${first}-${first + removed - 1} (${removed}) with ${added.length} line(s).`;
	const shift = added.length - removed;
	const after =
		shift === 0
			? ""
			: `\nLines after ${first + removed - 1} moved by ${shift > 0 ? "+" : ""}${shift}: add ${shift} to their anchor numbers (the hashes stay).`;
	const rows =
		added.length > 0 && added.length <= MAX_ECHO_ROWS
			? `\nNew anchors:\n${hashLines(added, first)}`
			: "";
	return `${head}${after}${rows}`;
}
