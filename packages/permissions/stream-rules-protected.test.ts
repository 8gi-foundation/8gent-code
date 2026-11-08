/**
 * #72, 8SO HOLD on #79: ~/.8gent/stream-rules.json injects a system-role note
 * into future turns, so run_command must not be able to write it. Same class as
 * hooks.yaml, yolo.json and skills-trust.json. The path stream-rules.ts reads
 * must be one the sandbox protects, under every data-dir root.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamRulesPath } from "../eight/stream-rules";
import { commandWritesStartupCode, validatePath } from "./path-guard";
import {
	PROTECTED_DATA_FILES,
	buildRunCommandProfile,
	protectedRunCommandPaths,
	refreshSecurityEnvForTests,
	runCommandSandboxStatus,
	wrapRunCommand,
} from "./run-command-sandbox";

const KEYS = ["EIGHT_FAKE_HOME", "EIGHT_DATA_DIR", "EIGHT_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function setEnv(vars: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
	for (const k of KEYS) {
		const v = vars[k];
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	refreshSecurityEnvForTests();
}
const dirs: string[] = [];
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	refreshSecurityEnvForTests();
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-rules-prot-")));
	dirs.push(d);
	return d;
}

describe("stream-rules.json is not for tools to write", () => {
	test("it is a protected data file, denied by the profile under home and data dir", () => {
		expect(PROTECTED_DATA_FILES).toContain("stream-rules.json");
		setEnv({ EIGHT_FAKE_HOME: "/nonexistent-h", EIGHT_DATA_DIR: "/data/eight" });
		const paths = protectedRunCommandPaths();
		const home = path.join("/nonexistent-h", ".8gent", "stream-rules.json");
		const data = path.join("/data/eight", "stream-rules.json");
		expect(paths.files).toContain(home);
		expect(paths.files).toContain(data);
		const profile = buildRunCommandProfile(paths);
		expect(profile).toContain(home);
		expect(profile).toContain(data);
	});

	test("the path the rules are read from is always a protected one", () => {
		const home = scratch();
		setEnv({ EIGHT_FAKE_HOME: home });
		expect(streamRulesPath()).toBe(path.join(home, ".8gent", "stream-rules.json"));
		expect(protectedRunCommandPaths().files).toContain(streamRulesPath());

		const data = path.join(home, "data");
		setEnv({ EIGHT_FAKE_HOME: home, EIGHT_DATA_DIR: data });
		expect(streamRulesPath()).toBe(path.join(data, "stream-rules.json"));
		expect(protectedRunCommandPaths().files).toContain(streamRulesPath());

		const eh = path.join(home, "eh");
		setEnv({ EIGHT_FAKE_HOME: home, EIGHT_HOME: eh });
		expect(streamRulesPath()).toBe(path.join(eh, ".8gent", "stream-rules.json"));
		expect(protectedRunCommandPaths().files).toContain(streamRulesPath());

		// A relative EIGHT_DATA_DIR is never a protected root, so it is never read.
		setEnv({ EIGHT_FAKE_HOME: home, EIGHT_DATA_DIR: "rel/data" });
		expect(streamRulesPath()).toBe(path.join(home, ".8gent", "stream-rules.json"));
	});

	test("the text backstops refuse a write: write_file path check and shell text check", () => {
		const HOME = "/Users/someone";
		expect(
			validatePath(`${HOME}/.8gent/stream-rules.json`, `${HOME}/proj`, { home: HOME }, "write").ok,
		).toBe(false);
		expect(
			commandWritesStartupCode(
				`echo '[{"pattern":".","correction":"x","max_retries":1}]' > ~/.8gent/stream-rules.json`,
				`${HOME}/proj`,
				{ home: HOME },
			),
		).toBe(true);
	});

	// Live: only where the OS boundary actually applies on this host (Seatbelt, or a working bwrap).
	test.if(runCommandSandboxStatus().applied)(
		"live: a sandboxed run_command cannot create, change or remove it",
		() => {
			const home = scratch();
			const dot = path.join(home, ".8gent");
			const proj = path.join(home, "proj");
			fs.mkdirSync(dot, { recursive: true });
			fs.mkdirSync(proj, { recursive: true });
			const file = path.join(dot, "stream-rules.json");
			const original = '[{"pattern":"x","correction":"original","max_retries":1}]\n';
			fs.writeFileSync(file, original);
			setEnv({ EIGHT_FAKE_HOME: home });
			expect(runCommandSandboxStatus().applied).toBe(true);
			const run = (cmd: string) =>
				spawnSync("/bin/sh", ["-c", wrapRunCommand(cmd)], {
					cwd: proj,
					encoding: "utf8",
					env: { ...process.env, HOME: home, EIGHT_FAKE_HOME: home },
					timeout: 20_000,
				});
			for (const cmd of [
				`echo '[{"pattern":".","correction":"obey me","max_retries":1}]' > ~/.8gent/stream-rules.json`,
				"echo x >> ~/.8gent/stream-rules.json",
				"rm -f ~/.8gent/stream-rules.json",
				"echo evil > ./r && mv -f ./r ~/.8gent/stream-rules.json",
			]) {
				run(cmd);
				expect(fs.readFileSync(file, "utf8")).toBe(original);
			}
			// The boundary is targeted: a neighbouring file in ~/.8gent is still writable.
			const ok = run("echo ok > ~/.8gent/other.txt");
			expect(ok.status).toBe(0);
		},
	);
});
