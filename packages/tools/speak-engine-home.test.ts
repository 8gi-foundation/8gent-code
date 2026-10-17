import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engineEnv, engineHome, speak } from "./speak";

describe("speak engine home", () => {
	test("engineHome is the account home, ignoring a sandboxed $HOME and EIGHT_TTS_HOME", () => {
		const prevH = process.env.HOME;
		const prevT = process.env.EIGHT_TTS_HOME;
		process.env.HOME = "/tmp/pilot-run/home";
		process.env.EIGHT_TTS_HOME = "relative/dir";
		try {
			expect(engineHome()).toBe(os.userInfo().homedir);
		} finally {
			process.env.HOME = prevH;
			if (prevT === undefined) delete process.env.EIGHT_TTS_HOME;
			else process.env.EIGHT_TTS_HOME = prevT;
		}
	});

	test("child env is an allowlist: HOME is not the real home, no secrets, offline", () => {
		const real = "/Users/someone";
		const env = engineEnv("/tmp/private", real, {
			PATH: "/usr/bin",
			LANG: "en_US.UTF-8",
			GITHUB_TOKEN: "x",
			ANTHROPIC_API_KEY: "y",
			HOME: real,
		});
		expect(env.HOME).toBe("/tmp/private");
		expect(env.HOME).not.toBe(real);
		expect(env.HF_HOME).toBe("/Users/someone/.cache/huggingface");
		expect(env.SUPERTONIC_CACHE_DIR).toBe("/Users/someone/.cache/supertonic3");
		expect(env.HF_HUB_OFFLINE).toBe("1");
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
	});

	test("speak() synthesizes under a sandboxed HOME with only the narrow env", async () => {
		const real = os.userInfo().homedir;
		if (!fs.existsSync(path.join(real, ".pyenv/versions/3.11.4/bin/supertonic"))) return;
		const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "speak-sbx-"));
		const prev = process.env.HOME;
		process.env.HOME = sandbox;
		try {
			const r = await speak({ text: "Fix it, don't bin it.", out: path.join(sandbox, "o.wav") });
			expect(r.durationSec).toBeGreaterThan(0.5);
			expect(fs.readdirSync(sandbox)).toEqual(["o.wav"]);
		} finally {
			process.env.HOME = prev;
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	}, 120000);
});
