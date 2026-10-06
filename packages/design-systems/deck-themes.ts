/**
 * Deck themes: one Marp theme CSS per design system, so a deck looks designed
 * with `theme: <name>` and no styling effort from the model (#3591).
 *
 * Generation (`bun packages/design-systems/deck-themes.ts [dbPath]`) reads the
 * design-systems DB (seeding a temp one when no path is given) and writes
 * deck-themes/<name>.css plus deck-themes/index.json. Runtime (list / apply /
 * mix) reads only those committed files, so it needs no DB.
 *
 * Brand ban: hues 270-350 are remapped before any colour reaches a theme.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hslToHex } from "./db";
import type { ParsedColors, ParsedTypography } from "./schema";

export const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), "deck-themes");

export interface DeckThemeEntry {
	name: string;
	mood: string;
	style: string;
	/** Three hex swatches: background, primary, accent. */
	swatches: [string, string, string];
	colors: Record<keyof ParsedColors, string>;
	typography: ParsedTypography;
}

// ---- colour helpers -------------------------------------------------------

/** Remap an "H S% L%" string out of the banned 270-350 hue band. */
export function remapBannedHue(hsl: string): string {
	const [h, s, l] = hsl.split(" ").map((p) => Number.parseFloat(p.replace("%", "")));
	if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(l)) return hsl;
	if (s < 8) return `0 0% ${l}%`; // near-grey: drop the tint entirely
	if (h < 262 || h > 356) return hsl; // margin so hex rounding cannot land back in the band
	const mapped = h < 309 ? 255 : 5; // nearer edge: indigo-blue or warm red
	return `${mapped} ${s}% ${l}%`;
}

