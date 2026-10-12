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

describe("user theme hardening", () => {
	test("control characters never reach the skipped list or the picker", () => {
		put("evil\u001b[2J\u202e.json", { base: "dark", orange: "#FF8800" });
		put("keyed.json", { base: "dark", "bad\u001b[2Jkey\u202e": "#FFF" });
		put("ok.json", { base: "dark", label: "Ok\u001b]0;pwn\u0007\u202e Theme\u2028", description: "d\u001b[2Je", orange: "#FF8800" });
		reloadUserThemes();
		const bad = userThemeProblems().map((p) => p.file + p.reason).join("");
		expect(bad).toContain("evil.json");
		expect(bad).toContain("badkey");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the test
		expect(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u202a-\u202e\u2028\u2029]/.test(bad)).toBeFalse();
		const row = themeChoices().find((r) => r.value === "user:ok");
		expect(row?.label).toBe("Ok Theme");
		expect(row?.description).toBe("de");
	});

	test("invisible text is rejected", () => {
		put("ghost.json", { base: "dark", textPrimary: "#0A0908" });
		reloadUserThemes();
		expect(themeChoices().some((r) => r.value === "user:ghost")).toBeFalse();
		expect(userThemeProblems().find((p) => p.file === "ghost.json")?.reason).toContain("textPrimary");
	});

	test("danger colour equal to bg is rejected", () => {
		put("nored.json", { base: "dark", bg: "#E5503A" , textPrimary: "#000000", textSecondary: "#000000", cream: "#000000", prose: "#000000"});
		put("nored2.json", { base: "dark", red: "#0A0908" });
		reloadUserThemes();
		expect(userThemeProblems().find((p) => p.file === "nored2.json")?.reason).toContain('"red"');
		expect(themeChoices().some((r) => r.value === "user:nored2")).toBeFalse();
	});

	test("muted or frame equal to bg is rejected", () => {
		put("nomuted.json", { base: "dark", muted: "#0A0908" });
		put("noframe.json", { base: "dark", frame: "#0A0908" });
		reloadUserThemes();
		expect(userThemeProblems().find((p) => p.file === "nomuted.json")?.reason).toContain('"muted"');
		expect(userThemeProblems().find((p) => p.file === "noframe.json")?.reason).toContain('"frame"');
		expect(themeChoices().some((r) => r.value === "user:nomuted")).toBeFalse();
	});

	test("a normal theme passes", () => {
		put("fine.json", { base: "dark", orange: "#FF8800", bg: "#140C06" });
		reloadUserThemes();
		expect(themeChoices().some((r) => r.value === "user:fine")).toBeTrue();
	});
});
