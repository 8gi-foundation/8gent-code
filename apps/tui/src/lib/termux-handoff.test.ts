import { describe, expect, test } from "bun:test";
import { installTermuxHandoff, patchChildProcess, wrapSyncSpawn } from "./termux-handoff";

// Off Termux the module is a no-op at import (no carry variable); these drive
// the patch directly with a fake child_process, since /system/bin/sh exists
// only on Android.
describe("termux handoff spawn patch", () => {
	test("async spawns of an unknown program are left alone", () => {
		const seen: unknown[] = [];
		class ChildProcess {
			spawn(options: unknown) {
				seen.push(options);
				return 0;
			}
		}
		const cp = { ChildProcess, spawnSync: () => 0, execFileSync: () => 0 } as never;
		patchChildProcess(cp);
		new ChildProcess().spawn({
			file: "no-such-program-4682",
			args: ["no-such-program-4682"],
			envPairs: ["PATH=/nowhere"],
		});
		expect(seen).toEqual([
			{ file: "no-such-program-4682", args: ["no-such-program-4682"], envPairs: ["PATH=/nowhere"] },
		]);
	});

	test("sync spawns pass shell commands through untouched", () => {
		const calls: unknown[][] = [];
		const wrapped = wrapSyncSpawn((...a: unknown[]) => calls.push(a));
		wrapped("git status", { shell: true });
		expect(calls).toEqual([["git status", { shell: true }]]);
	});

	test("sync spawn of a program on PATH under a non-system dir goes through sh", () => {
		const calls: unknown[][] = [];
		const wrapped = wrapSyncSpawn((...a: unknown[]) => calls.push(a));
		// /bin/sh exists on every test host; under a fake PATH it reads as a non-system program.
		wrapped("sh", ["-c", "true"], { env: { PATH: "/bin" } });
		expect(calls[0][0]).toBe("/system/bin/sh");
		expect(calls[0][1]).toEqual(["-c", 'exec "$0" "$@"', "/bin/sh", "-c", "true"]);
	});
});

describe("termux handoff gate", () => {
	test("off Termux a carried value is dropped, never turned into LD_PRELOAD", () => {
		const env = {
			EIGHT_TERMUX_LD_PRELOAD: "/tmp/evil.so",
			PREFIX: "/usr",
		} as unknown as NodeJS.ProcessEnv;
		expect(installTermuxHandoff(env, "linux")).toBe(false);
		expect(env.LD_PRELOAD).toBeUndefined();
		expect(env.EIGHT_TERMUX_LD_PRELOAD).toBeUndefined();
	});
});
