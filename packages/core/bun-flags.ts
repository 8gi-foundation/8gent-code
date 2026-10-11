/**
 * Flags for every Bun process 8gent starts (#4013, 8SO).
 *
 * Bun reads $cwd/bunfig.toml (whose `preload` runs code before 8gent's own)
 * and $cwd/.env files at start. A child started in a workspace, or a daemon
 * started in $HOME, must not: a shell command could have written either file,
 * and they would run, or set EIGHT_* keys, before the security env snapshot.
 *
 *   --no-env-file           no .env autoload
 *   --config=<empty file>   no $cwd/bunfig.toml
 *
 * The empty config is /dev/null on POSIX, and on Windows the empty bunfig the
 * package ships at bin/bunfig.empty.toml (or a fresh empty temp file).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SHIPPED_EMPTY_BUNFIG = "bunfig.empty.toml";

/** An empty bunfig path that a workspace cannot have written. */
export function emptyBunfig(platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return "/dev/null";
	// Source: packages/core -> ../../bin. Bundled dist/cli.js -> ../bin.
	for (const candidate of [
		path.resolve(import.meta.dirname, "..", "..", "bin", SHIPPED_EMPTY_BUNFIG),
		path.resolve(import.meta.dirname, "..", "bin", SHIPPED_EMPTY_BUNFIG),
	]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-bunfig-"));
	const file = path.join(dir, SHIPPED_EMPTY_BUNFIG);
	fs.writeFileSync(file, "", { flag: "wx" });
	return file;
}

/** Put these before the script path: `bun ...safeBunFlags() run <script>` or `bun ...safeBunFlags() <script>`. */
export function safeBunFlags(platform: NodeJS.Platform = process.platform): string[] {
	return ["--no-env-file", `--config=${emptyBunfig(platform)}`];
}
