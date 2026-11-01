import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { palettes } from "../theme.js";
import { isUserThemeId, loadUserThemes, parseUserTheme, userThemesDir } from "./user-themes.js";

const KEYS = Object.keys(palettes.dark);
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function themesDir(files: Record<string, string>): string {
	const home = mkdtempSync(join(tmpdir(), "user-themes-"));
	dirs.push(home);
	const dir = userThemesDir(home);
	mkdirSync(dir, { recursive: true });
	for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
	return dir;
}

describe("parseUserTheme", () => {
	test("accepts a partial palette and normalises hex", () => {
		const r = parseUserTheme("ember", { base: "dark", orange: "#f80", bg: "#101010" }, KEYS);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.theme.overrides).toEqual({ orange: "#FF8800", bg: "#101010" });
			expect(r.theme.label).toBe("ember");
			expect(r.theme.base).toBe("dark");
		}
	});

	test("label and description are used when given", () => {
		const r = parseUserTheme("a", { base: "light", label: "Paper", description: "calm", bg: "#fff" }, KEYS);
		expect(r.ok && r.theme.label).toBe("Paper");
		expect(r.ok && r.theme.description).toBe("calm");
	});

	test("rejects unknown keys with the key named", () => {
		const r = parseUserTheme("x", { base: "dark", orangee: "#fff000" }, KEYS);
		expect(r).toEqual({ ok: false, reason: 'unknown key "orangee"' });
	});

	test("rejects bad colours with the key and value named", () => {
		for (const bad of ["red", "#12", "#12345g", "rgb(1,2,3)", 5, null]) {
			const r = parseUserTheme("x", { base: "dark", orange: bad }, KEYS);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain('"orange" is not a hex colour');
		}
	});

	test("reports every problem at once", () => {
		const r = parseUserTheme("x", { base: "dark", nope: "#fff", orange: "blue" }, KEYS);
		expect(!r.ok && r.reason).toContain('unknown key "nope"');
		expect(!r.ok && r.reason).toContain('"orange"');
	});

	test("requires base dark or light", () => {
		for (const b of [undefined, "blue", 1]) {
			const r = parseUserTheme("x", { base: b, orange: "#fff" }, KEYS);
			expect(!r.ok && r.reason).toContain('"base"');
		}
	});

	test("rejects non-objects, empty themes and unsafe names", () => {
		expect(parseUserTheme("x", [], KEYS).ok).toBe(false);
		expect(parseUserTheme("x", "dark", KEYS).ok).toBe(false);
		expect(parseUserTheme("x", null, KEYS).ok).toBe(false);
		const none = parseUserTheme("x", { base: "dark" }, KEYS);
		expect(!none.ok && none.reason).toBe("sets no colours");
		expect(parseUserTheme("../evil", { base: "dark", bg: "#000" }, KEYS).ok).toBe(false);
		expect(parseUserTheme("a b", { base: "dark", bg: "#000" }, KEYS).ok).toBe(false);
	});

	test("does not apply the banned-hue rule: the colours are the user's own", () => {
		const r = parseUserTheme("violet", { base: "dark", orange: "#8A2BE2" }, KEYS);
		expect(r.ok).toBe(true);
	});
});

describe("loadUserThemes", () => {
	test("missing folder means no themes and no problems", () => {
		const r = loadUserThemes(KEYS, join(tmpdir(), "does-not-exist-user-themes"));
		expect(r).toEqual({ themes: [], skipped: [] });
	});

	test("loads valid files, skips bad ones with reasons, ignores other files", () => {
		const dir = themesDir({
			"good.json": JSON.stringify({ base: "dark", orange: "#FF8800" }),
			"broken.json": "{ not json",
			"typo.json": JSON.stringify({ base: "dark", orang: "#FF8800" }),
			"notes.txt": "ignored",
		});
		const r = loadUserThemes(KEYS, dir);
		expect(r.themes.map((t) => t.name)).toEqual(["good"]);
		expect(r.skipped.map((s) => s.file)).toEqual(["broken.json", "typo.json"]);
		expect(r.skipped[0]?.reason).toContain("not valid JSON");
		expect(r.skipped[1]?.reason).toContain('unknown key "orang"');
	});

	test("isUserThemeId", () => {
		expect(isUserThemeId("user:ember")).toBe(true);
		expect(isUserThemeId("bold-tech")).toBe(false);
		expect(isUserThemeId(null)).toBe(false);
	});
});
