/**
 * User themes: ~/.8gent/themes/<name>.json (Pi parity N1, #3918).
 *
 * A file is a partial palette over the stock dark or light palette:
 *
 *   { "base": "dark", "label": "Ember", "description": "optional",
 *     "orange": "#FF8800", "bg": "#101010" }
 *
 * `base` is required and must be "dark" or "light". `label` and `description`
 * are optional text. Every other key must be a palette key (the keys of the
 * stock palettes) with a #rgb or #rrggbb value. Colours are the user's own and
 * are used exactly as written: the banned-hue rule in BRAND.md is for colours
 * we author, so it is not applied here.
 *
 * A file that fails any check is skipped whole, with a readable reason. Nothing
 * here throws on bad input; a missing folder is "no user themes".
 *
 * This module has no dependency on theme.ts (theme.ts imports it), so the set
 * of valid keys is passed in by the caller.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../../../../packages/core/home.js";
import { contrastHex } from "../theme/design-systems.js";

/**
 * Strip anything that can drive a terminal or reorder text from a string that
 * came from a theme file: ESC sequences (CSI, OSC, others), C0 except tab, DEL,
 * C1, bidi controls and the line/paragraph separators.
 */
export function sanitizeThemeText(s: string): string {
	return String(s)
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "") // OSC
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, "") // CSI
		.replace(/\u001b[\s\S]?/g, "") // other ESC
		.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, "");
}

/** Palette keys that must stay legible, with their WCAG minimum against bg. */
const TEXT_KEYS = ["textPrimary", "textSecondary", "cream", "prose"] as const;
const ALERT_KEYS = ["red", "orange"] as const; // danger/error, and the warning/permission accent

export type UserThemeBase = "dark" | "light";

export interface UserTheme {
	/** File name without .json. The picker value is `user:<name>`. */
	name: string;
	base: UserThemeBase;
	label: string;
	description: string;
	/** Only the keys the file set, hex normalised to #RRGGBB. */
	overrides: Record<string, string>;
}

export interface SkippedUserTheme {
	file: string;
	reason: string;
}

export interface UserThemeLoad {
	themes: UserTheme[];
	skipped: SkippedUserTheme[];
}

export const USER_THEME_PREFIX = "user:";
const RESERVED = new Set(["base", "label", "description"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isUserThemeId(id: string | null | undefined): id is string {
	return typeof id === "string" && id.startsWith(USER_THEME_PREFIX);
}

export function userThemeName(id: string): string {
	return id.slice(USER_THEME_PREFIX.length);
}

export function userThemesDir(home: string = resolveHome()): string {
	return join(home, ".8gent", "themes");
}

function normaliseHex(v: string): string {
	const h = v.slice(1).toUpperCase();
	return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}

/** Validate one parsed theme file. `paletteKeys` are the valid colour keys. */
export function parseUserTheme(
	name: string,
	raw: unknown,
	paletteKeys: readonly string[],
	bases?: Record<UserThemeBase, Record<string, string>>,
): { ok: true; theme: UserTheme } | { ok: false; reason: string } {
	const fail = (reason: string) => ({ ok: false as const, reason });
	if (!NAME_RE.test(name)) {
		return fail(`file name "${sanitizeThemeText(name)}" must be letters, digits, - or _ (max 64) before .json`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return fail("the file must contain a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.base !== "dark" && obj.base !== "light") {
		return fail('"base" is required and must be "dark" or "light"');
	}
	let label = name;
	let description = `User theme over ${obj.base}`;
	for (const k of ["label", "description"] as const) {
		const v = obj[k];
		if (v === undefined) continue;
		if (typeof v !== "string" || !v.trim() || v.length > 80) {
			return fail(`"${k}" must be a non-empty string of at most 80 characters`);
		}
		const clean = sanitizeThemeText(v).trim();
		if (!clean) return fail(`"${k}" is empty after removing control characters`);
		if (k === "label") label = clean;
		else description = clean;
	}
	const valid = new Set(paletteKeys);
	const overrides: Record<string, string> = {};
	const problems: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (RESERVED.has(k)) continue;
		if (!valid.has(k)) {
			problems.push(`unknown key "${sanitizeThemeText(k)}"`);
		} else if (typeof v !== "string" || !HEX_RE.test(v)) {
			problems.push(`"${sanitizeThemeText(k)}" is not a hex colour like #RRGGBB or #RGB (got ${sanitizeThemeText(JSON.stringify(v))})`);
		} else {
			overrides[k] = normaliseHex(v);
		}
	}
	if (problems.length) return fail(problems.join("; "));
	if (Object.keys(overrides).length === 0) return fail("sets no colours");
	if (bases) {
		const merged = { ...bases[obj.base], ...overrides };
		const bg = merged.bg;
		const low: string[] = [];
		if (bg) {
			for (const k of TEXT_KEYS) {
				if (k in overrides || "bg" in overrides) {
					const c = merged[k];
					if (c && contrastHex(c, bg) < 4.5) low.push(`"${k}" is ${contrastHex(c, bg).toFixed(1)}:1 on bg, needs 4.5:1`);
				}
			}
			for (const k of ALERT_KEYS) {
				if (k in overrides || "bg" in overrides) {
					const c = merged[k];
					if (c && contrastHex(c, bg) < 3) low.push(`"${k}" is ${contrastHex(c, bg).toFixed(1)}:1 on bg, needs 3:1`);
				}
			}
		}
		if (low.length) return fail(`unreadable: ${low.join("; ")}`);
	}
	return { ok: true, theme: { name, base: obj.base, label, description, overrides } };
}

/** Read every <name>.json in the themes folder. Never throws. */
export function loadUserThemes(
	paletteKeys: readonly string[],
	dir: string = userThemesDir(),
	bases?: Record<UserThemeBase, Record<string, string>>,
): UserThemeLoad {
	const out: UserThemeLoad = { themes: [], skipped: [] };
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.toLowerCase().endsWith(".json"))
			.sort();
	} catch {
		return out; // no folder, or unreadable: built-ins only
	}
	for (const file of files) {
		const name = file.slice(0, -".json".length);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
		} catch (err) {
			out.skipped.push({ file: sanitizeThemeText(file), reason: sanitizeThemeText(`not valid JSON (${(err as Error).message})`) });
			continue;
		}
		const r = parseUserTheme(name, raw, paletteKeys, bases);
		if (r.ok) out.themes.push(r.theme);
		else out.skipped.push({ file: sanitizeThemeText(file), reason: sanitizeThemeText(r.reason) });
	}
	return out;
}
