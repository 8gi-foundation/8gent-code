/**
 * Instruction Loader - Auto-discover and merge AGENTS.md / 8GENT.md / CLAUDE.md
 *
 * Order per directory: AGENTS.md, then 8GENT.md, then CLAUDE.md. AGENTS.md is
 * the vendor-neutral open standard and comes first. A second or third file in
 * the same directory also loads when it is a different file with different
 * text (#259): a short generated AGENTS.md must not hide the project's real
 * rules in the CLAUDE.md beside it. A symlink or a copy loads once.
 * Merge order: standing rules (~/.claude) < global (~/.8gent) < project root < cwd
 * (later overrides earlier)
 *
 * @see https://github.com/8gi-foundation/8gent-code/issues/941
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** File names to search for in each directory, in load order. */
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

/** One instruction file as it enters the merge. */
interface InstructionEntry {
	/** Absolute path of the file. */
	path: string;
	/** The text that goes into the prompt (trimmed, standing rules with their header). */
	text: string;
	/** Set when the file repeats an earlier one in its directory, which is then loaded once. */
	sameAs?: string;
}

/**
 * Every readable, non-empty instruction file in a directory, in load order.
 * A file that is the same file as an earlier one (a symlink) or carries the
 * same text is returned with `sameAs` set, so a caller can report it without
 * loading it twice.
 */
