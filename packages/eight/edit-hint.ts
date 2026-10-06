/**
 * edit_file near-match hint (#3605). Never applies an edit: it only tells the
 * model what the file currently contains so it can retry with exact text.
 */

export interface ClosestRegion {
	startLine: number; // 1-based
	endLine: number;
	text: string; // exact current text, verbatim
	kind: "whitespace" | "fuzzy";
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function lineSim(a: string, b: string): number {
	const x = new Set(norm(a).split(/[^\w]+/).filter(Boolean));
	const y = new Set(norm(b).split(/[^\w]+/).filter(Boolean));
	if (x.size === 0 || y.size === 0) return 0;
	let hit = 0;
	for (const t of x) if (y.has(t)) hit++;
	return hit / Math.max(x.size, y.size);
}

export function findClosestRegion(content: string, oldText: string): ClosestRegion | null {
	const lines = content.split("\n");
	const want = oldText.split("\n");
	while (want.length > 1 && want[want.length - 1].trim() === "") want.pop();
	const n = want.length;
	if (n === 0 || norm(oldText) === "" || lines.length === 0) return null;
	const win = Math.min(n, lines.length);

	// 1. whitespace-normalised match
	const target = want.map(norm).join("\n");
	for (let i = 0; i + win <= lines.length; i++) {
		if (lines.slice(i, i + win).map(norm).join("\n") === target) {
			return { startLine: i + 1, endLine: i + win, text: lines.slice(i, i + win).join("\n"), kind: "whitespace" };
		}
	}

	// 2. best fuzzy window by mean per-line token overlap
	let best = 0;
	let bestAt = -1;
	for (let i = 0; i + win <= lines.length; i++) {
		let sum = 0;
		for (let j = 0; j < win; j++) sum += lineSim(want[j], lines[i + j]);
		const score = sum / win;
		if (score > best) {
			best = score;
			bestAt = i;
		}
	}
	if (bestAt < 0 || best < 0.5) return null;
	return { startLine: bestAt + 1, endLine: bestAt + win, text: lines.slice(bestAt, bestAt + win).join("\n"), kind: "fuzzy" };
}

export function formatEditNotFound(filePath: string, content: string, oldText: string): string {
	const base = `Error: Could not find the text to replace in ${filePath}. Make sure oldText matches exactly.`;
	const r = findClosestRegion(content, oldText);
	if (!r) return base;
	const MAX_LINES = 40;
	const MAX_BYTES = 4096;
	let shown = r.text.split("\n").slice(0, MAX_LINES);
	let truncated = r.text.split("\n").length > MAX_LINES;
	let body = shown.join("\n");
	if (body.length > MAX_BYTES) {
		body = body.slice(0, MAX_BYTES);
		truncated = true;
	}
	if (truncated) body += "\n(truncated)";
	const first = r.startLine;
	const how =
		r.kind === "whitespace"
			? `Lines ${first}-${r.endLine} differ only in whitespace.`
			: `Lines ${first}-${r.endLine} are the closest match; verify it is what you meant.`;
	const retry =
		r.kind === "whitespace"
			? "Retry edit_file with this exact text; do not rewrite the file."
			: "Verify it is what you meant, then retry edit_file with the exact text; do not rewrite the file.";
	// Small windows: numbered view only (line numbers cited, never copied into oldText).
	// The exact text follows once; large windows get a single copy.
	if (!truncated && shown.length <= 12) {
		const numbered = shown.map((l, i) => `${first + i}: ${l}`).join("\n");
		return `${base}\n${how} Current text with line numbers:\n${numbered}\n\nExact text to use:\n${body}\n\n${retry}`;
	}
	return `${base}\n${how} Exact current text (starts at line ${first}):\n${body}\n\n${retry}`;
}
