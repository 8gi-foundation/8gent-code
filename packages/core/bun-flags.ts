/**
 * Flags for every Bun process 8gent starts (#4013, 8SO).
 *
 * Bun reads $cwd/bunfig.toml (whose `preload` runs code before 8gent's own)
 * and $cwd/.env files at start. A child started in a workspace, or a daemon
 * started in $HOME, must not: a shell command could have written either file,
 * and they would run, or set EIGHT_* keys, before the security env snapshot.
 *
 *   --no-install            no package auto-install, from any import (#4026)
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
	return ["--no-install", "--no-env-file", `--config=${emptyBunfig(platform)}`];
}

/** safeBunFlags() when `execPath` is the Bun runtime; [] for a compiled 8gent binary (built with autoload off). */
export function bunFlagsFor(
	execPath: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const base = execPath.split(/[\\/]/).pop() ?? "";
	return /^bun(\.exe)?$/i.test(base) ? safeBunFlags(platform) : [];
}

/**
 * Absolute path of this install's own 8gent CLI entry: bin/8gent.ts in a
 * checkout, dist/cli.js in an npm install. Never resolved against a cwd, so a
 * routine or job running in some workspace cannot be pointed at that
 * workspace's bin/8gent.ts.
 */
export function eightCliPath(): string | undefined {
	for (const candidate of [
		path.resolve(import.meta.dirname, "..", "..", "bin", "8gent.ts"),
		path.resolve(import.meta.dirname, "..", "bin", "8gent.ts"),
		path.resolve(import.meta.dirname, "cli.js"),
	]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}
