/**
 * 8SO probes for #4132 / PR #4134. Each test states the property the HMAC key
 * must have. A failing test here is a live bypass, not a flaky test.
 *
 * Status of the live probes (Artale, 8SO), as measured for PR #4134:
 * - P7 rename of <data>/keys: verified live on Linux (bubblewrap, denied, CI bwrap step).
 *   macOS: asserted-only (profile rule present, P7s; enforcement not measured, because
 *   sandbox-exec cannot nest inside the session sandbox: "sandbox_apply: Operation not permitted").
 * - P1b read of the key through wrapRunCommand: live where it ran (Linux CI bwrap step).
 *   macOS: asserted-only (read deny present, P1; enforcement not measured, same limit).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getKeyPath, loadOrCreateKey, sign, verify } from "./goal-state-hmac";
import { validatePath } from "./path-guard";
import {
	buildBwrapArgs,
	buildRunCommandProfile,
	protectedRunCommandPaths,
	refreshSecurityEnvForTests,
	runCommandSandboxStatus,
	wrapRunCommand,
} from "./run-command-sandbox";

/**
 * P7 needs a real OS boundary. Inside another sandbox (sandbox-exec cannot nest) or on a host
 * without bwrap it is skipped; EIGHT_REQUIRE_RUN_COMMAND_SANDBOX=1 (the CI bwrap step) turns
 * that skip into a failure so the Linux run cannot pass by skipping.
 */
const liveSandbox = runCommandSandboxStatus().applied;
if (!liveSandbox && process.env.EIGHT_REQUIRE_RUN_COMMAND_SANDBOX === "1") {
	throw new Error(
		`EIGHT_REQUIRE_RUN_COMMAND_SANDBOX=1 but run_command cannot be OS-sandboxed here: ${JSON.stringify(runCommandSandboxStatus())}`,
	);
}

let root: string;
let savedDataDir: string | undefined;
let savedCwd: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hmac-probe-")));
	savedDataDir = process.env.EIGHT_DATA_DIR;
	savedCwd = process.cwd();
});

