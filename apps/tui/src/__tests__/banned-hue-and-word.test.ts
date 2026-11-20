/**
 * Brand guards for the TUI (BRAND.md): no colour in hue 270-350, and the word
 * "agent" never appears in text a person sees.
 *
 * Scope is the theme file plus the components changed for issue #161, and the
 * /agent command's visible strings. The command name itself is a separate
 * decision, so the literal "/agent" token is removed before the word check.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const BANNED_NAMES = /\b(magenta|magentaBright|purple|violet|pink)\b/i;

/** Drop block and line comments so prose about the ban is not a violation. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function hueOf(hex: string): number | null {
	const h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
	const n = Number.parseInt(h, 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d === 0) return null; // greys carry no hue
	const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return Math.round(((sector * 60) % 360 + 360) % 360);
}

function bannedHexes(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
		const hue = hueOf(m[1]);
		if (hue !== null && hue >= 270 && hue <= 350) out.push(`${m[0]} (hue ${hue})`);
	}
	return out;
}

const SCANNED = [
	"theme.ts",
	"components/message-list.tsx",
	"components/MessageViewer.tsx",
	"components/ThinkingView.tsx",
	"components/ActivityMonitor.tsx",
];

describe("banned hues 270-350 (theme and changed components)", () => {
	for (const file of SCANNED) {
		test(`${file} has no banned colour name`, () => {
			expect(stripComments(read(file)).match(BANNED_NAMES)?.[0] ?? null).toBeNull();
		});
		test(`${file} has no hex in hue 270-350`, () => {
			expect(bannedHexes(stripComments(read(file)))).toEqual([]);
		});
	}

	test("the hue check itself flags a known magenta and passes the brand orange", () => {
		expect(bannedHexes("#C026D3")).toHaveLength(1);
		expect(bannedHexes("#E8610A")).toEqual([]);
	});
});

describe("/agent command visible text", () => {
	const app = read("app.tsx");
	const start = app.indexOf('case "agent": {');
	const end = app.indexOf('case "animations":', start);

	test("the command block was found", () => {
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
	});

	test("no visible string contains the word agent (command name excluded)", () => {
		// Skip the `case "agent"` label itself: it is a dispatch key, not shown text.
		const block = app.slice(start + 'case "agent": {'.length, end);
		const literals = [...block.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map(
			(m) => m[1] ?? m[2],
		);
		// Remove ${...} interpolations (code, not shown text) and the /agent command
		// token itself, which is a separate decision.
		const visible = literals.map((s) =>
			s.replace(/\$\{[^}]*\}/g, "").replace(/\/agent\b/g, "/<command>"),
		);
		const offenders = visible.filter((s) => /agent/i.test(s.replace(/8gent/gi, "")));
		expect(offenders).toEqual([]);
	});
});
