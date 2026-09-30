/**
 * Instruction Loader - Auto-discover and merge AGENTS.md / 8GENT.md / CLAUDE.md
 *
 * Priority order per directory: AGENTS.md > 8GENT.md > CLAUDE.md (first found wins).
 * AGENTS.md is the vendor-neutral open standard and is canonical: 8gent is not
 * married to any vendor, so the open file wins. CLAUDE.md is a last-resort
 * fallback only - it loads when no vendor-neutral file is present.
 * Merge order: standing rules (~/.claude) < global (~/.8gent) < project root < cwd
 * (later overrides earlier)
 *
 * @see https://github.com/8gi-foundation/8gent-code/issues/941
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** File names to search for, in priority order (first match per directory wins) */
const INSTRUCTION_FILES = ["AGENTS.md", "8GENT.md", "CLAUDE.md"] as const;

/**
 * The operator's personal standing rules.
 *
 * These are the always-on behavioural overrides - the ones that are supposed to
 * hold on every turn, in every repo, whether or not anyone invokes them. They
 * live in `~/.claude/` because that is where the operator already maintains
 * them, and until now `loadInstructions` never looked there: the global layer
 * only checked `~/.8gent/`, so an agent answering from a surface with no repo
 * context (Telegram, a cron job, a bare daemon session) ran with none of them.
 *
 * Loaded FIRST, so it is the lowest-priority layer and any repo that
 * contradicts it still wins inside that repo. Standing rules are the floor,
 * not the ceiling.
 */
const STANDING_RULES_FILE = ".claude/CLAUDE.md";

/**
 * Home directory, preferring `$HOME` so the resolution is overridable.
 * `homedir()` is a frozen binding under Bun, which makes any code that calls
 * it directly untestable without touching the real user's home.
 */
function home(): string {
	return process.env.HOME || homedir();
}

/** Read the operator's standing rules, or null when the file is absent. */
function findStandingRules(): string | null {
	const path = join(home(), STANDING_RULES_FILE);
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf-8").trim();
		return content.length > 0 ? content : null;
	} catch {
		return null;
	}
}

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
 *   1. Standing rules: ~/.claude/CLAUDE.md - always on, every surface
 *   2. Global: ~/.8gent/AGENTS.md (or 8GENT.md / CLAUDE.md fallback)
 *   3. Directories from project root down to cwd
 *
 * Returns concatenated content separated by horizontal rules, or empty string
 * if no instruction files found.
 */
export function loadInstructions(cwd: string): string {
	return loadInstructionParts(cwd).join("\n\n---\n\n");
}

/** The instruction files loadInstructions merges, one entry per file, lowest priority first. */
export function loadInstructionParts(cwd: string): string[] {
	const parts: string[] = [];

	// 1. Operator standing rules (always on, lowest priority)
	const standing = findStandingRules();
	if (standing) {
		parts.push(`# STANDING RULES (always on, every surface)\n\n${standing}`);
	}

	// 2. Global instructions
	const globalDir = join(home(), ".8gent");
	const globalContent = findInstructionFile(globalDir);
	if (globalContent) {
		parts.push(globalContent.trim());
	}

	// 3. Walk up from cwd, collecting project instructions
	const projectDirs = walkUp(cwd);
	for (const dir of projectDirs) {
		const content = findInstructionFile(dir);
		if (content) {
			// Avoid duplicating global if ~/.8gent happens to be in the walk-up path
			if (dir === globalDir) continue;
			parts.push(content.trim());
		}
	}

	return parts;
}

/**
 * Character cap on the instructions section of the live system prompt (#3236).
 * About 2,000 tokens, which a 32k local model can carry.
 */
export const PROJECT_INSTRUCTIONS_CAP = 8000;

const SEPARATOR = "\n\n---\n\n";

/**
 * The loaded instructions as a trailing system-prompt section, or "" when
 * there are none. It goes LAST so the stable prompt prefix before it stays
 * byte-identical (#3222).
 *
 * Over the cap, files are kept from the most specific down (the project's own
 * file wins, so it is never the one dropped) and lower-priority files are
 * left out. A single file larger than the cap keeps its beginning.
 */
export function projectInstructionsSection(cwd: string, cap = PROJECT_INSTRUCTIONS_CAP): string {
	const parts = loadInstructionParts(cwd);
	if (parts.length === 0) return "";

	const kept: string[] = [];
	let budget = cap;
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (part.length <= budget) {
			kept.unshift(part);
			budget -= part.length + SEPARATOR.length;
			continue;
		}
		if (kept.length === 0) {
			const head = part.slice(0, budget).replace(/\n[^\n]*$/, "");
			kept.unshift(`${head}\n... (truncated; read the full file for more)`);
		}
		break;
	}
	const omitted = parts.length - kept.length;
	const note =
		omitted > 0 ? `(${omitted} lower-priority instruction file(s) left out to fit)\n\n` : "";
	return `\n\n## PROJECT INSTRUCTIONS (AGENTS.md / 8GENT.md / CLAUDE.md)\n\n${note}${kept.join(SEPARATOR)}`;
}
