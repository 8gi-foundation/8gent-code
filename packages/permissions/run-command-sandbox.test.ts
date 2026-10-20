/**
 * run_command OS sandbox (#4009, #3612).
 *
 * The profile tests are pure and run everywhere. "compiles" runs wherever
 * /usr/bin/sandbox-exec exists: a profile that does not parse fails with exit
 * 65 before the kernel is asked to apply it, so the check holds even inside
 * another sandbox (where apply itself fails with 71).
 *
 * The live tests need a process no host sandbox already wraps (sandbox-exec
 * cannot nest). Inside the agent sandbox they skip; James or CI must run
 * `bun test packages/permissions/run-command-sandbox.test.ts` in a normal
 * terminal. They include the 12 bypass commands from the 8SO F2 PoC.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildBwrapArgs,
	buildRunCommandProfile,
	canApplySeatbelt,
	caseInsensitivePathRegex,
	dotenvDeclaredKeys,
	isTestMode,
	onRunCommandUnsandboxed,
	PROTECTED_DATA_DIRS,
	PROTECTED_DATA_FILES,
	protectedRunCommandPaths,
	refreshSecurityEnvForTests,
	RunCommandSandboxRequired,
	runCommandSandboxRefusal,
	runCommandSandboxStatus,
	sandboxFooterReason,
	snapshotSecurityEnv,
	wrapRunCommand,
	wrapRunCommandArgv,
} from "./run-command-sandbox";
import { emptyBunfig } from "../core/bun-flags";
import { BackgroundTaskManager } from "../tools/background";

// Paths below are built with path.join so they match on Windows too, where
// path.normalize spells "/nonexistent-h/.8gent" as "\\nonexistent-h\\.8gent".
const H = path.join("/nonexistent-h", ".8gent");
const E = path.join("/nonexistent-e", ".8gent");
const D = path.normalize("/nonexistent-d");

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		saved[k] = process.env[k];
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	refreshSecurityEnvForTests();
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
		refreshSecurityEnvForTests();
	}
}

describe("protected set", () => {
	test("covers startup code, secrets, audit and session records under ~/.8gent", () => {
		withEnv(
			{ EIGHT_FAKE_HOME: "/nonexistent-h", EIGHT_DATA_DIR: undefined, EIGHT_HOME: undefined },
			() => {
				const p = protectedRunCommandPaths();
				for (const f of [
					"hooks.yaml",
					"hooks.json",
					"settings.json",
					"browser-control.token",
					"audit.jsonl",
					"policies.yaml",
					"mcp.json",
					".env",
					"keys.env",
					"allow-loopback.json",
				])
					expect(p.files).toContain(path.join(H, f));
				for (const d of [
					"extensions",
					"themes",
					"prompts",
					"packages",
					"browser-profiles",
					"audit",
					"sessions",
					"bin",
					"secrets",
					"policy-checksum",
				])
					expect(p.dirs).toContain(path.join(H, d));
				if (process.platform === "win32") {
					// Windows: resolveHome prefers USERPROFILE over HOME (packages/core/home.ts),
					// so the real profile's .8gent is a second root, and realpath adds the
					// drive-letter spelling of each. POSIX keeps the exact one-root check.
					expect(p.roots).toContain(H);
					expect(p.roots).toContain(path.join(process.env.USERPROFILE || os.homedir(), ".8gent"));
				} else {
					expect(p.roots).toEqual([H]);
				}
			},
		);
	});

	test("EIGHT_HOME (resolveHome) adds its .8gent as a root", () => {
		withEnv(
			{
				EIGHT_FAKE_HOME: "/nonexistent-h",
				EIGHT_HOME: "/nonexistent-e",
				EIGHT_DATA_DIR: undefined,
			},
			() => {
				const p = protectedRunCommandPaths();
				expect(p.roots).toContain(H);
				expect(p.roots).toContain(E);
				expect(p.files).toContain(path.join(E, "hooks.yaml"));
			},
		);
	});

	test("EIGHT_DATA_DIR adds the same set under the data dir", () => {
		withEnv({ EIGHT_FAKE_HOME: "/nonexistent-h", EIGHT_DATA_DIR: "/nonexistent-d" }, () => {
			const p = protectedRunCommandPaths();
			expect(p.roots).toContain(D);
			expect(p.files).toContain(path.join(D, "hooks.yaml"));
			expect(p.dirs).toContain(path.join(D, "extensions"));
		});
	});

	test("a symlinked home is denied by its real path too", () => {
		const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-real-")));
		const link = path.join(fs.realpathSync(os.tmpdir()), `rcs-link-${process.pid}`);
		fs.symlinkSync(real, link);
		try {
			withEnv({ EIGHT_FAKE_HOME: link, EIGHT_DATA_DIR: undefined }, () => {
				const p = protectedRunCommandPaths();
				expect(p.files).toContain(path.join(link, ".8gent", "hooks.yaml"));
				expect(p.files).toContain(path.join(real, ".8gent", "hooks.yaml"));
			});
		} finally {
			fs.rmSync(link, { force: true });
			fs.rmSync(real, { recursive: true, force: true });
		}
	});
});

describe("security env snapshot", () => {
	test("a key any .env file declares is ignored, whatever its value; others kept", () => {
		const snap = snapshotSecurityEnv(
			{ EIGHT_SEATBELT: "0", EIGHT_DATA_DIR: "/d", EIGHT_HOME: "/e" },
			new Set(["EIGHT_SEATBELT", "EIGHT_HOME"]),
		);
		expect(snap.values).toEqual({ EIGHT_DATA_DIR: "/d" });
		expect(snap.ignored).toEqual(["EIGHT_SEATBELT", "EIGHT_HOME"]);
	});

	test("EIGHT_SEATBELT=require always survives, even when a .env declares it", () => {
		const snap = snapshotSecurityEnv({ EIGHT_SEATBELT: "require" }, new Set(["EIGHT_SEATBELT"]));
		expect(snap.values).toEqual({ EIGHT_SEATBELT: "require" });
		expect(snap.ignored).toEqual([]);
	});

	// The five forms 8SO found Bun parses differently from a naive parser. For each, Bun
	// itself loads the file (so the live value is whatever Bun makes of it), and the key
	// must still be ignored.
	const FORMS = [
		"EIGHT_SEATBELT=0 # c",
		'EIGHT_SEATBELT="0" # c',
		"EIGHT_SEATBELT=${Z}",
		"EIGHT_SEATBELT=$Z",
		"EIGHT_SEATBELT=`0`",
	];
	for (const line of FORMS) {
		test(`ignored when Bun loads it from .env: ${line}`, () => {
			const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-env-")));
			try {
				const file = path.join(dir, ".env");
				fs.writeFileSync(file, `Z=0\n${line}\n`);
				const env: NodeJS.ProcessEnv = { ...process.env, Z: "0" };
				delete env.EIGHT_SEATBELT;
				const r = spawnSync(
					"bun",
					[
						`--config=${emptyBunfig()}`,
						"-e",
						"process.stdout.write(process.env.EIGHT_SEATBELT ?? '')",
					],
					{
						cwd: dir,
						env,
						encoding: "utf8",
					},
				);
				const live = r.stdout;
				expect(live.length).toBeGreaterThan(0);
				expect(live).not.toBe("require");
				const snap = snapshotSecurityEnv({ EIGHT_SEATBELT: live }, dotenvDeclaredKeys([file]));
				expect(snap.values.EIGHT_SEATBELT).toBeUndefined();
				expect(snap.ignored).toEqual(["EIGHT_SEATBELT"]);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("a BOM-prefixed .env that Bun loads still has its first key ignored", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-env-")));
		try {
			const file = path.join(dir, ".env");
			fs.writeFileSync(file, "\uFEFFEIGHT_SEATBELT=0\n");
			const env = { ...process.env };
			delete env.EIGHT_SEATBELT;
			const r = spawnSync(
				"bun",
				[
					`--config=${emptyBunfig()}`,
					"-e",
					"process.stdout.write(process.env.EIGHT_SEATBELT ?? '')",
				],
				{
					cwd: dir,
					env,
					encoding: "utf8",
				},
			);
			// Bun itself loads it, so the key reaches the environment.
			expect(r.stdout).toBe("0");
			expect(dotenvDeclaredKeys([file]).has("EIGHT_SEATBELT")).toBe(true);
			const snap = snapshotSecurityEnv({ EIGHT_SEATBELT: r.stdout }, dotenvDeclaredKeys([file]));
			expect(snap.values.EIGHT_SEATBELT).toBeUndefined();
			expect(snap.ignored).toEqual(["EIGHT_SEATBELT"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("dotenv keys are parsed, with and without export", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-env-")));
		try {
			fs.writeFileSync(
				path.join(dir, ".env"),
				'# c\nEIGHT_SEATBELT=0\n export NODE_ENV="test"\nX = 1\n',
			);
			const keys = dotenvDeclaredKeys([path.join(dir, ".env"), path.join(dir, "missing")]);
			expect([...keys].sort()).toEqual(["EIGHT_SEATBELT", "NODE_ENV", "X"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("EIGHT_FAKE_HOME needs test mode, and test mode cannot come from .env", () => {
		expect(isTestMode({ NODE_ENV: "test" })).toBe(true);
		expect(isTestMode({ BUN_ENV: "test" })).toBe(true);
		expect(isTestMode({ NODE_ENV: "production" })).toBe(false);
		const fromDotenv = snapshotSecurityEnv(
			{ NODE_ENV: "test", EIGHT_FAKE_HOME: "/x" },
			new Set(["NODE_ENV"]),
		);
		expect(isTestMode(fromDotenv.values)).toBe(false);
	});
});

describe("seatbelt profile", () => {
	const p = {
		roots: ["/h/.8gent"],
		files: ["/h/.8gent/hooks.yaml"],
		dirs: ["/h/.8gent/extensions"],
	};

	test("allow-default with write, link and root denies; reads untouched", () => {
		const profile = buildRunCommandProfile(p);
		expect(profile).toContain("(allow default)");
		expect(profile).toContain('(literal "/h/.8gent/hooks.yaml")');
		expect(profile).toContain('(subpath "/h/.8gent/extensions")');
		expect(profile).toMatch(/\(deny file-write\* file-link /);
		expect(profile).toContain('(deny file-write* (literal "/h/.8gent")');
		expect(profile).not.toContain("file-read");
		// Denies come after (allow default): in SBPL the last match wins.
		expect(profile.indexOf("(deny")).toBeGreaterThan(profile.indexOf("(allow default)"));
	});

	test("case-insensitive regex so HOOKS.YAML on APFS is the same denial", () => {
		expect(caseInsensitivePathRegex("/h/.8gent/hooks.yaml", false)).toBe(
			'#"^/[hH]/\\.8[gG][eE][nN][tT]/[hH][oO][oO][kK][sS]\\.[yY][aA][mM][lL]$"',
		);
		expect(caseInsensitivePathRegex("/a/x", true)).toBe('#"^/[aA]/[xX](/.*)?$"');
		const re = new RegExp(caseInsensitivePathRegex("/h/.8gent/extensions", true)!.slice(2, -1));
		expect(re.test("/h/.8GENT/Extensions/x.ts")).toBe(true);
		expect(re.test("/h/.8gent/extensionsX/x.ts")).toBe(false);
		expect(re.test("/h/x8gent/extensions")).toBe(false);
	});

	test.if(fs.existsSync("/usr/bin/sandbox-exec"))("compiles under sandbox-exec", () => {
		const r = spawnSync(
			"/usr/bin/sandbox-exec",
			["-p", buildRunCommandProfile(), "/usr/bin/true"],
			{
				encoding: "utf8",
			},
		);
		// 0: applied. 71 with sandbox_apply: parsed, but the host already sandboxes us.
		const parsed = r.status === 0 || (r.status === 71 && r.stderr.includes("sandbox_apply"));
		if (!parsed) console.error(r.stderr);
		expect(parsed).toBe(true);
	});
});

describe("wrapping", () => {
	test("EIGHT_SEATBELT=0 leaves the command unwrapped", () => {
		withEnv({ EIGHT_SEATBELT: "0" }, () => {
			expect(wrapRunCommand("echo hi")).toBe("echo hi");
			expect(runCommandSandboxStatus()).toEqual({
				applied: false,
				reason: "EIGHT_SEATBELT=0",
				required: false,
			});
		});
	});

	test("unwrapped exactly when no boundary applies, and says why", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-wrap-")));
		try {
			withEnv({ EIGHT_FAKE_HOME: home, EIGHT_SEATBELT: undefined }, () => {
				const s = runCommandSandboxStatus();
				if (s.applied) expect(wrapRunCommand("echo hi")).not.toBe("echo hi");
				else {
					expect(wrapRunCommand("echo hi")).toBe("echo hi");
					expect(s.reason.length).toBeGreaterThan(0);
				}
			});
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("an unwrapped run is reported: listener and audit line", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-audit-")));
		try {
			withEnv(
				{
					EIGHT_FAKE_HOME: home,
					EIGHT_SEATBELT: "0",
					EIGHT_DATA_DIR: undefined,
					EIGHT_HOME: undefined,
				},
				() => {
					const seen: string[] = [];
					const off = onRunCommandUnsandboxed((s) => seen.push(s.reason));
					wrapRunCommand("echo audited");
					off();
					expect(seen).toEqual(["EIGHT_SEATBELT=0"]);
					const line = fs.readFileSync(
						path.join(home, ".8gent", "audit", "run-command-sandbox.jsonl"),
						"utf8",
					);
					expect(JSON.parse(line.trim())).toMatchObject({
						event: "run_command_unsandboxed",
						command: "echo audited",
					});
				},
			);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("EIGHT_SEATBELT=require refuses to run unwrapped, including background_start", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-req-")));
		try {
			withEnv({ EIGHT_FAKE_HOME: home, EIGHT_SEATBELT: "require" }, () => {
				const s = runCommandSandboxStatus();
				if (s.applied) {
					expect(runCommandSandboxRefusal()).toBeUndefined();
					return;
				}
				expect(s.required).toBe(true);
				expect(runCommandSandboxRefusal()).toContain("EIGHT_SEATBELT=require");
				expect(() => wrapRunCommand("echo hi")).toThrow(RunCommandSandboxRequired);
				expect(() => new BackgroundTaskManager(home).startTask("echo hi")).toThrow(
					RunCommandSandboxRequired,
				);
			});
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("argv form: no shell, wrapped exactly when a boundary applies (#3998 git/gh tools)", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-argv-")));
		try {
			withEnv(
				{
					EIGHT_FAKE_HOME: home,
					EIGHT_SEATBELT: undefined,
					EIGHT_DATA_DIR: undefined,
					EIGHT_HOME: undefined,
				},
				() => {
					const s = runCommandSandboxStatus();
					const argv = wrapRunCommandArgv("git", ["status", "x; y"]);
					expect(argv.slice(-3)).toEqual(["git", "status", "x; y"]);
					expect(argv).not.toContain("/bin/sh");
					expect(argv).not.toContain("-c");
					if (!s.applied) expect(argv).toEqual(["git", "status", "x; y"]);
					else if (s.mechanism === "seatbelt") {
						expect(argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
						expect(argv[2]).toBe(buildRunCommandProfile());
					} else expect(path.basename(argv[0] as string)).toBe("bwrap");
				},
			);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("argv form: an unwrapped run is reported like the shell form", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-argv-audit-")));
		try {
			withEnv(
				{
					EIGHT_FAKE_HOME: home,
					EIGHT_SEATBELT: "0",
					EIGHT_DATA_DIR: undefined,
					EIGHT_HOME: undefined,
				},
				() => {
					const seen: string[] = [];
					const off = onRunCommandUnsandboxed((s) => seen.push(s.reason));
					expect(wrapRunCommandArgv("git", ["status"])).toEqual(["git", "status"]);
					off();
					expect(seen).toEqual(["EIGHT_SEATBELT=0"]);
					const line = fs.readFileSync(
						path.join(home, ".8gent", "audit", "run-command-sandbox.jsonl"),
						"utf8",
					);
					expect(JSON.parse(line.trim())).toMatchObject({
						event: "run_command_unsandboxed",
						command: "git status",
					});
				},
			);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("argv form: EIGHT_SEATBELT=require refuses to run unwrapped", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-argv-req-")));
		try {
			withEnv({ EIGHT_FAKE_HOME: home, EIGHT_SEATBELT: "require" }, () => {
				if (runCommandSandboxStatus().applied) {
					expect(wrapRunCommandArgv("git", ["status"]).slice(-2)).toEqual(["git", "status"]);
					return;
				}
				expect(() => wrapRunCommandArgv("git", ["status"])).toThrow(RunCommandSandboxRequired);
			});
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("the footer reason is a short code", () => {
		expect(
			sandboxFooterReason("host already sandboxes this process (sandbox-exec cannot nest)"),
		).toBe("nested");
		expect(sandboxFooterReason("EIGHT_SEATBELT=0")).toBe("turned off");
		expect(sandboxFooterReason("bwrap not installed")).toBe("no bwrap");
		expect(sandboxFooterReason("no OS sandbox on win32")).toBe("unsupported OS");
		expect(sandboxFooterReason("something new and rather long").length).toBeLessThanOrEqual(16);
	});

	test("secrets/ is read-denied: seatbelt profile text and bwrap tmpfs (#4594)", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-sec-")));
		const sec = path.join(home, ".8gent", "secrets");
		fs.mkdirSync(sec, { recursive: true });
		try {
			const paths = { roots: [], files: [], dirs: [sec] };
			expect(buildRunCommandProfile(paths)).toContain(
				`(deny file-read* (literal "${sec}") (subpath "${sec}")`,
			);
			const args = buildBwrapArgs(paths);
			expect(args).toEqual(["--dev-bind", "/", "/", "--ro-bind", sec, sec, "--tmpfs", sec]);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test("bwrap args bind only protected paths that exist, read-only", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-bw-")));
		fs.mkdirSync(path.join(home, ".8gent", "extensions"), { recursive: true });
		try {
			const ext = path.join(home, ".8gent", "extensions");
			const args = buildBwrapArgs({
				roots: [],
				files: [path.join(home, ".8gent", "hooks.yaml")],
				dirs: [ext],
			});
			expect(args).toEqual(["--dev-bind", "/", "/", "--ro-bind", ext, ext]);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

// ============================================
// Live enforcement (macOS, outside any host sandbox)
// ============================================

describe.if(process.env.EIGHT_SEATBELT !== "0" && canApplySeatbelt())(
	"run_command seatbelt, live",
	() => {
		let home = "";
		let dot = "";
		let proj = "";
		const saved = {
			EIGHT_FAKE_HOME: process.env.EIGHT_FAKE_HOME,
			EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
			EIGHT_HOME: process.env.EIGHT_HOME,
		};

		/** Hash of every protected file and tree, plus the listing of the root. */
		function snapshot(): string {
			const h = crypto.createHash("sha256");
			const walk = (p: string) => {
				let st: fs.Stats;
				try {
					st = fs.lstatSync(p);
				} catch {
					h.update(`${p}:absent\n`);
					return;
				}
				// mode, mtime, BSD flags (chflags) and xattrs, not just content.
				const flags = spawnSync("stat", ["-f", "%f", p], { encoding: "utf8" }).stdout;
				const xattrs = spawnSync("xattr", ["-l", "-s", p], { encoding: "utf8" }).stdout;
				h.update(
					`${p}:${st.mode}:${st.mtimeMs}:${st.ino}:${st.nlink}:${flags}:${xattrs}:${st.isSymbolicLink() ? fs.readlinkSync(p) : ""}\n`,
				);
				if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
				else if (st.isFile()) h.update(fs.readFileSync(p));
			};
			h.update(fs.readdirSync(dot).sort().join(","));
			for (const f of PROTECTED_DATA_FILES) walk(path.join(dot, f));
			for (const d of PROTECTED_DATA_DIRS) walk(path.join(dot, d));
			return h.digest("hex");
		}

		beforeAll(() => {
			home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcs-live-home-")));
			dot = path.join(home, ".8gent");
			proj = path.join(home, "proj");
			process.env.EIGHT_FAKE_HOME = home;
			Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
			Reflect.deleteProperty(process.env, "EIGHT_HOME");
			refreshSecurityEnvForTests();
			fs.mkdirSync(proj, { recursive: true });
			for (const d of PROTECTED_DATA_DIRS) fs.mkdirSync(path.join(dot, d), { recursive: true });
			for (const f of PROTECTED_DATA_FILES) fs.writeFileSync(path.join(dot, f), `original ${f}\n`);
			fs.writeFileSync(path.join(dot, "extensions", "real.ts"), "export {};\n");
			// The extensions dir is a git repo with a dirty file, so `git checkout -- .` would write.
			spawnSync("git", ["init", "-q"], { cwd: path.join(dot, "extensions") });
			spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
				cwd: path.join(dot, "extensions"),
			});
			spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], {
				cwd: path.join(dot, "extensions"),
			});
			fs.writeFileSync(path.join(dot, "extensions", "real.ts"), "export {}; // local\n");
			// Workspace fixtures the PoC commands use.
			fs.writeFileSync(path.join(proj, "x.ts"), "evil();\n");
			fs.mkdirSync(path.join(proj, "payload", ".8gent", "extensions"), { recursive: true });
			fs.writeFileSync(path.join(proj, "payload", ".8gent", "extensions", "evil.ts"), "evil();\n");
			fs.writeFileSync(path.join(proj, "payload", ".8gent", "hooks.yaml"), "evil: true\n");
			spawnSync("tar", ["-czf", "payload.tgz", "-C", "payload", ".8gent"], { cwd: proj });
			fs.symlinkSync(dot, path.join(proj, "link8"));
			fs.symlinkSync(path.join(dot, "extensions"), path.join(proj, "linkext"));
			fs.mkdirSync(path.join(proj, "evil8gent", "extensions"), { recursive: true });
			fs.writeFileSync(path.join(proj, "evil8gent", "hooks.yaml"), "evil: true\n");
			fs.writeFileSync(path.join(proj, "step1.sh"), "echo x > ~/.8gent/hooks.yaml\n");
			fs.writeFileSync(path.join(dot, "bin", "tool"), "#!/bin/sh\necho real\n");
		});

		afterAll(() => {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) Reflect.deleteProperty(process.env, k);
				else process.env[k] = v;
			}
			refreshSecurityEnvForTests();
			if (home) {
				// A chflags uchg that got through would make the cleanup fail too.
				spawnSync("chflags", ["-R", "nouchg", home]);
				fs.rmSync(home, { recursive: true, force: true });
			}
		});

		const run = (cmd: string) =>
			spawnSync("/bin/sh", ["-c", wrapRunCommand(cmd)], {
				cwd: proj,
				encoding: "utf8",
				input: "x\n",
				env: { ...process.env, HOME: home, EIGHT_FAKE_HOME: home },
				timeout: 20_000,
			});

		// The 12 bypass commands from the 8SO F2 PoC (poc-guard.ts), verbatim, then
		// the suspected ones from the same file that run without a network.
		const POC_12 = [
			"cd ~/.8gent && cat > hooks.yaml",
			"cat <<EOF > ~/.8gent/hooks.yaml\nx\nEOF",
			"install -m 755 x.ts ~/.8gent/extensions/",
			"rsync -a x.ts ~/.8gent/extensions/",
			"git -C ~/.8gent/extensions checkout -- .",
			"tar -xzf payload.tgz -C ~/.8gent/extensions",
			`python3 -c "open('$HOME/.8gent/extensions/x.ts','w').write('x')"`,
			`node -e "require('fs').writeFileSync(require('os').homedir()+'/.8gent/extensions/x.ts','x')"`,
			"cat > link8/extensions/x.ts",
			"echo x > linkext/x.ts",
			"ln -s /tmp/evil ~/.8gent/extensions/x.ts",
			"cd ~ && cd .8gent && cd extensions && touch x.ts",
		];
		const MORE = [
			`python3 -c "import os;open(os.path.join(os.path.expanduser('~'),'.8gent','extensions','x.ts'),'w').write('x')"`,
			"tar -xzf payload.tgz -C ~",
			"cp -R payload/. ~/",
			"mv ~/.8gent ~/.8gent.bak && mv ./evil8gent ~/.8gent",
			"printf x > $(echo ~)/.8gent/hooks.yaml",
			"D=.8; cat > ~/${D}gent/hooks.yaml",
			"echo ZWNobyB4ID4gfi8uOGdlbnQvaG9va3MueWFtbA== | base64 -d | sh",
			"sh ./step1.sh",
			"echo x > ~/.8GENT/HOOKS.YAML",
			"mkdir -p ~/.8gent/Prompts/new && echo x > ~/.8gent/Prompts/new/a.md",
			"ln ~/.8gent/settings.json ./hard && echo x > ./hard",
			"chmod 777 ~/.8gent/hooks.yaml",
			"rm -rf ~/.8gent/sessions",
			"echo x >> ~/.8gent/audit.jsonl",
			"echo x > ~/.8gent/browser-profiles/work.token",
			"mv ~/.8gent/extensions ~/.8gent/ext-old",
			"echo x > ~/.8gent/bin/tool",
			"echo x > ~/.8gent/bin/new-tool",
			"echo EIGHT_SEATBELT=0 >> ~/.8gent/.env",
			"echo x > ~/.8gent/keys.env",
			'echo \'{"allow":["127.0.0.1:5173"]}\' > ~/.8gent/allow-loopback.json',
			"echo '{}' > ~/.8gent/mcp.json",
			"echo x > ~/.8gent/policies.yaml",
			"echo x > ~/.8gent/policy-checksum",
			`echo '{"retro":"${"0".repeat(64)}"}' > ~/.8gent/skills-trust.json`,
		];
		// Karen's (8SO) live probe on #4013: metadata, flags, replace-by-rename, forced link, clone, root move.
		const KAREN = [
			"xattr -w com.evil x ~/.8gent/hooks.yaml",
			"touch -t 200001010000 ~/.8gent/hooks.yaml",
			"chflags uchg ~/.8gent/hooks.yaml",
			"echo evil > ./h && mv -f ./h ~/.8gent/hooks.yaml",
			"ln -f ./x.ts ~/.8gent/hooks.yaml",
			"cp -c ./x.ts ~/.8gent/hooks.yaml",
			"cp -c ./x.ts ~/.8gent/extensions/clone.ts",
			"mv ~/.8gent ./moved-8gent",
		];

		for (const cmd of [...POC_12, ...MORE, ...KAREN]) {
			test(`denied: ${JSON.stringify(cmd).slice(0, 90)}`, () => {
				const before = snapshot();
				run(cmd);
				expect(snapshot()).toBe(before);
				expect(fs.existsSync(path.join(dot, "extensions", "x.ts"))).toBe(false);
			});
		}

		test("allowed: workspace writes, reads of protected files, other ~/.8gent files", () => {
			const r = run(
				"echo ok > ./made.txt && cat ~/.8gent/hooks.yaml && echo ok > ~/.8gent/other.txt",
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("original hooks.yaml");
			expect(fs.readFileSync(path.join(proj, "made.txt"), "utf8")).toBe("ok\n");
			expect(fs.readFileSync(path.join(dot, "other.txt"), "utf8")).toBe("ok\n");
		});

		test("~/.8gent/bin is NOT writable, but runs", () => {
			const r = run("echo ok > ~/.8gent/bin/tool; sh ~/.8gent/bin/tool");
			expect(r.stdout).toContain("real");
			expect(fs.readFileSync(path.join(dot, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho real\n");
		});
	},
);

test("update-resume.json (the /update relaunch record) is a protected data file", () => {
	expect(PROTECTED_DATA_FILES).toContain("update-resume.json");
});

test("skills-trust.json (#4125 project skill pins) is protected and denied by the profile", () => {
	expect(PROTECTED_DATA_FILES).toContain("skills-trust.json");
	withEnv(
		{ EIGHT_FAKE_HOME: "/nonexistent-h", EIGHT_DATA_DIR: undefined, EIGHT_HOME: undefined },
		() => {
			const p = protectedRunCommandPaths();
			const file = path.join(H, "skills-trust.json");
			expect(p.files).toContain(file);
			expect(buildRunCommandProfile(p)).toContain(file);
		},
	);
});
