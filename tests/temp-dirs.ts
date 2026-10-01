/**
 * Test temp directories that clean themselves up (#3285).
 *
 * Tests made directories with mkdtempSync and never removed them: about 24k
 * folders and 11 GB in $TMPDIR on the Mac CI runner, enough to push it under
 * its disk floor. A test file that needs a temp dir does this instead:
 *
 *   import { afterAll } from "bun:test";
 *   import { cleanupTempDirs, tempDir } from "<root>/tests/temp-dirs";
 *   afterAll(cleanupTempDirs);
 *   const dir = tempDir("my-prefix-");
 *
 * The record is process-wide, not per file: every test file in a `bun test`
 * run shares this module, so cleanupTempDirs() removes every directory
 * tempDir() has made so far in the run, from any file. Files run one after
 * another, so in practice a file's afterAll removes that file's own dirs.
 * preload-temp-dirs.ts calls it once more after the whole run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const made = new Set<string>();

/** mkdtempSync under the absolute os.tmpdir(), recorded for cleanupTempDirs(). */
export function tempDir(prefix: string): string {
	// resolve(): a relative $TMPDIR must not make the path depend on the cwd.
	const dir = mkdtempSync(join(resolve(tmpdir()), prefix));
	made.add(dir);
	return dir;
}

/** Remove every directory tempDir() has recorded in this process and not yet removed. */
export function cleanupTempDirs(): void {
	for (const dir of made) {
		made.delete(dir);
		if (!isAbsolute(dir)) continue;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort: a cleanup error (EIO on a full disk) must not fail the test it follows.
		}
	}
}
