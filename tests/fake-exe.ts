/**
 * A stand-in executable for tests that spawn a binary by name or path, on every
 * platform (#4094).
 *
 * Tests used `#!/bin/sh` scripts as fake `gh`, TTS engines and the like. Windows
 * cannot spawn a shell script, and a `.cmd` shim cannot be spawned without a
 * shell, so those tests failed on windows-latest with the real binary never
 * reached. The stand-in is now a small JavaScript program run by Bun itself:
 *
 *   - POSIX: the file is written with a `#!<bun>` line and the execute bit,
 *     so spawning it by path or by name (through PATH) runs it under this Bun.
 *   - Windows: `bun build --compile` turns it into a real `<name>.exe`, which
 *     spawn() finds through PATH (libuv tries `.exe`) and runs without a shell.
 *
 * Inside the program `process.argv.slice(2)` is the argv the caller passed, the
 * same on both (the compiled binary keeps a virtual entry point at argv[1]).
 * Keep the source plain JavaScript: it is run as a bare file on POSIX.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write `source` as an executable `name` inside `dir` and return its path. */
export function fakeExecutable(dir: string, name: string, source: string): string {
	if (process.platform !== "win32") {
		const file = join(dir, name);
		writeFileSync(file, `#!${process.execPath}\n${source}`);
		chmodSync(file, 0o755);
		return file;
	}
	const src = join(dir, `${name}.fake.js`);
	const exe = join(dir, `${name}.exe`);
	writeFileSync(src, source);
	execFileSync(process.execPath, ["build", "--compile", src, "--outfile", exe], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
	});
	return exe;
}
