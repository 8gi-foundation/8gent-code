/** Startup scrub of a saved agent name that looks like a key (#5098). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { scrubSecretAgentNames } from "./scrub-names.js";
import { getSettingsFilePath, loadSettings } from "./store.js";

const KEY = "sk-ant-api03-AbCdEf1234567890AbCdEf1234567890";

describe("scrubSecretAgentNames", () => {
	const saved = { HOME: process.env.HOME, EIGHT_HOME: process.env.EIGHT_HOME };
	let home: string;

	beforeEach(() => {
		home = realpathSync(mkdtempSync(path.join(tmpdir(), "scrub-names-")));
		process.env.EIGHT_HOME = home;
		process.env.HOME = home;
		mkdirSync(path.join(home, ".8gent"), { recursive: true });
	});
	afterEach(() => {
		process.env.HOME = saved.HOME;
		if (saved.EIGHT_HOME === undefined) delete process.env.EIGHT_HOME;
		else process.env.EIGHT_HOME = saved.EIGHT_HOME;
		rmSync(home, { recursive: true, force: true });
	});

	test("a key saved as a name goes back to the role default, on disk", () => {
		writeFileSync(
			getSettingsFilePath(),
			JSON.stringify({ agents: { names: { orchestrator: KEY, engineer: "Rishi" } } }),
		);
		expect(scrubSecretAgentNames()).toBe(true);
		const names = loadSettings().agents.names;
		expect(names.orchestrator).toBe(DEFAULT_SETTINGS.agents.names.orchestrator);
		expect(names.engineer).toBe("Rishi");
		expect(readFileSync(getSettingsFilePath(), "utf-8")).not.toContain(KEY);
	});

	test("normal names are left alone and nothing is reported", () => {
		writeFileSync(
			getSettingsFilePath(),
			JSON.stringify({ agents: { names: { orchestrator: "Eight 🙂", qa: "Mary Jane" } } }),
		);
		expect(scrubSecretAgentNames()).toBe(false);
		expect(loadSettings().agents.names.orchestrator).toBe("Eight 🙂");
	});
});
