import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	KEEP_PRELOAD,
	PRELOAD_CARRY,
	isTermux,
	nodeExecPath,
	restorePreload,
	shellWrappedSpawn,
	tuiProcessEnv,
} from "./termux-exec.js";

const LIB = "/data/data/com.termux/files/usr/lib/libtermux-exec.so";
const PREFIX = "/data/data/com.termux/files/usr";

describe("Termux detection", () => {
	test("android platform or a Termux PREFIX", () => {
		expect(isTermux({}, "android")).toBe(true);
		expect(isTermux({ PREFIX }, "linux")).toBe(true);
		expect(isTermux({ PREFIX: "/usr" }, "linux")).toBe(false);
		expect(isTermux({}, "darwin")).toBe(false);
	});
});

describe("LD_PRELOAD handoff", () => {
	test("the TUI process env drops LD_PRELOAD and carries it", () => {
		const env = tuiProcessEnv({ LD_PRELOAD: LIB, HOME: "/h" }, "android");
		expect(env.LD_PRELOAD).toBeUndefined();
		expect(env[PRELOAD_CARRY]).toBe(LIB);
		expect(env.HOME).toBe("/h");
	});

	test("unchanged off Termux, without LD_PRELOAD, or when asked to keep it", () => {
		const desktop = { LD_PRELOAD: "/x.so" };
		expect(tuiProcessEnv(desktop, "linux")).toBe(desktop);
		const none = { HOME: "/h" };
		expect(tuiProcessEnv(none, "android")).toBe(none);
		const keep = { LD_PRELOAD: LIB, [KEEP_PRELOAD]: "1" };
		expect(tuiProcessEnv(keep, "android")).toBe(keep);
	});

	test("restore puts it back and clears the carry", () => {
		const env: Record<string, string | undefined> = { [PRELOAD_CARRY]: LIB };
		expect(restorePreload(env)).toBe(true);
		expect(env.LD_PRELOAD).toBe(LIB);
		expect(env[PRELOAD_CARRY]).toBeUndefined();
		expect(restorePreload({ HOME: "/h" })).toBe(false);
	});

	test("end to end: stripped in the TUI process, present in its children", () => {
		const child = tuiProcessEnv({ ...process.env, LD_PRELOAD: LIB }, "android");
		const mod = join(import.meta.dir, "termux-exec.js");
		const script = `
			const { restorePreload } = await import(${JSON.stringify(mod)});
			const { spawnSync } = await import("node:child_process");
			const atStart = process.env.LD_PRELOAD ?? null;
			const restored = restorePreload(process.env);
			const grandchild = spawnSync("sh", ["-c", 'printf %s "$LD_PRELOAD"'], { encoding: "utf8" }).stdout;
			console.log(JSON.stringify({ atStart, restored, grandchild }));
		`;
		const r = spawnSync(process.execPath, ["-e", script], { env: child, encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}")).toEqual({
			atStart: null,
			restored: true,
			grandchild: LIB,
		});
	});
});

describe("node path", () => {
	const yes = () => true;
	const no = () => false;
	test("a normal execPath is kept", () => {
		expect(nodeExecPath("/usr/bin/node", {}, yes)).toBe("/usr/bin/node");
	});
	test("the system linker is replaced by the real node", () => {
		const self = `${PREFIX}/bin/node`;
		expect(nodeExecPath("/system/bin/linker64", { TERMUX_EXEC__PROC_SELF_EXE: self }, yes)).toBe(
			self,
		);
		expect(nodeExecPath("/system/bin/linker64", { PREFIX }, yes)).toBe(`${PREFIX}/bin/node`);
		expect(nodeExecPath("/system/bin/linker", {}, no)).toBe("node");
	});
});

describe("spawns from the TUI process", () => {
	const PATH = `${PREFIX}/bin:/system/bin`;
	const have = (files: string[]) => (p: string) => files.includes(p);
	const opts = (files: string[]) => ({
		exists: have(files),
		execPath: `${PREFIX}/bin/node`,
		env: {},
	});

	test("a Termux program runs through /system/bin/sh with its absolute path", () => {
		const w = shellWrappedSpawn(
			"git",
			["git", "rev-parse", "HEAD"],
			PATH,
			opts([`${PREFIX}/bin/git`]),
		);
		expect(w).toEqual({
			file: "/system/bin/sh",
			args: ["/system/bin/sh", "-c", 'exec "$0" "$@"', `${PREFIX}/bin/git`, "rev-parse", "HEAD"],
		});
	});

	test("system binaries and unknown names are left alone", () => {
		expect(shellWrappedSpawn("sh", ["sh", "-c", "x"], PATH, opts(["/system/bin/sh"]))).toBeNull();
		expect(shellWrappedSpawn("/system/bin/sh", ["sh"], PATH, opts(["/system/bin/sh"]))).toBeNull();
		expect(shellWrappedSpawn("nope", ["nope"], PATH, opts([]))).toBeNull();
	});

	test("the linker as execPath becomes the real node", () => {
		const node = `${PREFIX}/bin/node`;
		const w = shellWrappedSpawn("/system/bin/linker64", ["/system/bin/linker64", "-e", "1"], PATH, {
			exists: have([node, "/system/bin/linker64"]),
			execPath: "/system/bin/linker64",
			env: { PREFIX },
		});
		expect(w?.args.slice(3)).toEqual([node, "-e", "1"]);
	});
});
