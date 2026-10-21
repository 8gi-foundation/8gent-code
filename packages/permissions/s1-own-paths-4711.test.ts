/**
 * #4711: a session removes what it made. `mkdir tmp` then `rmdir tmp`, `touch f` then
 * `rm -f f`, write_file then `rm -f`; anything the session did not make stays refused.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { CreatedFiles, MAX_CREATED_ENTRIES, watchRedirects, watchWrite } from "./s1-created-files";
import { rmOfNothingOrOwn } from "./s1-rm-nothing";
import { rmOwnDir } from "./s1-rm-own-dir";

afterAll(cleanupTempDirs);

let ws: string;
let rec: CreatedFiles;

beforeEach(() => {
	ws = realpathSync(tempDir("own4711-"));
	execFileSync("git", ["init", "-q"], { cwd: ws });
	rec = new CreatedFiles();
});

/** Runs a command the way the tool path does: bracketed by watchRedirects. */
function sh(cmd: string) {
	const done = watchRedirects(cmd, ws, rec);
	execFileSync("sh", ["-c", cmd], { cwd: ws });
	done();
}

describe("#4711 own paths", () => {
	test("mkdir tmp then rmdir tmp is allowed, and the real rmdir works", () => {
		sh("mkdir tmp");
		expect(rmOwnDir("rmdir tmp", ws, rec).ok).toBe(true);
		sh("rmdir tmp");
		expect(existsSync(join(ws, "tmp"))).toBe(false);
	});

	test("rmdir of a directory the session did not make is refused", () => {
		mkdirSync(join(ws, "theirs"));
		expect(rmOwnDir("rmdir theirs", ws, rec).ok).toBe(false);
		expect(rmOwnDir("rmdir theirs", ws, undefined).ok).toBe(false);
	});

	test("touch f then rm -f f is allowed; a touched pre-existing file is not", () => {
		sh("touch scratch.dat");
		expect(rmOfNothingOrOwn("rm -f scratch.dat", ws, rec)).toBe("own-scratch");
		writeFileSync(join(ws, "theirs.dat"), "x");
		sh("touch theirs.dat");
		expect(rmOfNothingOrOwn("rm -f theirs.dat", ws, rec)).toBeNull();
	});

	test("touch with a flag, an absolute path or .. records nothing", () => {
		for (const c of ["touch -t 200001010000 a.dat", "touch ../x.dat"]) {
			const done = watchRedirects(c, ws, rec);
			done();
		}
		expect(rec.size).toBe(0);
	});

	test("a file write_file made is its own; rm -f passes, a tracked or older file does not", () => {
		const done = watchWrite(join(ws, "made.txt"), rec);
		writeFileSync(join(ws, "made.txt"), "x");
		done();
		expect(rmOfNothingOrOwn("rm -f made.txt", ws, rec)).toBe("own-scratch");
		writeFileSync(join(ws, "old.txt"), "x");
		expect(rmOfNothingOrOwn("rm -f old.txt", ws, rec)).toBeNull();
	});

	test("rm -rf and rmdir stay refused for a non-empty-of-foreign-files session directory", () => {
		sh("mkdir work");
		writeFileSync(join(ws, "work", "theirs.txt"), "x");
		expect(rmOwnDir("rmdir work", ws, rec).ok).toBe(false);
	});

	test("the record is capped; the oldest entry is dropped first", () => {
		for (let i = 0; i <= MAX_CREATED_ENTRIES; i++) {
			writeFileSync(join(ws, `f${i}.txt`), "x");
			rec.record(join(ws, `f${i}.txt`));
		}
		expect(rec.size).toBe(MAX_CREATED_ENTRIES);
		expect(rec.createdBySession(join(ws, "f0.txt"))).toBe(false);
		expect(rec.createdBySession(join(ws, `f${MAX_CREATED_ENTRIES}.txt`))).toBe(true);
	});
});