function luminance(hex: string): number {
	const c = [1, 3, 5].map((i) => {
		const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Keep `fg` if it reads on `bg`, else fall back to black or white. */
function readable(fg: string, bg: string): string {
	if (contrast(fg, bg) >= 4.5) return fg;
	return contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#000000" : "#ffffff";
}

export function hexColors(c: ParsedColors): DeckThemeEntry["colors"] {
	const out = {} as DeckThemeEntry["colors"];
	for (const k of Object.keys(c) as (keyof ParsedColors)[]) out[k] = hslToHex(remapBannedHue(c[k]));
	return out;
}

// ---- CSS ------------------------------------------------------------------

/** Build Marp theme CSS from hex colours and a font pair. Pure. */
export function buildThemeCss(
	name: string,
	c: DeckThemeEntry["colors"],
	t: ParsedTypography,
): string {
	const text = readable(c.foreground, c.background);
	const title = readable(c.primary, c.background);
	const onPrimary = readable(c.primaryForeground, c.primary);
	const mutedText = readable(c.mutedForeground, c.background);
	const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
	return `/* @theme ${name} */
@import 'default';

section {
  width: 1280px;
  height: 720px;
  padding: 72px 96px;
  background: ${c.background};
  color: ${text};
  font-family: ${t.fontFamily};
  font-size: 28px;
  line-height: 1.5;
  letter-spacing: normal;
  border-left: 14px solid ${c.primary};
}
section h1, section h2, section h3, section h4 {
  font-family: ${t.headingFont};
  color: ${title};
  line-height: 1.15;
  margin: 0 0 0.5em;
}
section h1 { font-size: 60px; }
section h2 { font-size: 44px; }
section h3 { font-size: 32px; }
section h4 { font-size: 28px; }
section p, section li { margin: 0 0 0.45em; }
section strong { color: ${readable(c.accent, c.background)}; }
section a { color: ${title}; }
section ul, section ol { padding-left: 1.2em; }
section li::marker { color: ${c.primary}; }
section blockquote {
  margin: 0.8em 0;
  padding: 0.3em 1em;
  background: ${c.muted};
  color: ${readable(c.foreground, c.muted)};
  border-left: 6px solid ${c.accent};
}
section code {
  font-family: ${mono};
  background: ${c.muted};
  color: ${readable(c.foreground, c.muted)};
  padding: 0.05em 0.35em;
  border-radius: 6px;
  font-size: 0.85em;
}
section pre { background: ${c.card}; border: 1px solid ${c.border}; border-radius: 10px; padding: 0.7em 1em; }
section pre code { background: none; padding: 0; }
section table { border-collapse: collapse; font-size: 0.85em; }
section th { background: ${c.primary}; color: ${onPrimary}; padding: 0.35em 0.8em; text-align: left; }
section td { border-bottom: 1px solid ${c.border}; padding: 0.35em 0.8em; }
section img { max-height: 420px; }
section footer, section::after { color: ${mutedText}; font-size: 18px; }

/* Title slide: <!-- _class: lead --> */
section.lead {
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-left: 0;
  border-bottom: 18px solid ${c.primary};
}
section.lead h1 { font-size: 84px; margin-bottom: 0.25em; }
section.lead h2, section.lead p { font-size: 34px; color: ${mutedText}; font-weight: 400; }

/* Section break: <!-- _class: invert --> */
section.invert {
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: ${c.primary};
  color: ${onPrimary};
  border-left: 0;
}
section.invert h1, section.invert h2, section.invert h3, section.invert p { color: ${onPrimary}; }
section.invert h1 { font-size: 72px; }
`;
}

// ---- generation -----------------------------------------------------------

export function entryFor(
	name: string,
	style: string,
	mood: string,
	colors: ParsedColors,
	typography: ParsedTypography,
): DeckThemeEntry {
	const hex = hexColors(colors);
	return {
		name,
		mood,
		style,
		swatches: [hex.background, hex.primary, hex.accent],
		colors: hex,
		typography,
	};
}

/** Write one CSS file per design system in the DB plus index.json. Returns the count. */
export async function generateAll(dbPath?: string, outDir: string = THEMES_DIR): Promise<number> {
	const { initDatabase, listAll, getComplete } = await import("./query");
	if (dbPath) {
		initDatabase(dbPath);
	} else {
		const { seedDatabase } = await import("./seed");
		seedDatabase(join(tmpdir(), `deck-themes-${process.pid}.db`));
	}
	mkdirSync(outDir, { recursive: true });
	const index: DeckThemeEntry[] = [];
	for (const s of listAll().sort((a, b) => a.name.localeCompare(b.name))) {
		const full = getComplete(s.id);
		if (!full?.parsedColors || !full.parsedTypography) continue;
		const e = entryFor(s.name, s.style, s.mood, full.parsedColors, full.parsedTypography);
		writeFileSync(join(outDir, `${s.name}.css`), buildThemeCss(s.name, e.colors, e.typography));
		index.push(e);
	}
	writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
	return index.length;
}

// ---- tool operations (list / apply / mix) -----------------------------------

export function loadIndex(dir: string = THEMES_DIR): DeckThemeEntry[] {
	return JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
}

export function listThemes(dir: string = THEMES_DIR) {
	return loadIndex(dir).map(({ name, mood, swatches }) => ({ name, mood, swatches }));
}

function find(index: DeckThemeEntry[], name: string): DeckThemeEntry {
	const e = index.find((t) => t.name === name);
	if (!e) throw new Error(`Unknown deck theme "${name}". Run deck_theme list.`);
	return e;
}

/** Set `theme: <name>` in the deck's front matter, creating the block if absent. */
export function setFrontMatterTheme(md: string, name: string): string {
	const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (!m) return `---\nmarp: true\ntheme: ${name}\n---\n\n${md}`;
	let body = m[1];
	body = /^theme:.*$/m.test(body)
		? body.replace(/^theme:.*$/m, `theme: ${name}`)
		: `${body}\ntheme: ${name}`;
	if (!/^marp:/m.test(body)) body = `marp: true\n${body}`;
	return md.replace(m[0], `---\n${body}\n---${m[2]}`);
}

const SAFE_NAME = /^\w[\w.-]*$/;

/** Where a theme CSS lands for a deck. One definition, shared with the scope guard. */
export function cssPathFor(deck: string, name: string): string {
	return join(dirname(deck), `${name}.css`);
}

function inside(target: string, root: string): boolean {
	return target === root || target.startsWith(root + sep);
}

/**
 * Resolve a model-supplied deck path to a real .md file inside `root`:
 * no traversal, no symlink escape, safe filename. Throws otherwise.
 */
export function resolveDeckPath(userPath: string, root: string): string {
	const rootReal = realpathSync(resolve(root));
	const abs = resolve(rootReal, userPath);
	if (!existsSync(abs)) throw new Error(`Deck not found: ${userPath}`);
	const real = realpathSync(abs);
	if (!inside(real, rootReal)) {
		throw new Error(`Path blocked: "${userPath}" resolves outside the workspace (${rootReal}).`);
	}
	if (!real.endsWith(".md")) throw new Error(`Deck must be a .md file: ${userPath}`);
	return real;
}

/** Throws unless the deck is a .md with a safe basename. */
function assertDeck(deck: string): void {
	if (!existsSync(deck)) throw new Error(`Deck not found: ${deck}`);
	if (!deck.endsWith(".md")) throw new Error(`Deck must be a .md file: ${deck}`);
	if (!SAFE_NAME.test(basename(deck))) {
		throw new Error(
			`Deck filename "${basename(deck)}" has characters outside [A-Za-z0-9_.-]; rename it first.`,
		);
	}
}

function install(deck: string, name: string, css: string): { css: string; render: string } {
	const cssPath = cssPathFor(deck, name);
	// A symlink at the CSS destination must not carry the write elsewhere.
	if (existsSync(cssPath) && lstatSync(cssPath).isSymbolicLink()) {
		throw new Error(`Refusing to overwrite symlink ${basename(cssPath)}.`);
	}
	writeFileSync(cssPath, css);
	writeFileSync(deck, setFrontMatterTheme(readFileSync(deck, "utf8"), name));
	return {
		css: cssPath,
		render: `marp ${basename(deck)} --theme-set ${basename(cssPath)} -o ${basename(deck, ".md")}.html`,
	};
}

export function applyTheme(deck: string, name: string, dir: string = THEMES_DIR) {
	assertDeck(deck);
	find(loadIndex(dir), name);
	return { theme: name, ...install(deck, name, readFileSync(join(dir, `${name}.css`), "utf8")) };
}

/** Derived theme: colours from `palette`, fonts from `type`. */
export function mixTheme(deck: string, palette: string, type: string, dir: string = THEMES_DIR) {
	assertDeck(deck);
	const index = loadIndex(dir);
	const name = `${palette}-x-${type}`;
	const css = buildThemeCss(name, find(index, palette).colors, find(index, type).typography);
	return { theme: name, ...install(deck, name, css) };
}

if (import.meta.main) {
	generateAll(process.argv[2]).then((n) =>
		console.log(`deck-themes: wrote ${n} themes to ${THEMES_DIR}`),
	);
}
