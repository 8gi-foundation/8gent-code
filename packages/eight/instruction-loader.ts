/**
 * Instruction Loader - Auto-discover and merge 8GENT.md / AGENTS.md / CLAUDE.md
 *
 * Priority order per directory: 8GENT.md > AGENTS.md > CLAUDE.md (first found wins)
 * Merge order: global (~/.8gent/8GENT.md) < project root < cwd (later overrides earlier)
 *
 * @see https://github.com/8gi-foundation/8gent-code/issues/941
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** File names to search for, in priority order (first match per directory wins) */
const INSTRUCTION_FILES = ["8GENT.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * Find the first instruction file in a given directory.
 * Returns the file content or null if none found.
 */
function findInstructionFile(dir: string): string | null {
	for (const filename of INSTRUCTION_FILES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return readFileSync(filePath, "utf-8");
			} catch {
				// Unreadable file, skip
			}
		}
	}
	return null;
}

/**
 * Walk up from startDir to filesystem root, collecting directories that contain
 * an instruction file. Returns them in order from root-most to startDir (so
 * closer directories override farther ones when concatenated).
 */
function walkUp(startDir: string): string[] {
	const dirs: string[] = [];
	let current = resolve(startDir);
	const seen = new Set<string>();

	while (!seen.has(current)) {
		seen.add(current);
		if (findInstructionFile(current) !== null) {
			dirs.push(current);
		}
		const parent = dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}

	// Reverse so root-most is first (lowest priority)
	return dirs.reverse();
}

/**
 * Load and merge instruction files for the given working directory.
 *
 * Merge order (later overrides earlier):
 *   1. Global: ~/.8gent/8GENT.md
 *   2. Directories from project root down to cwd
 *
 * Returns concatenated content separated by horizontal rules, or empty string
 * if no instruction files found.
 */
export function loadInstructions(cwd: string): string {
	const parts: string[] = [];

	// 1. Global instructions
	const globalDir = join(homedir(), ".8gent");
	const globalContent = findInstructionFile(globalDir);
	if (globalContent) {
		parts.push(globalContent.trim());
	}

	// 2. Walk up from cwd, collecting project instructions
	const projectDirs = walkUp(cwd);
	for (const dir of projectDirs) {
		const content = findInstructionFile(dir);
		if (content) {
			// Avoid duplicating global if ~/.8gent happens to be in the walk-up path
			if (dir === globalDir) continue;
			parts.push(content.trim());
		}
	}

	if (parts.length === 0) return "";

	return parts.join("\n\n---\n\n");
}
