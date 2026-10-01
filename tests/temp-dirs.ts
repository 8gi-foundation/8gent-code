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
 * Every directory tempDir() makes is recorded and removed by
 * cleanupTempDirs(). preload-temp-dirs.ts also calls it once after the whole
 * run, so a file that forgets the afterAll still does not leak past the run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = new Set<string>();

/** mkdtempSync under os.tmpdir(), recorded for cleanupTempDirs(). */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.add(dir);
	return dir;
}

/** Remove every directory tempDir() has made and not yet removed. */
export function cleanupTempDirs(): void {
	for (const dir of made) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort: a cleanup error (EIO on a full disk) must not fail the test it follows.
		}
		made.delete(dir);
	}
}
