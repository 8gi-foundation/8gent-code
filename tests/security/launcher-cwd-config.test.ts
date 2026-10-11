/**
 * The npm launcher (bin/8gent-run.js) must not let the user's working
 * directory steer Bun (#4013, 8SO): a workspace bunfig.toml `preload` would run
 * code before 8gent snapshots its security env, and a workspace .env would set
 * EIGHT_SEATBELT=0 for it. Every launcher passes --no-env-file and an empty
 * --config, or is shown never to run from a user cwd:
 *
 *   bin/8gent-run.js (npm "bin")      flags, end to end
 *   bin/8gent-cli.sh (both branches)  flags, end to end
 *   bun shebang entry points          `env -S bun --no-env-file --config=/dev/null`
 *   spawned children (TUI, daemon service argv, worktree pool, adapters, /debug)
 *                                     safeBunFlags(), end to end + source check
 *   package.json scripts              run from the package root (proven) and --config
 *   compiled binaries                 built with config autoload off
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeBunFlags } from "../../packages/core/bun-flags";

const REPO = path.resolve(import.meta.dirname, "../..");

describe("bin/8gent-run.js", () => {
	test("a cwd bunfig preload and a cwd .env are not loaded", () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-cwd-")));
		try {
			const pkg = path.join(root, "pkg");
			fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
			fs.mkdirSync(path.join(pkg, "dist"));
			fs.copyFileSync(path.join(REPO, "bin", "8gent-run.js"), path.join(pkg, "bin", "8gent-run.js"));
			fs.copyFileSync(path.join(REPO, "bin", "bunfig.empty.toml"), path.join(pkg, "bin", "bunfig.empty.toml"));
			fs.writeFileSync(path.join(pkg, "package.json"), '{"type":"module"}\n');
			fs.writeFileSync(
				path.join(pkg, "dist", "cli.js"),
				'console.log(`CLI seatbelt=${process.env.EIGHT_SEATBELT ?? "unset"} preload=${globalThis.__evilPreload ? "ran" : "no"}`);\n',
			);

			const ws = path.join(root, "workspace");
			fs.mkdirSync(ws);
			fs.writeFileSync(path.join(ws, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
			fs.writeFileSync(path.join(ws, "evil.ts"), "globalThis.__evilPreload = true;\nconsole.log('EVIL PRELOAD');\n");
			fs.writeFileSync(path.join(ws, ".env"), "EIGHT_SEATBELT=0\n");

			const env = { ...process.env };
			delete env.EIGHT_SEATBELT;
			const r = spawnSync("node", [path.join(pkg, "bin", "8gent-run.js")], { cwd: ws, env, encoding: "utf8" });
			expect(r.stdout).toContain("CLI seatbelt=unset preload=no");
			expect(r.stdout).not.toContain("EVIL PRELOAD");

			// Control: plain `bun` from that cwd does load both, so the test can fail.
			const control = spawnSync("bun", [path.join(pkg, "dist", "cli.js")], { cwd: ws, env, encoding: "utf8" });
			expect(control.stdout).toContain("EVIL PRELOAD");
			expect(control.stdout).toContain("seatbelt=0");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

/** A workspace that would run code and set EIGHT_SEATBELT=0 in any Bun started inside it. */
function hostileWorkspace(root: string): string {
	const ws = path.join(root, "workspace");
	fs.mkdirSync(ws, { recursive: true });
	fs.writeFileSync(path.join(ws, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
	fs.writeFileSync(path.join(ws, "evil.ts"), "globalThis.__evilPreload = true;\nconsole.log('EVIL PRELOAD');\n");
	fs.writeFileSync(path.join(ws, ".env"), "EIGHT_SEATBELT=0\n");
	return ws;
}
const PROBE =
	'console.log(`PROBE seatbelt=${process.env.EIGHT_SEATBELT ?? "unset"} preload=${globalThis.__evilPreload ? "ran" : "no"}`);\n';
const CLEAN = "PROBE seatbelt=unset preload=no";
function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.EIGHT_SEATBELT;
	return env;
}
function withRoot(fn: (root: string) => void) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-cwd-")));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
const posix = process.platform !== "win32";

describe.if(posix)("bin/8gent-cli.sh", () => {
	for (const branch of [[], ["run"]] as string[][]) {
		test(`8gent-cli.sh ${branch.join(" ") || "(tui)"}: no cwd bunfig preload, no cwd .env`, () => {
			withRoot((root) => {
				const pkg = path.join(root, "pkg");
				fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
				fs.mkdirSync(path.join(pkg, "apps", "tui", "src"), { recursive: true });
				fs.copyFileSync(path.join(REPO, "bin", "8gent-cli.sh"), path.join(pkg, "bin", "8gent-cli.sh"));
				fs.copyFileSync(path.join(REPO, "bin", "bunfig.empty.toml"), path.join(pkg, "bin", "bunfig.empty.toml"));
				fs.writeFileSync(path.join(pkg, "bin", "8gent.ts"), PROBE);
				fs.writeFileSync(path.join(pkg, "apps", "tui", "src", "index.tsx"), PROBE);
				const ws = hostileWorkspace(root);
				const r = spawnSync("bash", [path.join(pkg, "bin", "8gent-cli.sh"), ...branch], {
					cwd: ws,
					env: cleanEnv(),
					encoding: "utf8",
				});
				expect(r.stdout).toContain(CLEAN);
				expect(r.stdout).not.toContain("EVIL PRELOAD");
			});
		});
	}
});

describe("spawned Bun children", () => {
	test.if(posix)("safeBunFlags() keeps a cwd bunfig preload and .env out, with and without `run`", () => {
		withRoot((root) => {
			const script = path.join(root, "probe.ts");
			fs.writeFileSync(script, PROBE);
			const ws = hostileWorkspace(root);
			for (const argv of [[...safeBunFlags(), script], [...safeBunFlags(), "run", script]]) {
				const r = spawnSync("bun", argv, { cwd: ws, env: cleanEnv(), encoding: "utf8" });
				expect(r.stdout).toContain(CLEAN);
			}
		});
	});

	test("Windows gets the shipped empty bunfig, POSIX /dev/null", () => {
		expect(safeBunFlags("darwin")).toEqual(["--no-env-file", "--config=/dev/null"]);
		const win = safeBunFlags("win32")[1] as string;
		expect(win.startsWith("--config=")).toBe(true);
		expect(fs.readFileSync(win.slice("--config=".length), "utf8").replace(/^#.*$/gm, "").trim()).toBe("");
	});

	// Each site that starts Bun from a workspace or $HOME passes the flags.
	const SITES: [string, RegExp][] = [
		["bin/8gent.ts", /spawn\("bun", \[\.\.\.safeBunFlags\(\), "run", tuiPath/],
		["bin/8gent.ts", /\[\.\.\.safeBunFlags\(\), fileURLToPath\(import\.meta\.url\)\]/],
		["packages/orchestration/worktree-pool-agent.ts", /spawn\("bun", \[\.\.\.safeBunFlags\(\), "run"/],
		["packages/orchestration/agent-adapters.ts", /\[\.\.\.safeBunFlags\(\), "run", "bin\/8gent\.ts"/],
		["apps/tui/src/app.tsx", /\["bun", \.\.\.safeBunFlags\(\), "run", debugScript/],
		// benchmark and demo run in the checkout root (cwd: root), keep its .env, drop any bunfig.
		["bin/8gent.ts", /spawn\("bun", \[`--config=\$\{emptyBunfig\(\)\}`, "run", benchmarkPath/],
		["bin/8gent.ts", /spawn\("bun", \[`--config=\$\{emptyBunfig\(\)\}`, "run", demoPath/],
	];
	for (const [file, re] of SITES) {
		test(`${file} passes safeBunFlags() (${re.source.slice(0, 40)})`, () => {
			expect(fs.readFileSync(path.join(REPO, file), "utf8")).toMatch(re);
		});
	}

	test("no bare `bun run` spawn is left in those files", () => {
		for (const file of new Set(SITES.map(([f]) => f))) {
			const src = fs.readFileSync(path.join(REPO, file), "utf8");
			expect(src).not.toMatch(/spawn(Sync)?\(\s*\[?\s*"bun",\s*\[?\s*"run"/);
		}
	});
});

describe("bun shebang entry points", () => {
	const SAFE = "#!/usr/bin/env -S bun --no-env-file --config=/dev/null";
	const ENTRIES = [
		"bin/8gent.ts",
		"bin/debug.ts",
		"apps/tui/src/index.tsx",
		"packages/daemon/scripts/start-local.ts",
		"apps/8gent-eyes/src/index.ts",
		"apps/8gent-flow/src/index.ts",
		"apps/proxy/src/index.ts",
		"packages/g8way/bin/g8way.ts",
		"packages/harness-cli/index.ts",
	];
	for (const file of ENTRIES) {
		test(`${file} uses the safe shebang`, () => {
			expect(fs.readFileSync(path.join(REPO, file), "utf8").split("\n")[0]).toBe(SAFE);
		});
	}

	test("build-finalize writes the safe shebang into dist/cli.js", () => {
		expect(fs.readFileSync(path.join(REPO, "scripts", "build-finalize.js"), "utf8")).toContain(SAFE);
	});

	test.if(posix)("that shebang, executed from a hostile workspace, loads neither", () => {
		withRoot((root) => {
			const script = path.join(root, "entry.ts");
			fs.writeFileSync(script, `${SAFE}\n${PROBE}`, { mode: 0o755 });
			const r = spawnSync(script, [], { cwd: hostileWorkspace(root), env: cleanEnv(), encoding: "utf8" });
			expect(r.stdout).toContain(CLEAN);
		});
	});
});

describe("package.json entry points", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

	test("every npm bin is the launcher, and the empty bunfig ships", () => {
		for (const target of Object.values(pkg.bin)) expect(target).toBe("./bin/8gent-run.js");
		expect(pkg.files).toContain("bin/bunfig.empty.toml");
	});

	test("user-run scripts pass the empty --config", () => {
		for (const name of ["start", "agent", "daemon", "daemon:local", "tui"])
			expect(pkg.scripts[name]).toMatch(/^bun --config=bin\/bunfig\.empty\.toml run /);
	});

	test("`bun run <script>` runs in the package root, never the user's cwd", () => {
		withRoot((root) => {
			fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"where":"pwd"}}\n');
			fs.mkdirSync(path.join(root, "deep", "sub"), { recursive: true });
			const r = spawnSync("bun", ["run", "where"], { cwd: path.join(root, "deep", "sub"), encoding: "utf8" });
			expect(r.stdout.trim().split("\n").pop()).toBe(root);
		});
	});

	test("compiled binaries are built with bunfig and .env autoload off", () => {
		const src = fs.readFileSync(path.join(REPO, "scripts", "build-binaries.ts"), "utf8");
		expect(src).toContain('"--no-compile-autoload-bunfig"');
		expect(src).toContain('"--no-compile-autoload-dotenv"');
	});
});
