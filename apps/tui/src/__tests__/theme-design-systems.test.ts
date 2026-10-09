/**
 * Design systems as TUI themes (#3754). Every indexed system, mapped onto the
 * TUI palette, must keep every text tone at WCAG AA (4.5:1) against light and
 * dark terminal backgrounds, never render a banned hue (270-350), and never
 * show a company name. The choice must persist in ~/.8gent/config.json.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromHex, renderedHue } from "../../../../packages/design-compose/index.js";
import index from "../../../../packages/design-systems/deck-themes/index.json" with {
	type: "json",
};
import { palettes, themeChoices } from "../theme.js";
import {
	DESIGN_SYSTEMS,
	NEUTRAL_LABEL_SOURCES,
	TEXT_ROLES,
	contrastHex,
	designSystemPalette,
	fitPaletteToBackground,
	isLightBackground,
	readDesignSystemChoice,
	saveDesignSystemChoice,
} from "../theme/design-systems.js";

// Real terminal backgrounds: the 8gent canonical pair, the extremes, popular
// themes, and mid grey (the hardest case: least headroom either way).
const BACKGROUNDS: Record<string, string> = {
	"8gent dark": "#0A0908",
	"8gent light": "#FAF7F4",
	black: "#000000",
	white: "#ffffff",
	"solarized dark": "#002b36",
	"solarized light": "#fdf6e3",
	"gruvbox dark": "#282828",
	"gruvbox light": "#fbf1c7",
	"one dark": "#282c34",
	"mid grey": "#777777",
};

const CHROMATIC_ROLES = [
	"orange",
	"orangeAlt",
	"orangeDim",
	"teal",
	"steel",
	"steelDim",
	"red",
	"green",
	"frame",
	"border",
	"cardBorder",
] as const;

function banned(hex: string): boolean {
	const h = renderedHue(fromHex(hex));
	return h !== null && h >= 270 && h <= 350;
}

describe("design system catalogue", () => {
	test("covers every entry in the design-systems index, no more, no fewer", () => {
		expect(DESIGN_SYSTEMS.length).toBe((index as unknown[]).length);
		expect(new Set(DESIGN_SYSTEMS.map((d) => d.source)).size).toBe(DESIGN_SYSTEMS.length);
	});

	test("ids and labels are unique", () => {
		expect(new Set(DESIGN_SYSTEMS.map((d) => d.id)).size).toBe(DESIGN_SYSTEMS.length);
		expect(new Set(DESIGN_SYSTEMS.map((d) => d.label)).size).toBe(DESIGN_SYSTEMS.length);
	});

	test("no company or product name is user-facing", () => {
		const marks = [...NEUTRAL_LABEL_SOURCES].flatMap((n) => [n, n.replace(/-/g, " ")]);
		for (const d of DESIGN_SYSTEMS) {
			for (const m of marks) {
				expect(d.id.toLowerCase().includes(m)).toBe(false);
				expect(d.label.toLowerCase().includes(m)).toBe(false);
			}
		}
	});
});

describe("every mapped theme passes AA on light and dark terminals", () => {
	for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
		test(`${bgName} (${bg})`, () => {
			const failures: string[] = [];
			for (const d of DESIGN_SYSTEMS) {
				const p = designSystemPalette(d.id, bg);
				if (!p) throw new Error(`no palette for ${d.id}`);
				for (const role of TEXT_ROLES) {
					const r = contrastHex(p[role], bg);
					if (r < 4.5) failures.push(`${d.id} ${role} ${p[role]} ${r.toFixed(2)}:1`);
				}
				const chip = contrastHex(p.textPrimary, p.border);
				if (chip < 4.5) failures.push(`${d.id} code chip ${chip.toFixed(2)}:1`);
				const frame = contrastHex(p.frame, bg);
				if (frame < 3) failures.push(`${d.id} frame ${frame.toFixed(2)}:1`);
				for (const role of CHROMATIC_ROLES) {
					if (banned(p[role])) failures.push(`${d.id} ${role} ${p[role]} renders in 270-350`);
				}
			}
			expect(failures).toEqual([]);
		});
	}

	test("each system on its own page background", () => {
		const failures: string[] = [];
		for (const entry of index as Array<{ name: string; colors: { background: string } }>) {
			const d = DESIGN_SYSTEMS.find((x) => x.source === entry.name);
			if (!d) throw new Error(`missing ${entry.name}`);
			const bg = entry.colors.background;
			const p = designSystemPalette(d.id, bg);
			if (!p) throw new Error(`no palette for ${d.id}`);
			for (const role of TEXT_ROLES) {
				const r = contrastHex(p[role], bg);
				if (r < 4.5) failures.push(`${d.id} ${role} ${r.toFixed(2)}:1`);
			}
		}
		expect(failures).toEqual([]);
	});

	test("the brighter tones stay brighter: primary text outranks dim text", () => {
		for (const bg of [BACKGROUNDS["8gent dark"], BACKGROUNDS["8gent light"]]) {
			for (const d of DESIGN_SYSTEMS) {
				const p = designSystemPalette(d.id, bg);
				if (!p) throw new Error(d.id);
				expect(contrastHex(p.textPrimary, bg)).toBeGreaterThanOrEqual(contrastHex(p.textDim, bg));
			}
		}
	});
});

describe("stock 8gent palette fitted to a reported background", () => {
	for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
		test(`${bgName}: every text tone at 4.5:1`, () => {
			const base = isLightBackground(bg) ? palettes.light : palettes.dark;
			const p = fitPaletteToBackground({ ...base }, bg);
			for (const role of TEXT_ROLES) expect(contrastHex(p[role], bg)).toBeGreaterThanOrEqual(4.5);
			expect(contrastHex(p.textPrimary, p.border)).toBeGreaterThanOrEqual(4.5);
		});
	}

	test("a colour that already passes is kept exactly (brand orange stays #E8610A family)", () => {
		const p = fitPaletteToBackground({ ...palettes.dark }, "#0A0908");
		expect(p.orange).toBe(palettes.dark.orange);
		expect(p.textPrimary).toBe(palettes.dark.textPrimary);
	});
});

describe("picker", () => {
	const dirs: string[] = [];
	const tempDir = () => {
		const d = mkdtempSync(join(tmpdir(), "theme-pick-"));
		dirs.push(d);
		return d;
	};
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test("lists the 8gent theme first, then every design system, each with a swatch row", () => {
		const rows = themeChoices();
		expect(rows[0]?.value).toBe("default");
		expect(rows.length).toBe(DESIGN_SYSTEMS.length + 1);
		for (const r of rows) {
			expect(r.swatches.length).toBe(4);
			for (const s of r.swatches) expect(s).toMatch(/^#[0-9a-fA-F]{6}$/);
		}
	});

	test("the choice persists in config.json and keeps the other keys", () => {
		const dir = tempDir();
		const cfg = join(dir, ".8gent", "config.json");
		expect(readDesignSystemChoice(cfg)).toBeNull();

		const pick = DESIGN_SYSTEMS[3]?.id as string;
		saveDesignSystemChoice(pick, cfg);
		expect(readDesignSystemChoice(cfg)).toBe(pick);

		const raw = JSON.parse(readFileSync(cfg, "utf-8"));
		raw.theme = "dark";
		raw.mouse = "off";
		writeFileSync(cfg, JSON.stringify(raw));
		const next = DESIGN_SYSTEMS[7]?.id as string;
		saveDesignSystemChoice(next, cfg);
		const after = JSON.parse(readFileSync(cfg, "utf-8"));
		expect(after).toEqual({ designSystem: next, theme: "dark", mouse: "off" });

		saveDesignSystemChoice(null, cfg);
		expect(readDesignSystemChoice(cfg)).toBeNull();
		expect(JSON.parse(readFileSync(cfg, "utf-8"))).toEqual({ theme: "dark", mouse: "off" });
	});

	test("an unknown id is refused, and a stale id in config reads as the 8gent theme", () => {
		const dir = tempDir();
		const cfg = join(dir, "config.json");
		expect(() => saveDesignSystemChoice("no-such-theme", cfg)).toThrow();
		writeFileSync(cfg, JSON.stringify({ designSystem: "no-such-theme" }));
		expect(readDesignSystemChoice(cfg)).toBeNull();
	});
});

describe("live re-fit of the shared palette object", () => {
	// Run in a child process: theme.ts holds process-wide state that other test
	// files read, so this must not mutate it here.
	test("a saved choice loads at start, and a reported background re-fits `t` in place", () => {
		const home = mkdtempSync(join(tmpdir(), "theme-live-"));
		try {
			const id = DESIGN_SYSTEMS[0]?.id as string;
			saveDesignSystemChoice(id, join(home, ".8gent", "config.json"));
			const themePath = join(import.meta.dir, "..", "theme.ts");
			const script = `
				const m = await import(${JSON.stringify(themePath)});
				const ref = m.t;
				const before = m.themeStatus();
				m.applyTerminalBackground("#fdf6e3");
				const after = m.themeStatus();
				console.log(JSON.stringify({ same: ref === m.t, before, after, bg: m.t.bg, mode: m.theme.mode }));
			`;
			const env = Object.fromEntries(
				Object.entries({ ...process.env, HOME: home }).filter(
					([k]) => k !== "EIGHT_THEME" && k !== "COLORFGBG",
				),
			);
			const r = Bun.spawnSync(["bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
			const out = JSON.parse(r.stdout.toString().trim().split("\n").pop() as string);
			expect(out.before).toMatchObject({ designSystem: id, mode: "dark", bgSource: "assumed" });
			expect(out.after).toMatchObject({
				designSystem: id,
				mode: "light",
				bg: "#fdf6e3",
				bgSource: "terminal",
			});
			expect(out.same).toBe(true);
			expect(out.bg).toBe("#fdf6e3");
			expect(out.mode).toBe("light");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
