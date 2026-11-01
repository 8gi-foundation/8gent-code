/**
 * Every daemon state path resolves through getDataDir() (#4111).
 *
 * Windows and the Scheduled Task set no HOME. The daemon used to build these
 * paths from process.env.HOME, so they became "undefined/.8gent/..." (written
 * into the working directory, which can be a repo checkout) or fell back to
 * /root, /app, / or /tmp. Each case below deletes HOME, EIGHT_HOME and
 * EIGHT_DATA_DIR, points os.homedir() at a temp profile the way Windows
 * resolves USERPROFILE, and asserts the path lands under <profile>/.8gent.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join, sep } from "node:path";
import { cosWorkspace, goalsPath } from "./cos-router";
import { cronPath } from "./cron";
import { inboxPath, taskQueuePath } from "./heartbeat";
import { claimRoots, creativeDir } from "./huddle-stage";
import { tasksPath } from "./task-registry";
import { cosPoolWorkspace, sessionStorePath, whisperModelDirs } from "./telegram-bridge";

const KEYS = ["HOME", "EIGHT_HOME", "EIGHT_DATA_DIR", "USERPROFILE", "EIGHT_TG_SESSIONS"] as const;

let profile = "";
let saved: Record<string, string | undefined> = {};
let homedirSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
	saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	profile = mkdtempSync(join(os.tmpdir(), "daemon4111-profile-"));
	for (const k of KEYS) delete process.env[k];
	process.env.USERPROFILE = profile;
	// Windows resolves os.homedir() from USERPROFILE; the Scheduled Task sets no HOME.
	homedirSpy = spyOn(os, "homedir").mockImplementation(() => process.env.USERPROFILE as string);
});

afterEach(() => {
	homedirSpy?.mockRestore();
	homedirSpy = null;
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(profile, { recursive: true, force: true });
});

const underData = (p: string) => p.startsWith(join(profile, ".8gent") + sep);

describe("daemon paths without HOME land under <profile>/.8gent (#4111)", () => {
	const cases: Array<[string, () => string[], string[]]> = [
		["cron.ts cron.json", () => [cronPath()], ["cron.json"]],
		[
			"heartbeat.ts task queue and inbox",
			() => [taskQueuePath(), inboxPath()],
			["task-queue.json", "inbox.json"],
		],
		[
			"telegram-bridge.ts sessions, whisper models, pool workspace",
			() => [sessionStorePath(), whisperModelDirs().modelsDir, cosPoolWorkspace()],
			["telegram-sessions.json", join("models", "whisper"), "workspace"],
		],
		["task-registry.ts tasks.json", () => [tasksPath()], ["tasks.json"]],
		[
			"cos-router.ts goals and workspace",
			() => [goalsPath(), cosWorkspace()],
			["goals.json", "workspace"],
		],
		["huddle-stage.ts creative dir", () => [creativeDir()], ["creative"]],
	];

	for (const [name, resolve, tails] of cases) {
		test(name, () => {
			const paths = resolve();
			expect(paths).toEqual(tails.map((t) => join(profile, ".8gent", t)));
			for (const p of paths) {
				expect(underData(p)).toBe(true);
				expect(p.includes("undefined")).toBe(false);
			}
		});
	}

	test("paths outside .8gent use the profile, never / or the working directory", () => {
		expect(whisperModelDirs().extraDirs).toEqual([join(profile, "models")]);
		expect(claimRoots()).toEqual([
			join(profile, "8gent-code"),
			join(profile, "8gi-governance"),
			join(profile, ".8gent"),
		]);
	});

	test("EIGHT_DATA_DIR wins over the profile", () => {
		const data = join(profile, "elsewhere");
		process.env.EIGHT_DATA_DIR = data;
		expect(cronPath()).toBe(join(data, "cron.json"));
		expect(taskQueuePath()).toBe(join(data, "task-queue.json"));
		expect(tasksPath()).toBe(join(data, "tasks.json"));
		expect(goalsPath()).toBe(join(data, "goals.json"));
		expect(sessionStorePath()).toBe(join(data, "telegram-sessions.json"));
		expect(creativeDir()).toBe(join(data, "creative"));
	});

	test("EIGHT_TG_SESSIONS still wins for the session store", () => {
		process.env.EIGHT_TG_SESSIONS = join(profile, "custom-sessions.json");
		expect(sessionStorePath()).toBe(join(profile, "custom-sessions.json"));
	});

	test("with HOME set to os.homedir(), every path is identical to the old HOME-built one", () => {
		process.env.HOME = profile;
		const h = process.env.HOME;
		expect(cronPath()).toBe(`${h}/.8gent/cron.json`.split("/").join(sep));
		expect(taskQueuePath()).toBe(`${h}/.8gent/task-queue.json`.split("/").join(sep));
		expect(inboxPath()).toBe(`${h}/.8gent/inbox.json`.split("/").join(sep));
		expect(tasksPath()).toBe(join(h, ".8gent", "tasks.json"));
		expect(goalsPath()).toBe(join(h, ".8gent", "goals.json"));
		expect(cosWorkspace()).toBe(join(h, ".8gent", "workspace"));
		expect(sessionStorePath()).toBe(`${h}/.8gent/telegram-sessions.json`.split("/").join(sep));
		expect(cosPoolWorkspace()).toBe(`${h}/.8gent/workspace`.split("/").join(sep));
		expect(whisperModelDirs()).toEqual({
			modelsDir: `${h}/.8gent/models/whisper`.split("/").join(sep),
			extraDirs: [`${h}/models`.split("/").join(sep)],
		});
		expect(claimRoots()).toEqual([
			join(h, "8gent-code"),
			join(h, "8gi-governance"),
			join(h, ".8gent"),
		]);
		expect(creativeDir()).toBe(join(h, ".8gent", "creative"));
	});
});