function findInstructionFilesIn(dir: string): InstructionEntry[] {
	const found: InstructionEntry[] = [];
	const realPaths = new Map<string, string>();
	for (const filename of INSTRUCTION_FILES) {
		const path = join(dir, filename);
		if (!existsSync(path)) continue;
		let text: string;
		let real: string;
		try {
			text = readFileSync(path, "utf-8").trim();
			real = realpathSync(path);
		} catch {
			continue; // Unreadable file, skip
		}
		if (text.length === 0) continue;
		const twin = realPaths.get(real) ?? found.find((f) => !f.sameAs && f.text === text)?.path;
		found.push(twin ? { path, text, sameAs: twin } : { path, text });
		if (!realPaths.has(real)) realPaths.set(real, path);
	}
	return found;
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
 * Directories whose listing macOS serves through autofs or the volume mounter.
 * Looking a name up inside one (for example /AGENTS.md at the root, which
 * sits beside the autofs /home and /net entries) can make macOS ask for
 * "Network Volumes" access even when none is mounted, so the walk never
 * probes them.
 */
const NEVER_PROBE = new Set(["/", "/Volumes", "/Network", "/net", "/home"]);

/**
 * Walk up from startDir, collecting directories that contain an instruction
 * file. Returns them in order from top-most to startDir (so closer directories
 * override farther ones when concatenated).
 *
 * Inside $HOME the walk stops at $HOME: nothing above it is the operator's or
 * the repo's. Outside $HOME it climbs, but never probes the NEVER_PROBE roots.
 * `has` is the file probe, injectable so tests can watch what is touched.
 */
export function walkUp(
	startDir: string,
	homeDir: string = resolve(home()),
	has: (dir: string) => boolean = (d) => findInstructionFile(d) !== null,
): string[] {
	const dirs: string[] = [];
	let current = resolve(startDir);
	const insideHome = current === homeDir || current.startsWith(`${homeDir}/`);
	const seen = new Set<string>();

	while (!seen.has(current)) {
		seen.add(current);
		if (!NEVER_PROBE.has(current) && has(current)) {
			dirs.push(current);
		}
		if (insideHome && current === homeDir) break; // never above $HOME
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

/**
 * The instruction files loadInstructions merges, one entry per file, lowest
 * priority first.
 *
 * `includeUserGlobal: false` keeps only the project's files. User-global means
 * the operator's own files: the standing rules, ~/.8gent, and any walk-up
 * directory at or above $HOME (a ~/AGENTS.md is the operator's, not the
 * repo's). Those may go to an on-box model but never to a cloud provider.
 */
export function loadInstructionParts(
	cwd: string,
	opts: { includeUserGlobal?: boolean } = {},
): string[] {
	return loadInstructionEntries(cwd, opts)
		.filter((e) => !e.sameAs)
		.map((e) => e.text);
}

/** loadInstructionParts with each file's path, repeats included and marked. */
function loadInstructionEntries(
	cwd: string,
	opts: { includeUserGlobal?: boolean } = {},
): InstructionEntry[] {
	const includeUserGlobal = opts.includeUserGlobal ?? true;
	const entries: InstructionEntry[] = [];
	const homeDir = resolve(home());

	// 1. Operator standing rules (always on, lowest priority)
	const standing = includeUserGlobal ? findStandingRules() : null;
	if (standing) {
		entries.push({
			path: join(home(), STANDING_RULES_FILE),
			text: `# STANDING RULES (always on, every surface)\n\n${standing}`,
		});
	}

	// 2. Global instructions
	const globalDir = join(homeDir, ".8gent");
	if (includeUserGlobal) entries.push(...findInstructionFilesIn(globalDir));

	// 3. Walk up from cwd, collecting project instructions
	const projectDirs = walkUp(cwd, homeDir);
	for (const dir of projectDirs) {
		// Avoid duplicating global if ~/.8gent happens to be in the walk-up path
		if (dir === globalDir) continue;
		const atOrAboveHome = dir === homeDir || homeDir.startsWith(`${dir}/`) || dir === "/";
		if (!includeUserGlobal && atOrAboveHome) continue;
		entries.push(...findInstructionFilesIn(dir));
	}

	return entries;
}

/**
 * Character cap on the instructions section of the live system prompt (#3236).
 * About 2,000 tokens, which a 32k local model can carry.
 */
export const PROJECT_INSTRUCTIONS_CAP = 8000;

const SEPARATOR = "\n\n---\n\n";
const CUT_MARK = "\n... (truncated; read the full file for more)";

/**
 * How many characters of each file fit under the cap, lowest priority first.
 *
 * When everything fits, every file is whole. Over the cap, each file first
 * gets an equal guaranteed share of half the budget, so no file is dropped to
 * nothing (#259: the standing rules used to vanish whole). What is left goes
 * to the files from the most specific down, so the project's own file is the
 * last one to be cut.
 */
function allot(lengths: number[], cap: number): number[] {
	const n = lengths.length;
	const joined = lengths.reduce((a, b) => a + b, 0) + SEPARATOR.length * (n - 1);
	if (joined <= cap) return [...lengths];
	const budget = Math.max(0, cap - SEPARATOR.length * (n - 1) - CUT_MARK.length * n);
	const share = Math.floor(budget / (2 * n));
	const out = lengths.map((l) => Math.min(l, share));
	let left = budget - out.reduce((a, b) => a + b, 0);
	for (let i = n - 1; i >= 0 && left > 0; i--) {
		const more = Math.min(lengths[i] - out[i], left);
		out[i] += more;
		left -= more;
	}
	return out;
}

/**
 * The loaded instructions as a trailing system-prompt section, or "" when
 * there are none. Project files only unless `includeUserGlobal` is set, which
 * the agent does for on-box providers alone. It goes LAST so the stable prompt prefix before it stays
 * byte-identical (#3222).
 *
 * Over the cap, every file keeps at least its beginning and the most specific
 * files keep the most (see `allot`). A shortened file ends with a line saying
 * so.
 */
export function projectInstructionsSection(
	cwd: string,
	opts: { includeUserGlobal?: boolean; cap?: number } = {},
): string {
	const cap = opts.cap ?? PROJECT_INSTRUCTIONS_CAP;
	const parts = loadInstructionParts(cwd, { includeUserGlobal: opts.includeUserGlobal ?? false });
	if (parts.length === 0) return "";

	const room = allot(
		parts.map((p) => p.length),
		cap,
	);
	let shortened = 0;
	const kept: string[] = [];
	parts.forEach((part, i) => {
		if (room[i] >= part.length) {
			kept.push(part);
			return;
		}
		shortened++;
		const head = part.slice(0, room[i]).replace(/\n[^\n]*$/, "");
		if (head.length > 0) kept.push(`${head}${CUT_MARK}`);
	});
	const note = shortened > 0 ? `(${shortened} instruction file(s) shortened to fit)\n\n` : "";
	return `\n\n## PROJECT INSTRUCTIONS (AGENTS.md / 8GENT.md / CLAUDE.md)\n\n${note}${kept.join(SEPARATOR)}`;
}

/** One instruction file as `8gent doctor` reports it. */
export interface InstructionFileRow {
	path: string;
	/** Characters in the file as loaded. */
	chars: number;
	/** Characters of it that reach an on-box model's prompt. 0 for a repeat. */
	kept: number;
	/** The earlier file this one repeats, when it is loaded once. */
	sameAs?: string;
}

/**
 * The instruction files found for a folder, lowest priority first, with how
 * much of each fits under the cap. Counts the operator's own files, which
 * reach on-box models only.
 */
export function instructionFileRows(
	cwd: string,
	opts: { cap?: number } = {},
): InstructionFileRow[] {
	const entries = loadInstructionEntries(cwd, { includeUserGlobal: true });
	const loaded = entries.filter((e) => !e.sameAs);
	const room = allot(
		loaded.map((e) => e.text.length),
		opts.cap ?? PROJECT_INSTRUCTIONS_CAP,
	);
	return entries.map((e) => {
		const at = loaded.indexOf(e);
		return e.sameAs
			? { path: e.path, chars: e.text.length, kept: 0, sameAs: e.sameAs }
			: { path: e.path, chars: e.text.length, kept: Math.min(e.text.length, room[at]) };
	});
}
