import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SPEAK_TS = path.join(import.meta.dir, "..", "speak.ts");
let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "speak-home-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const posixTest = process.platform === "win32" ? test.skip : test;

describe("engineHome", () => {
	// Bun's os.userInfo().homedir returns $HOME only when HOME is set at process LAUNCH, so the
	// check must run in a child started with the per-run HOME (the pilot sandbox case).
	posixTest("ignores a per-run $HOME set at launch", () => {
		const r = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`import { engineHome } from ${JSON.stringify(SPEAK_TS)}; process.stdout.write(engineHome());`,
			],
			{ env: { PATH: process.env.PATH ?? "", HOME: dir } },
		);
		expect(r.exitCode).toBe(0);
		const home = r.stdout.toString();
		expect(home.startsWith("/")).toBe(true);
		expect(home).not.toBe(dir);
	});
});
