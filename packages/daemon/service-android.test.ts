import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	ANDROID_FOREGROUND_COMMAND,
	type ServiceContext,
	daemonCommand,
	hostContext,
	parseStatus,
	planFor,
	runOperation,
	servicePlatform,
	serviceStatus,
	termuxRunScript,
} from "./service";

const PREFIX = "/data/data/com.termux/files/usr";
const termux: ServiceContext = {
	platform: "android",
	home: "/data/data/com.termux/files/home",
	program: [
		`${PREFIX}/bin/node`,
		`${PREFIX}/lib/node_modules/@8gi-foundation/8gent-code/bin/8gent-run.js`,
		"daemon",
		"run",
	],
	uid: 10245,
	user: "u0_a245",
	prefix: PREFIX,
};
const SV_DIR = `${PREFIX}/var/service/com.8gent.daemon`;

describe("platform gate", () => {
	test("android is a supported service platform, by platform name or by Termux markers", () => {
		expect(servicePlatform("android", {})).toBe("android");
		expect(servicePlatform("linux", { TERMUX_VERSION: "0.118.3" })).toBe("android");
		expect(servicePlatform("linux", { PREFIX: PREFIX })).toBe("android");
	});
	test("the three desktop platforms are unchanged, and a plain Linux box is not Termux", () => {
		expect(servicePlatform("darwin", {})).toBe("darwin");
		expect(servicePlatform("win32", {})).toBe("win32");
		expect(servicePlatform("linux", { PREFIX: "/usr" })).toBe("linux");
		expect(servicePlatform("linux", {})).toBe("linux");
	});
	test("every other platform is refused", () => {
		for (const p of ["freebsd", "aix", "sunos", "openbsd"])
			expect(servicePlatform(p, {})).toBeNull();
	});
});

describe("hostContext on Termux", () => {
	const keys = ["TERMUX_VERSION", "PREFIX", "HOME"] as const;
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of keys) saved[k] = process.env[k];
	});
	afterEach(() => {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});
	test("takes HOME and PREFIX from the environment, not the passwd entry", () => {
		process.env.TERMUX_VERSION = "0.118.3";
		process.env.PREFIX = PREFIX;
		process.env.HOME = "/data/data/com.termux/files/home";
		const ctx = hostContext(["node", "cli.js", "daemon", "run"]);
		expect(ctx.platform).toBe("android");
		expect(ctx.home).toBe("/data/data/com.termux/files/home");
		expect(ctx.prefix).toBe(PREFIX);
	});
});

describe("termux-services plan", () => {
	test("run script: cd home, exec the program, console to a log, every word single-quoted", () => {
		const s = termuxRunScript({
			...termux,
			program: ["/p/node", "/a b/cli.js", "it's", "daemon", "run"],
		});
		expect(s).toBe(`#!${PREFIX}/bin/sh
cd '/data/data/com.termux/files/home' || exit 1
exec '/p/node' '/a b/cli.js' 'it'\\''s' 'daemon' 'run' >>'/data/data/com.termux/files/home/.8gent/daemon-console.log' 2>&1
`);
	});

	test("install writes an executable run script under $PREFIX/var/service, drops any down file, then sv up", () => {
		const steps = planFor("install", termux);
		expect(steps).toContainEqual({ kind: "mkdir", path: SV_DIR });
		const write = steps.find((s) => s.kind === "write");
		expect(write).toMatchObject({
			path: `${SV_DIR}/run`,
			mode: 0o755,
			contents: termuxRunScript(termux),
		});
		expect(steps).toContainEqual({ kind: "remove", path: `${SV_DIR}/down` });
		const up = steps.find((s) => s.kind === "run");
		expect(up).toMatchObject({ argv: ["sv", "up", "com.8gent.daemon"] });
		// A missing supervisor is a warning that says the daemon is NOT running, never an abort or a false OK.
		expect((up as { onFailure: { warn: string } }).onFailure.warn).toContain("NOT running");
		expect((up as { onFailure: { warn: string } }).onFailure.warn).toContain(
			ANDROID_FOREGROUND_COMMAND,
		);
	});

	test("start, stop and uninstall are sv up, sv down, and down-then-remove", () => {
		expect(planFor("start", termux)).toEqual([
			{ kind: "run", argv: ["sv", "up", "com.8gent.daemon"], onFailure: "abort" },
		]);
		expect(planFor("stop", termux)).toEqual([
			{ kind: "run", argv: ["sv", "down", "com.8gent.daemon"], onFailure: "abort" },
		]);
		const un = planFor("uninstall", termux);
		expect(un[0]).toMatchObject({ argv: ["sv", "down", "com.8gent.daemon"], onFailure: "ignore" });
		expect(un[1]).toEqual({ kind: "remove", path: SV_DIR });
	});

	test("sv status lines map to states", () => {
		const r = (stdout: string) => ({ code: 0, stdout });
		expect(
			parseStatus("android", r(`run: ${SV_DIR}: (pid 4242) 31s; run: log: (pid 4243) 31s`), true),
		).toEqual({ state: "running", pid: 4242 });
		expect(parseStatus("android", r(`down: ${SV_DIR}: 9s, normally up`), true)).toEqual({
			state: "stopped",
		});
		expect(
			parseStatus("android", r(`fail: ${SV_DIR}: unable to change to service directory`), false),
		).toEqual({ state: "not-installed" });
		// runsv not up yet for a service that is installed: stopped, never "running".
		expect(parseStatus("android", r("fail: x: runsv not running"), true)).toEqual({
			state: "stopped",
		});
	});
});

