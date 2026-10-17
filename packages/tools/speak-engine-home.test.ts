import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { engineHome } from "./speak";

describe("speak engineHome", () => {
	test("ignores a sandboxed $HOME and uses the account home", () => {
		expect(engineHome({ HOME: "/tmp/pilot-run/home" })).toBe(os.userInfo().homedir);
	});
	test("EIGHT_TTS_HOME overrides", () => {
		expect(engineHome({ HOME: "/tmp/x", EIGHT_TTS_HOME: "/opt/tts" })).toBe("/opt/tts");
	});
	test("speak() synthesizes under a sandboxed HOME when engines exist on the account", async () => {
		const { speak } = await import("./speak");
		const fs = await import("node:fs");
		const path = await import("node:path");
		const real = os.userInfo().homedir;
		if (!fs.existsSync(path.join(real, ".pyenv/versions/3.11.4/bin/supertonic"))) return;
		const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "speak-home-"));
		const prev = process.env.HOME;
		process.env.HOME = sandbox;
		try {
			const r = await speak({ text: "Fix it, don't bin it.", out: path.join(sandbox, "o.wav") });
			expect(r.durationSec).toBeGreaterThan(0.5);
		} finally {
			process.env.HOME = prev;
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	}, 120000);
});
