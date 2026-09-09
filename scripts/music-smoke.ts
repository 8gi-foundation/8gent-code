#!/usr/bin/env bun
/**
 * music-smoke - the "never lose the music" guardrail (#2934, part of #2922).
 *
 * Runs exactly the suites that prove the music still works:
 *   1. packages/music        DJ, producer, synth, mixer, player, Replicate
 *   2. DjDeck.test.tsx       the 8GENT FM strip and stereo render
 *   3. DjDeckToggle.test.tsx /dj open, /dj close and Ctrl+D flip a live deck
 *
 * Each group runs as its own `bun test` process under a throwaway HOME and
 * TMPDIR, so nothing reads or writes ~/.8gent, ~/Music/8gent or a live mpv
 * socket, and module-level state in packages/music/dj.ts starts clean.
 *
 * Usage:
 *   bun run music:smoke
 *
 * Exit code is non-zero when any group fails.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const GROUPS: Array<{ label: string; files: string[] }> = [
	{ label: "packages/music", files: ["packages/music"] },
	{
		label: "DjDeck render",
		files: ["apps/tui/src/components/__tests__/DjDeck.test.tsx"],
	},
	{
		label: "DjDeck open/close",
		files: ["apps/tui/src/components/__tests__/DjDeckToggle.test.tsx"],
	},
];

const home = mkdtempSync(join(tmpdir(), "8gent-music-smoke-home-"));
const tmp = mkdtempSync(join(tmpdir(), "8gent-music-smoke-tmp-"));
const env = { ...process.env, HOME: home, TMPDIR: tmp, EIGHT_TEST_HOME: home };

let failed = 0;
const results: string[] = [];

for (const group of GROUPS) {
	const started = Date.now();
	const proc = Bun.spawnSync([process.execPath, "test", ...group.files], {
		cwd: ROOT,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	});
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	const ok = proc.exitCode === 0;
	if (!ok) failed++;
	results.push(`${ok ? "ok  " : "FAIL"}  ${group.label} (${seconds}s)`);
}

rmSync(home, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

console.log("\nmusic-smoke");
for (const line of results) console.log(`  ${line}`);
console.log(failed === 0 ? "  music intact" : `  ${failed} group(s) failed`);
process.exit(failed === 0 ? 0 : 1);