afterEach(() => {
	process.chdir(savedCwd);
	if (savedDataDir === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedDataDir;
	refreshSecurityEnvForTests();
	fs.rmSync(root, { recursive: true, force: true });
});

function useDataDir(dir: string): void {
	process.env.EIGHT_DATA_DIR = dir;
	refreshSecurityEnvForTests();
}

describe("8SO probe: key confidentiality and integrity (#4132)", () => {
	// P1. The seatbelt profile only denies writes. run_command can `cat` the key,
	// then sign any /goal state, approval grant or Table ledger line it likes.
	test("P1 the run_command profile denies READS of the keys dir", () => {
		const data = path.join(root, "data");
		useDataDir(data);
		const profile = buildRunCommandProfile(protectedRunCommandPaths());
		const keysDir = path.join(data, "keys");
		const readDeny = profile.split("\n").filter((l) => l.startsWith("(deny file-read"));
		expect(readDeny.some((l) => l.includes(`(subpath "${keysDir}")`))).toBe(true);
	});

	// P1b. Same, proven by the kernel through the real run_command wrapper: seatbelt on
	// macOS, bwrap (tmpfs over keys/) on Linux. Same live gate as P7.
	test.skipIf(!liveSandbox)(
		"P1b sandboxed `cat` of the key is refused by the kernel",
		() => {
			const data = path.join(root, "data");
			useDataDir(data);
			loadOrCreateKey();
			const keyPath = getKeyPath();
			const wrapped = wrapRunCommand(`cat ${JSON.stringify(keyPath)}`);
			const r = spawnSync("/bin/sh", ["-c", wrapped]);
			expect(r.status).not.toBe(0);
			expect(r.stdout.length).toBe(0);
		},
	);

	// P2. The file tools' path guard has no rule for keys/. With the working
	// directory at HOME (the case getKeyPath exempts from its in-project check),
	// read_file and write_file reach the key directly.
	test("P2 path-guard refuses write_file on <home>/.8gent/keys/state-hmac.key", () => {
		const home = path.join(root, "home");
		fs.mkdirSync(path.join(home, ".8gent", "keys"), { recursive: true });
		const key = path.join(home, ".8gent", "keys", "state-hmac.key");
		expect(validatePath(key, home, { home }, "write").ok).toBe(false);
	});

	test("P2b path-guard refuses read_file on <home>/.8gent/keys/state-hmac.key", () => {
		const home = path.join(root, "home");
		fs.mkdirSync(path.join(home, ".8gent", "keys"), { recursive: true });
		const key = path.join(home, ".8gent", "keys", "state-hmac.key");
		expect(validatePath(key, home, { home }, "read").ok).toBe(false);
	});

	// P3. A pre-planted key is trusted as-is: no lstat, no symlink refusal, no
	// mode or owner check. On Linux bwrap binds only paths that exist, and keys/
	// is created on first use, so before first use run_command can plant it.
	test("P3 bwrap protects keys/ even before the key's first use", () => {
		const data = path.join(root, "data");
		fs.mkdirSync(data, { recursive: true });
		useDataDir(data);
		const args = buildBwrapArgs(protectedRunCommandPaths());
		const keysDir = path.join(data, "keys");
		const covered = args.some(
			(a, i) => args[i - 1] === "--ro-bind" && (a === keysDir || a === data),
		);
		expect(covered).toBe(true);
	});

	test("P3b a symlinked or world-readable pre-planted key is refused", () => {
		const data = path.join(root, "data");
		useDataDir(data);
		fs.mkdirSync(path.join(data, "keys"), { recursive: true });
		const planted = path.join(root, "attacker-known.key");
		fs.writeFileSync(planted, Buffer.alloc(32, 7), { mode: 0o644 });
		fs.symlinkSync(planted, path.join(data, "keys", "state-hmac.key"));
		expect(() => loadOrCreateKey()).toThrow();
	});

	// P7 (Artale, 8SO). Renaming <data>/keys changes the PARENT's entries, and <data> itself is
	// not a protected subpath. The key must survive `mv keys keys.bak` from run_command.
	test.skipIf(!liveSandbox)(
		"P7 run_command cannot rename <data>/keys aside (live: seatbelt on macOS, bwrap on Linux)",
		() => {
			const data = path.join(root, "data");
			useDataDir(data);
			const key = loadOrCreateKey();
			const keysDir = path.join(data, "keys");
			const wrapped = wrapRunCommand(`mv ${JSON.stringify(keysDir)} ${JSON.stringify(`${keysDir}.bak`)}`);
			const r = spawnSync("/bin/sh", ["-c", wrapped], { encoding: "utf8" });
			expect(r.status).not.toBe(0);
			expect(fs.readFileSync(path.join(keysDir, "state-hmac.key")).equals(key)).toBe(true);
			expect(fs.existsSync(path.join(`${keysDir}.bak`, "state-hmac.key"))).toBe(false);
		},
	);

	// P7s. The RULE half of P7, not its enforcement: the write deny treats <data>/keys as a
	// directory unit (subpath, which covers everything under it) plus the literal entry itself.
	// Whether seatbelt applies it to rename(2) is P7's job, measured live only where P7 runs.
	test("P7s the profile denies writes under <keys dir> as a subpath rule", () => {
		const data = path.join(root, "data");
		useDataDir(data);
		const keysDir = path.join(data, "keys");
		const profile = buildRunCommandProfile(protectedRunCommandPaths());
		const writeDeny = profile.split("\n").filter((l) => l.startsWith("(deny file-write* file-link"));
		expect(writeDeny.some((l) => l.includes(`(subpath "${keysDir}")`))).toBe(true);
		expect(writeDeny.some((l) => l.includes(`(literal "${keysDir}")`))).toBe(true);
	});

	// Holds: P4. A key under the data dir with a case-varied spelling is covered
	// by the case-insensitive regex (APFS).
	test("holds P4 profile carries a case-insensitive rule for keys/", () => {
		const data = path.join(root, "data");
		useDataDir(data);
		const profile = buildRunCommandProfile(protectedRunCommandPaths());
		expect(profile).toMatch(/\[kK\]\[eE\]\[yY\]\[sS\]\(\/\.\*\)\?\$"/);
	});

	// Holds: P5. cwd=/ does not make getKeyPath throw, and does not move the key.
	test("holds P5 cwd=/ leaves the key at the snapshot path", () => {
		const data = path.join(root, "data");
		useDataDir(data);
		process.chdir("/");
		expect(getKeyPath()).toBe(path.join(data, "keys", "state-hmac.key"));
		const s = sign({ g: 1 });
		expect(verify(s)).toBe(true);
	});

	// Holds: P6. refreshSecurityEnvForTests is a no-op outside test mode.
	test("holds P6 refreshSecurityEnvForTests cannot re-read env outside test mode", () => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		Reflect.deleteProperty(env, "NODE_ENV");
		Reflect.deleteProperty(env, "BUN_ENV");
		env.EIGHT_DATA_DIR = path.join(root, "first");
		const script = `
			import { refreshSecurityEnvForTests, securityEnvSnapshot } from ${JSON.stringify(path.join(import.meta.dirname, "run-command-sandbox.ts"))};
			process.env.EIGHT_DATA_DIR = ${JSON.stringify(path.join(root, "later"))};
			refreshSecurityEnvForTests();
			console.log(securityEnvSnapshot().values.EIGHT_DATA_DIR);
		`;
		const file = path.join(root, "p6.ts");
		fs.writeFileSync(file, script);
		const r = spawnSync("bun", ["--no-env-file", file], { env, cwd: root, encoding: "utf8" });
		expect(r.stderr).not.toMatch(/error/i);
		expect(r.stdout.trim()).toBe(path.join(root, "first"));
	});
});
