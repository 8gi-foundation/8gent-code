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
	const numbered = r.text
		.split("\n")
		.map((l, i) => `${r.startLine + i}: ${l}`)
		.join("\n");
	const how = r.kind === "whitespace" ? "differs only in whitespace" : "is the closest match";
	return `${base}\nLines ${r.startLine}-${r.endLine} ${how}. Current text:\n${numbered}\n\nExact text to use:\n${r.text}\n\nRetry edit_file with this exact text; do not rewrite the file.`;
}