describe("without termux-services", () => {
	let savedPath: string | undefined;
	let empty: string;
	beforeEach(() => {
		savedPath = process.env.PATH;
		empty = mkdtempSync(path.join(tmpdir(), "no-sv-"));
		// sh must resolve, sv must not
		process.env.PATH = `/bin:/usr/bin:${empty}`;
	});
	afterEach(() => {
		process.env.PATH = savedPath;
		rmSync(empty, { recursive: true, force: true });
	});

	test.skipIf(existsSync("/bin/sv") || existsSync("/usr/bin/sv"))(
		"install, start, stop and status say there is no background service and print the one command",
		async () => {
			for (const op of ["install", "start", "stop"] as const) {
				const err = await runOperation(op, termux).then(
					() => null,
					(e: Error) => e,
				);
				expect(err, op).not.toBeNull();
				expect((err as Error).message).toContain("No background service here");
				expect((err as Error).message).toContain(`run: ${ANDROID_FOREGROUND_COMMAND}`);
			}
			const st = await serviceStatus(termux);
			expect(st.state).toBe("unavailable");
		},
	);

	test.skipIf(existsSync("/bin/sv") || existsSync("/usr/bin/sv"))(
		"`8gent daemon install` exits 1 and does not write a service directory",
		async () => {
			const prefix = mkdtempSync(path.join(tmpdir(), "prefix-"));
			const saved = { ...process.env };
			process.env.TERMUX_VERSION = "0.118.3";
			process.env.PREFIX = prefix;
			try {
				expect(await daemonCommand(["install"], ["node", "cli.js", "daemon", "run"])).toBe(1);
				expect(existsSync(path.join(prefix, "var", "service"))).toBe(false);
			} finally {
				for (const k of ["TERMUX_VERSION", "PREFIX"]) {
					if (saved[k] === undefined) delete process.env[k];
					else process.env[k] = saved[k];
				}
				rmSync(prefix, { recursive: true, force: true });
			}
		},
	);
});

describe("with a termux-services supervisor (a fake `sv` on PATH)", () => {
	let savedPath: string | undefined;
	let root: string;
	let ctx: ServiceContext;
	let svLog: string;

	beforeEach(() => {
		savedPath = process.env.PATH;
		root = mkdtempSync(path.join(tmpdir(), "termux-"));
		const bin = path.join(root, "bin");
		mkdirSync(bin, { recursive: true });
		svLog = path.join(root, "sv.log");
		const state = path.join(root, "sv.state");
		// runit's `sv`: up/down flip a state file, status reports it in runit's own format.
		writeFileSync(
			path.join(bin, "sv"),
			`#!/bin/sh
echo "$@" >> '${svLog}'
case "$1" in
  up) echo up > '${state}' ;;
  down) echo down > '${state}' ;;
  status) if [ "$(cat '${state}' 2>/dev/null)" = up ]; then echo "run: $2: (pid 777) 1s"; else echo "down: $2: 1s"; fi ;;
esac
exit 0
`,
		);
		chmodSync(path.join(bin, "sv"), 0o755);
		process.env.PATH = `${bin}:/bin:/usr/bin`;
		ctx = { ...termux, home: path.join(root, "home"), prefix: path.join(root, "usr") };
		mkdirSync(ctx.home, { recursive: true });
	});
	afterEach(() => {
		process.env.PATH = savedPath;
		rmSync(root, { recursive: true, force: true });
	});

	test("install -> running, stop -> installed not running, start -> running, uninstall -> gone", async () => {
		const svDir = path.join(ctx.prefix as string, "var", "service", "com.8gent.daemon");
		expect((await serviceStatus(ctx)).state).toBe("not-installed");

		await runOperation("install", ctx, () => {});
		const run = path.join(svDir, "run");
		expect(statSync(run).mode & 0o777).toBe(0o755);
		expect(readFileSync(run, "utf8")).toBe(termuxRunScript(ctx));
		expect(await serviceStatus(ctx)).toEqual({ state: "running", pid: 777 });

		await runOperation("stop", ctx, () => {});
		expect((await serviceStatus(ctx)).state).toBe("stopped");
		await runOperation("start", ctx, () => {});
		expect((await serviceStatus(ctx)).state).toBe("running");

		await runOperation("uninstall", ctx, () => {});
		expect(existsSync(svDir)).toBe(false);
		expect(readFileSync(svLog, "utf8")).toContain("up com.8gent.daemon");
	});

	test("install twice converges on one service", async () => {
		await runOperation("install", ctx, () => {});
		await runOperation("install", ctx, () => {});
		expect((await serviceStatus(ctx)).state).toBe("running");
	});

	test("stop before install is refused with the install command", async () => {
		await expect(runOperation("stop", ctx, () => {})).rejects.toThrow("8gent daemon install");
	});
});

