/**
 * #4132: the /goal state HMAC key path comes from the startup security env
 * snapshot, never from live process.env, and is refused inside the project dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getKeyPath, loadOrCreateKey, sign, verify } from "./goal-state-hmac";
import { validatePath } from "./path-guard";
import {
	buildRunCommandProfile,
	protectedRunCommandPaths,
	refreshSecurityEnvForTests,
} from "./run-command-sandbox";

let root: string;
let savedDataDir: string | undefined;
let savedCwd: string;
let savedHome: string | undefined;
let savedEightHome: string | undefined;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hmac-keypath-")));
	savedDataDir = process.env.EIGHT_DATA_DIR;
	savedCwd = process.cwd();
	savedHome = process.env.HOME;
	savedEightHome = process.env.EIGHT_HOME;
});

afterEach(() => {
	process.chdir(savedCwd);
	for (const [k, v] of [
		["HOME", savedHome],
		["EIGHT_HOME", savedEightHome],
	] as const) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	if (savedDataDir === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedDataDir;
	refreshSecurityEnvForTests();
	fs.rmSync(root, { recursive: true, force: true });
});

/** A path as the profile spells it: sbplString doubles each backslash (Windows paths). */
function sbpl(p: string): string {
	return p.replaceAll("\\", "\\\\");
}

function useDataDir(dir: string): void {
	process.env.EIGHT_DATA_DIR = dir;
	refreshSecurityEnvForTests();
}

describe("goal-state-hmac key path (#4132)", () => {
	test("mutation check: a later EIGHT_DATA_DIR change does not move the key", () => {
		const first = path.join(root, "first");
		useDataDir(first);
		const signed = sign({ goal: "ship", step: 1 });
		const firstKey = path.join(first, "keys", "state-hmac.key");
		expect(fs.existsSync(firstKey)).toBe(true);

		// In-process mutation after startup (a repo .env load, a tool editing process.env).
		const later = path.join(root, "later");
		process.env.EIGHT_DATA_DIR = later;

		const again = sign({ goal: "ship", step: 1 });
		loadOrCreateKey();
		expect(fs.existsSync(path.join(later, "keys", "state-hmac.key"))).toBe(false);
		expect(fs.existsSync(later)).toBe(false);
		expect(getKeyPath()).toBe(firstKey);
		expect(again.sig).toBe(signed.sig);
		expect(verify(signed)).toBe(true);
	});

	test("a key path inside the project directory throws", () => {
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		useDataDir(path.join(project, ".8gent"));
		process.chdir(project);
		expect(() => getKeyPath()).toThrow(/inside the project directory/);
		expect(() => sign({ goal: "x" })).toThrow(/inside the project directory/);
		expect(verify({ payload: { goal: "x" }, sig: "00" })).toBe(false);
		expect(fs.existsSync(path.join(project, ".8gent", "keys"))).toBe(false);
	});

	test("a data dir that symlinks into the project is refused by real path", () => {
		const project = path.join(root, "proj");
		const inside = path.join(project, "data");
		fs.mkdirSync(inside, { recursive: true });
		const link = path.join(root, "outside-link");
		fs.symlinkSync(inside, link);
		useDataDir(link);
		process.chdir(project);
		expect(() => getKeyPath()).toThrow(/inside the project directory/);
		expect(fs.existsSync(path.join(inside, "keys"))).toBe(false);
	});

	test("a key path outside the project directory is allowed", () => {
		const project = path.join(root, "proj");
		fs.mkdirSync(project, { recursive: true });
		useDataDir(path.join(root, "data"));
		process.chdir(project);
		expect(getKeyPath()).toBe(path.join(root, "data", "keys", "state-hmac.key"));
	});

	test("fallback: no EIGHT_DATA_DIR puts the key under the snapshot home, and a later HOME change does not move it", () => {
		const home = path.join(root, "home");
		fs.mkdirSync(home, { recursive: true });
		Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
		process.env.HOME = home;
		process.env.EIGHT_HOME = home;
		refreshSecurityEnvForTests();
		const keyPath = path.join(home, ".8gent", "keys", "state-hmac.key");
		expect(getKeyPath()).toBe(keyPath);
		const signed = sign({ goal: "fallback" });
		expect(fs.existsSync(keyPath)).toBe(true);

		const other = path.join(root, "other-home");
		process.env.HOME = other;
		process.env.EIGHT_HOME = other;
		expect(getKeyPath()).toBe(keyPath);
		expect(sign({ goal: "fallback" }).sig).toBe(signed.sig);
		expect(fs.existsSync(other)).toBe(false);
		// The file tools still refuse the real key dir after the live HOME move.
		expect(validatePath(keyPath, root, { home: other }, "read").ok).toBe(false);
		expect(validatePath(keyPath, root, { home: other }, "write").ok).toBe(false);
	});

	test("the run-from-home exemption uses the snapshot home, so a live HOME change cannot switch the refusal off", () => {
		const home = path.join(root, "home");
		const project = path.join(root, "proj");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.EIGHT_HOME = home;
		useDataDir(path.join(project, ".8gent"));
		process.chdir(project);
		// Live HOME now equals the project, which would make "home is inside the project" true.
		process.env.HOME = project;
		process.env.EIGHT_HOME = project;
		expect(() => getKeyPath()).toThrow(/inside the project directory/);
		expect(fs.existsSync(path.join(project, ".8gent", "keys"))).toBe(false);
	});

	test("the keys dir is protected from run_command writes", () => {
		const data = path.join(root, "data");
		useDataDir(data);
		const p = protectedRunCommandPaths();
		const keysDir = path.join(data, "keys");
		expect(p.dirs).toContain(keysDir);
		expect(buildRunCommandProfile(p)).toContain(`(subpath "${sbpl(keysDir)}")`);
	});
});
