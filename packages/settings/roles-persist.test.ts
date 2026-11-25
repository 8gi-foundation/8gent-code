/** models.roles (#73) survives a load and a save; absent by default. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getSettingsFilePath, loadGlobalSettings, saveSettings } from "./store.js";

describe("models.roles in the settings file", () => {
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EIGHT_HOME: process.env.EIGHT_HOME };
	let home: string;

	beforeEach(() => {
		home = realpathSync(mkdtempSync(path.join(tmpdir(), "settings-roles-")));
		delete process.env.EIGHT_HOME;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	});

	test("no roles written: none loaded", () => {
		expect(loadGlobalSettings().models.roles).toBeUndefined();
	});

	test("roles survive load then save", () => {
		const file = getSettingsFilePath();
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ models: { roles: { small: { provider: "ollama", model: "tiny:1b" } } } }));
		const loaded = loadGlobalSettings();
		expect(loaded.models.roles?.small).toEqual({ provider: "ollama", model: "tiny:1b" });
		saveSettings(loaded);
		expect(JSON.parse(readFileSync(file, "utf-8")).models.roles.small.model).toBe("tiny:1b");
	});
});
