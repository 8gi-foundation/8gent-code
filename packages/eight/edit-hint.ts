/**
 * edit_file near-match hint (#3605). Never applies an edit: it only tells the
 * model what the file currently contains so it can retry with exact text.
 *
 * Bounded work: only the first MAX_WANT lines of oldText are matched, file
 * lines are normalised/tokenised once, and the fuzzy pass is skipped when
 * lines x wantLines exceeds MAX_COMPARISONS (falls back to the plain message).
 */
import { scrub as scrubSecrets } from "./secret-scanner";

export interface ClosestRegion {
	startLine: number; // 1-based
	endLine: number;
	text: string; // exact current text, verbatim
	kind: "whitespace" | "fuzzy";
}

const MAX_WANT = 40;
const MAX_COMPARISONS = 200_000;
const MAX_LINES = 40;
const MAX_BYTES = 4096;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const tokens = (s: string) => new Set(norm(s).split(/[^\w]+/).filter(Boolean));

function setSim(x: Set<string>, y: Set<string>): number {
	if (x.size === 0 || y.size === 0) return 0;
	let hit = 0;
	for (const t of x) if (y.has(t)) hit++;
	return hit / Math.max(x.size, y.size);
}

export function findClosestRegion(content: string, oldText: string): ClosestRegion | null {
	const lines = content.split("\n");
	const want = oldText.split("\n");
	while (want.length > 1 && want[want.length - 1].trim() === "") want.pop();
	if (want.length > MAX_WANT) want.length = MAX_WANT;
	const n = want.length;
	if (n === 0 || norm(oldText) === "" || lines.length === 0) return null;
	const win = Math.min(n, lines.length);

	// 1. whitespace-normalised match (file normalised once, O(lines))
	const wantNorm = want.map(norm);
	const fileNorm = lines.map(norm);
	for (let i = 0; i + win <= lines.length; i++) {
		if (fileNorm[i] !== wantNorm[0]) continue;
		let ok = true;
		for (let j = 1; j < win; j++) {
			if (fileNorm[i + j] !== wantNorm[j]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			return { startLine: i + 1, endLine: i + win, text: lines.slice(i, i + win).join("\n"), kind: "whitespace" };
		}
	}

	// 2. best fuzzy window by mean per-line token overlap, within a work budget
	if (lines.length * win > MAX_COMPARISONS) return null;
	const wantTok = want.map(tokens);
	const fileTok = lines.map(tokens);
	let best = 0;
	let bestAt = -1;
	for (let i = 0; i + win <= lines.length; i++) {
		let sum = 0;
		for (let j = 0; j < win; j++) sum += setSim(wantTok[j], fileTok[i + j]);
		const score = sum / win;
		if (score > best) {
			best = score;
			bestAt = i;
		}
	}
	if (bestAt < 0 || best < 0.5) return null;
	return { startLine: bestAt + 1, endLine: bestAt + win, text: lines.slice(bestAt, bestAt + win).join("\n"), kind: "fuzzy" };
}

/** Cut to at most `max` UTF-8 bytes on a code point boundary (never mid-surrogate). */
function cutBytes(s: string, max: number): { text: string; cut: boolean } {
	if (Buffer.byteLength(s) <= max) return { text: s, cut: false };
	let bytes = 0;
	let out = "";
	for (const ch of s) {
		const b = Buffer.byteLength(ch);
		if (bytes + b > max) break;
		bytes += b;
		out += ch;
	}
	return { text: out, cut: true };
}

export function formatEditNotFound(filePath: string, content: string, oldText: string): string {
	const base = `Error: Could not find the text to replace in ${filePath}. Make sure oldText matches exactly.`;
	const r = findClosestRegion(content, oldText);
	if (!r) return base;
	const all = r.text.split("\n");
	const shown = all.slice(0, MAX_LINES);
	const byLines = all.length > MAX_LINES;
	const capped = cutBytes(shown.join("\n"), MAX_BYTES);
	const truncated = byLines || capped.cut;
	const body = scrubSecrets(capped.text).scrubbed + (truncated ? "\n(truncated)" : "");
	const first = r.startLine;
	const how =
		r.kind === "whitespace"
			? `Lines ${first}-${r.endLine} differ only in whitespace.`
			: `Lines ${first}-${r.endLine} are the closest match; verify it is what you meant.`;
	const retry =
		r.kind === "whitespace"
			? "Retry edit_file with this exact text; do not rewrite the file."
			: "Verify it is what you meant, then retry edit_file with the exact text; do not rewrite the file.";
	if (!truncated && shown.length <= 12) {
		const numbered = body.split("\n").map((l, i) => `${first + i}: ${l}`).join("\n");
		return `${base}\n${how} Current text with line numbers:\n${numbered}\n\nExact text to use:\n${body}\n\n${retry}`;
	}
	return `${base}\n${how} Exact current text (starts at line ${first}):\n${body}\n\n${retry}`;
}
