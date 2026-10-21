// #4682: on Android the launch detection does not start python3 for KittenTTS
// unless voice is on.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type OllamaCheck, OnboardingManager, voiceProbesWanted } from "./onboarding";

describe("voiceProbesWanted", () => {
	test("Android probes only with voice on; other platforms as before", () => {
		expect(voiceProbesWanted("android", false)).toBe(false);
		expect(voiceProbesWanted("android", undefined)).toBe(false);
		expect(voiceProbesWanted("android", true)).toBe(true);
		expect(voiceProbesWanted("linux", false)).toBe(true);
		expect(voiceProbesWanted("darwin", undefined)).toBe(true);
	});
});

describe("autoDetect voiceProbes", () => {
	const savedPath = process.env.PATH;
	let dir = "";
	afterEach(() => {
		process.env.PATH = savedPath;
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	function shimPython(): string {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-probes-"));
		const log = path.join(dir, "calls.log");
		fs.writeFileSync(path.join(dir, "python3"), `#!/bin/sh\necho "$@" >> "${log}"\n`, {
			mode: 0o755,
		});
		process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
		return log;
	}
	const ollama = Promise.resolve({ status: "found", host: "x", models: [] } as OllamaCheck);

	test("off: python3 is never started", async () => {
		const log = shimPython();
		const d = await OnboardingManager.autoDetect({ ollama, voiceProbes: false });
		expect(fs.existsSync(log)).toBe(false);
		expect(d.hasKittenTTS).toBe(false);
	});

	test("on: python3 is asked for its version and KittenTTS", async () => {
		const log = shimPython();
		const d = await OnboardingManager.autoDetect({ ollama, voiceProbes: true });
		const calls = fs.readFileSync(log, "utf8");
		expect(calls).toContain("--version");
		expect(calls).toContain("import kittentts");
		expect(d.hasKittenTTS).toBe(true);
	});
});
