/**
 * 8gent App Marketplace - Archive builder + extractor
 *
 * Wraps the system `tar` binary (already required by
 * packages/runtime/installer.ts) so we don't add a JS-side dep.
 * macOS, Linux, and Windows-1803+ all ship a compatible `tar`.
 *
 * See docs/specs/APP-ARCHIVE-FORMAT.md Section 1.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const ARCHIVE_SUFFIX = ".8gent-app.tar.gz";

const ALWAYS_EXCLUDE = new Set([
	"node_modules",
	".git",
	"dist",
	".DS_Store",
	".turbo",
	".next",
	".cache",
]);

/**
 * Files at the root that are kept even though they start with `.`.
 * Everything else with a leading dot at the root is dropped.
 */
const ROOT_DOTFILE_ALLOWLIST = new Set([".gitignore", ".env.example", ".npmignore"]);

export interface StageOptions {
	/** Directory to stage from. */
	source: string;
	/** Where to write the staged tree. Will be created. */
	stagingDir: string;
	/** Sub-directory inside `stagingDir` (becomes the tar root). */
	rootName: string;
}

/**
 * Copy `source` into `stagingDir/rootName`, applying the standard
 * exclude rules. Returns the staged directory path.
 */
export function stageAppDirectory(opts: StageOptions): string {
	const target = path.join(opts.stagingDir, opts.rootName);
	fs.mkdirSync(target, { recursive: true });

	function copy(srcDir: string, destDir: string, depth: number) {
		const entries = fs.readdirSync(srcDir, { withFileTypes: true });
		for (const e of entries) {
			if (ALWAYS_EXCLUDE.has(e.name)) continue;
			if (depth === 0 && e.name.startsWith(".") && !ROOT_DOTFILE_ALLOWLIST.has(e.name)) {
				continue;
			}
			const fromPath = path.join(srcDir, e.name);
			const toPath = path.join(destDir, e.name);
			if (e.isSymbolicLink()) continue; // archives are symlink-free by spec
			if (e.isDirectory()) {
				fs.mkdirSync(toPath, { recursive: true });
				copy(fromPath, toPath, depth + 1);
			} else if (e.isFile()) {
				fs.copyFileSync(fromPath, toPath);
			}
		}
	}

	copy(opts.source, target, 0);
	return target;
}

export interface BuildArchiveOptions {
	/** Path to the staged tree's parent (i.e. the dir that contains `<name>-<version>/`). */
	stagingDir: string;
	/** The directory name inside `stagingDir` to pack (`<name>-<version>`). */
	rootName: string;
	/** Output path. Should end in `.8gent-app.tar.gz`. */
	outPath: string;
}

/**
 * Pack `stagingDir/rootName` into a deterministic gzip-compressed tarball.
 *
 * `--sort=name` is GNU-tar; macOS bsdtar uses `--options=!timestamp` plus
 * pre-sorted entry order. We get reproducibility by:
 *   1. Sorting entries ourselves with `find ... | sort` and feeding the
 *      list to `tar -T -`.
 *   2. Forcing a fixed mtime via `--mtime` (GNU) or by relying on
 *      pre-normalized timestamps written during staging.
 *
 * Both GNU tar and bsdtar honour `-T -` for the file list.
 */
export function buildArchive(opts: BuildArchiveOptions): void {
	const fullRoot = path.join(opts.stagingDir, opts.rootName);
	if (!fs.existsSync(fullRoot)) {
		throw new Error(`stage missing: ${fullRoot}`);
	}

	// Normalize mtime on every staged file so the tar bytes are reproducible.
	const epoch = new Date("2026-01-01T00:00:00Z");
	function touchRecursive(dir: string) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const full = path.join(dir, e.name);
			fs.utimesSync(full, epoch, epoch);
			if (e.isDirectory()) touchRecursive(full);
		}
	}
	touchRecursive(fullRoot);
	fs.utimesSync(fullRoot, epoch, epoch);

	// Generate a sorted file list relative to stagingDir.
	const list = collectSortedRelativePaths(fullRoot, opts.rootName);
	const listFile = `${opts.outPath}.filelist`;
	fs.writeFileSync(listFile, `${list.join("\n")}\n`);

	const args = ["-czf", opts.outPath, "-C", opts.stagingDir, "-T", listFile];

	const res = spawnSync("tar", args, { stdio: "inherit" });
	fs.rmSync(listFile, { force: true });
	if (res.status !== 0) {
		throw new Error(`tar exited with code ${res.status}`);
	}
}

function collectSortedRelativePaths(rootAbs: string, rootName: string): string[] {
	const out: string[] = [];
	function walk(dir: string, rel: string) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full, childRel);
			} else if (e.isFile()) {
				out.push(`${rootName}/${childRel}`);
			}
		}
	}
	walk(rootAbs, "");
	out.sort();
	return out;
}

/**
 * Extract a `.8gent-app.tar.gz` into `destDir` using system tar.
 * Caller is responsible for verifying integrity afterwards.
 */
export function extractArchive(archivePath: string, destDir: string): void {
	fs.mkdirSync(destDir, { recursive: true });
	const res = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
	if (res.status !== 0) {
		throw new Error(`tar -xzf exited with code ${res.status}`);
	}
}

export interface EntryAuditResult {
	ok: boolean;
	errors: string[];
}

/**
 * Enumerate entries with `tar -tzf` before extracting. Reject any
 * entry that escapes the archive root or is an absolute path.
 */
export function auditArchiveEntries(archivePath: string, expectedRoot: string): EntryAuditResult {
	const errors: string[] = [];
	const res = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf-8" });
	if (res.status !== 0) {
		return { ok: false, errors: [`tar -tzf failed: ${res.stderr}`] };
	}
	const entries = res.stdout.split("\n").filter(Boolean);
	if (entries.length === 0) {
		errors.push("archive has no entries");
	}
	const rootPrefix = `${expectedRoot}/`;
	for (const e of entries) {
		if (e.startsWith("/")) errors.push(`absolute path entry: ${e}`);
		if (e.includes("..")) errors.push(`parent-traversal entry: ${e}`);
		if (e !== expectedRoot && e !== rootPrefix && !e.startsWith(rootPrefix)) {
			errors.push(`entry outside expected root '${expectedRoot}': ${e}`);
		}
	}
	return { ok: errors.length === 0, errors };
}
