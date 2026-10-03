/**
 * The settings store honours $HOME at call time (#3391).
 *
 * store.ts used os.homedir(), which Bun fixes at process start, so the temp
 * $HOME preload (tests/preload-temp-home.ts) did not redirect it and a test
 * calling loadSettings or saveSettings touched the real ~/.8gent/settings.json.
 * The path now comes from resolveHome() (packages/core/home.ts), read on each
 * call, so a HOME set after import is the one used.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { getSettingsFilePath, loadSettings, saveSettings } from "./store.js";

describe("settings store path follows $HOME (#3391)", () => {
	const saved = { HOME: process.env.HOME, EIGHT_HOME: process.env.EIGHT_HOME };
	let home: string;

	beforeEach(() => {
		home = realpathSync(mkdtempSync(path.join(tmpdir(), "settings-home-")));
		// resolveHome prefers EIGHT_HOME, which the preload pins; clear it so
		// this exercises HOME itself.
		delete process.env.EIGHT_HOME;
		process.env.HOME = home;
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	});

	test("getSettingsFilePath lands under the HOME set after import", () => {
		expect(getSettingsFilePath()).toBe(path.join(home, ".8gent", "settings.json"));
	});

	test("saveSettings writes under HOME and loadSettings reads it back", () => {
		const file = path.join(home, ".8gent", "settings.json");
		// Guard first: if the store ever regresses to a path outside this temp
		// HOME (under bun test that is the real home), abort here, before any
		// load or save can touch the real settings file.
		expect(getSettingsFilePath()).toBe(file);
		expect(existsSync(file)).toBe(false);
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

		const next = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, theme: "store-home-test" } };
		saveSettings(next);

		expect(existsSync(file)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf-8")).ui.theme).toBe("store-home-test");
		expect(loadSettings().ui.theme).toBe("store-home-test");
	});

	test("EIGHT_HOME still wins over HOME", () => {
		const other = realpathSync(mkdtempSync(path.join(tmpdir(), "settings-eight-home-")));
		try {
			process.env.EIGHT_HOME = other;
			expect(getSettingsFilePath()).toBe(path.join(other, ".8gent", "settings.json"));
			expect(getSettingsFilePath().startsWith(home + path.sep)).toBe(false);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
