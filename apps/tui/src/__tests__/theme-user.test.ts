/** User themes through theme.ts: choices, apply, persist, reload (Pi parity N1). */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyDesignSystem,
	palettes,
	reloadUserThemes,
	saveThemeChoice,
	t,
	themeChoices,
	themeStatus,
	userThemeProblems,
} from "../theme.js";

const home = mkdtempSync(join(tmpdir(), "theme-user-"));
const themes = join(home, ".8gent", "themes");
const cfg = join(home, ".8gent", "config.json");
const prevHome = process.env.EIGHT_HOME;
process.env.EIGHT_HOME = home;
afterAll(() => {
	applyDesignSystem(null);
	if (prevHome === undefined) delete process.env.EIGHT_HOME;
	else process.env.EIGHT_HOME = prevHome;
	reloadUserThemes();
	rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
	rmSync(join(home, ".8gent"), { recursive: true, force: true });
	mkdirSync(themes, { recursive: true });
	applyDesignSystem(null);
});
const put = (name: string, body: unknown) =>
	writeFileSync(join(themes, name), typeof body === "string" ? body : JSON.stringify(body));

describe("user themes in theme.ts", () => {
	test("no themes folder: built-ins only", () => {
		rmSync(themes, { recursive: true });
		reloadUserThemes();
		expect(themeChoices().some((r) => r.value.startsWith("user:"))).toBe(false);
		expect(userThemeProblems()).toEqual([]);
	});

	test("a valid theme appears in themeChoices after the built-ins, with real swatches", () => {
		put("ember.json", { base: "dark", label: "Ember", orange: "#ff8800" });
		reloadUserThemes();
		const rows = themeChoices();
		const row = rows[rows.length - 1];
		expect(row?.value).toBe("user:ember");
		expect(row?.label).toBe("Ember");
		expect(row?.swatches[0]).toBe("#FF8800");
		expect(rows[0]?.value).toBe("default");
	});

	test("applying merges over the base palette in place", () => {
		put("ember.json", { base: "dark", orange: "#ff8800" });
		put("paper.json", { base: "light", bg: "#FFFFFF" });
		reloadUserThemes();
		applyDesignSystem("user:ember");
		expect(t.orange).toBe("#FF8800");
		expect(t.bg).toBe(palettes.dark.bg);
		expect(t.textPrimary).toBe(palettes.dark.textPrimary);
		expect(themeStatus().designSystem).toBe("user:ember");
		applyDesignSystem("user:paper");
		expect(t.bg).toBe("#FFFFFF");
		expect(t.textPrimary).toBe(palettes.light.textPrimary);
		applyDesignSystem(null);
		expect(t.orange).toBe(palettes.dark.orange);
	});

	test("bad files are skipped with reasons and never listed", () => {
		put("ok.json", { base: "dark", orange: "#ff8800" });
		put("bad.json", { base: "dark", orange: "orange", whatever: "#fff" });
		put("junk.json", "{{");
		reloadUserThemes();
		expect(themeChoices().filter((r) => r.value.startsWith("user:")).map((r) => r.value)).toEqual(["user:ok"]);
		const p = userThemeProblems();
		expect(p.map((s) => s.file)).toEqual(["bad.json", "junk.json"]);
		expect(p[0]?.reason).toContain("whatever");
	});

	test("an unknown user theme id falls back to the stock theme", () => {
		reloadUserThemes();
		applyDesignSystem("user:ghost");
		expect(t.orange).toBe(palettes.dark.orange);
		expect(themeStatus().designSystem).toBeNull();
	});

	test("saveThemeChoice persists, keeps other keys, and clears the other kind", () => {
		put("ember.json", { base: "dark", orange: "#ff8800" });
		reloadUserThemes();
		writeFileSync(cfg, JSON.stringify({ model: "x", designSystem: "bold-tech" }));
		saveThemeChoice("user:ember", cfg);
		let raw = JSON.parse(readFileSync(cfg, "utf-8"));
		expect(raw).toEqual({ model: "x", userTheme: "ember" });
		saveThemeChoice("bold-tech", cfg);
		raw = JSON.parse(readFileSync(cfg, "utf-8"));
		expect(raw).toEqual({ model: "x", designSystem: "bold-tech" });
		saveThemeChoice(null, cfg);
		expect(JSON.parse(readFileSync(cfg, "utf-8"))).toEqual({ model: "x" });
	});

	test("saveThemeChoice refuses an unknown user theme and a broken config, writing nothing", () => {
		reloadUserThemes();
		expect(() => saveThemeChoice("user:ghost", cfg)).toThrow("Unknown user theme");
		put("ember.json", { base: "dark", orange: "#ff8800" });
		reloadUserThemes();
		writeFileSync(cfg, "{broken");
		expect(() => saveThemeChoice("user:ember", cfg)).toThrow();
		expect(readFileSync(cfg, "utf-8")).toBe("{broken");
	});

	test("reload picks up edits to the active theme and drops a deleted one", () => {
		put("ember.json", { base: "dark", orange: "#ff8800" });
		reloadUserThemes();
		applyDesignSystem("user:ember");
		put("ember.json", { base: "dark", orange: "#00ff00" });
		reloadUserThemes();
		expect(t.orange).toBe("#00FF00");
		rmSync(join(themes, "ember.json"));
		reloadUserThemes();
		expect(t.orange).toBe(palettes.dark.orange);
		expect(themeStatus().designSystem).toBeNull();
	});
});