describe("the environment cannot steer the run script or the uninstall (8SO review)", () => {
	const envKeys = ["TERMUX_VERSION", "PREFIX", "HOME"] as const;
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of envKeys) saved[k] = process.env[k];
	});
	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	test("a PREFIX or HOME that would start a new script line or argument is refused, never written", () => {
		const bad: Partial<ServiceContext>[] = [
			{ prefix: `${PREFIX}\ntouch /tmp/pwned` },
			{ prefix: `${PREFIX}\rx` },
			{ prefix: `${PREFIX} -x` },
			{ prefix: `${PREFIX}\u0000x` },
			{ prefix: "relative/usr" },
			{ home: `${termux.home}\nid` },
			{ home: "relative/home" },
		];
		for (const b of bad) {
			expect(() => termuxRunScript({ ...termux, ...b }), JSON.stringify(b)).toThrow(
				/absolute path/,
			);
		}
		// A space in HOME is fine: it is single-quoted, not a shebang.
		expect(termuxRunScript({ ...termux, home: "/data/with space/home" })).toContain(
			"cd '/data/with space/home'",
		);
		// The shebang and the cd line are the only ones that carry the paths.
		expect(termuxRunScript(termux).split("\n").length).toBe(4);
	});

	test("hostContext refuses the same values from the environment", () => {
		process.env.TERMUX_VERSION = "0.118.3";
		process.env.HOME = "/data/data/com.termux/files/home";
		process.env.PREFIX = `${PREFIX}\ntouch /tmp/pwned`;
		expect(() => hostContext(["node", "cli.js", "daemon", "run"])).toThrow(/PREFIX/);
		process.env.PREFIX = PREFIX;
		process.env.HOME = "data/home";
		expect(() => hostContext(["node", "cli.js", "daemon", "run"])).toThrow(/HOME/);
	});

	describe("uninstall removes the service directory and nothing else", () => {
		let root: string;
		beforeEach(() => {
			root = mkdtempSync(path.join(tmpdir(), "termux-rm-"));
		});
		afterEach(() => rmSync(root, { recursive: true, force: true }));
		const ctxFor = (prefix: string): ServiceContext => ({ ...termux, home: root, prefix });

		test("a service directory that is a symlink is unlinked; its target and contents stay", async () => {
			const prefix = path.join(root, "usr");
			const elsewhere = path.join(root, "elsewhere");
			mkdirSync(path.join(prefix, "var", "service"), { recursive: true });
			mkdirSync(elsewhere, { recursive: true });
			writeFileSync(path.join(elsewhere, "keep.txt"), "keep");
			const { symlinkSync } = await import("node:fs");
			symlinkSync(elsewhere, path.join(prefix, "var", "service", "com.8gent.daemon"));
			await runOperation("uninstall", ctxFor(prefix), () => {});
			expect(existsSync(path.join(prefix, "var", "service", "com.8gent.daemon"))).toBe(false);
			expect(readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
		});

		test("only the com.8gent.daemon directory goes; its siblings and parents stay", async () => {
			const prefix = path.join(root, "usr");
			const svc = path.join(prefix, "var", "service");
			mkdirSync(path.join(svc, "com.8gent.daemon", "log"), { recursive: true });
			writeFileSync(path.join(svc, "com.8gent.daemon", "run"), "x");
			mkdirSync(path.join(svc, "other-service"), { recursive: true });
			writeFileSync(path.join(svc, "other-service", "run"), "y");
			await runOperation("uninstall", ctxFor(prefix), () => {});
			expect(existsSync(path.join(svc, "com.8gent.daemon"))).toBe(false);
			expect(readFileSync(path.join(svc, "other-service", "run"), "utf8")).toBe("y");
		});

		test("every remove step in every platform plan ends in the service name, or is a single file", () => {
			for (const platform of ["darwin", "linux", "win32", "android"] as const) {
				const ctx = { ...termux, platform, home: "/h", prefix: "/p" };
				for (const step of planFor("uninstall", ctx).concat(planFor("install", ctx))) {
					if (step.kind !== "remove") continue;
					const base = path.posix.basename(step.path.replace(/\\/g, "/"));
					expect(
						["com.8gent.daemon", "down"].includes(base) || /\.(plist|service)$/.test(base),
						`${platform}: ${step.path}`,
					).toBe(true);
				}
			}
		});
	});
});
