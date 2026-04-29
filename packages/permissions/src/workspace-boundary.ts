/**
 * 8gent Code - Workspace Boundary Enforcement
 *
 * Hardens the permission engine against path traversal attacks. All file paths
 * referenced by file-system tools and shell commands are resolved through
 * `realpathSync` (collapsing symlinks and `..` segments) and rejected if the
 * resolved location falls outside the user's workspace root.
 *
 * Inspired by holaOS Section 1 (`docs/specs/HOLAOS-EXTRACTIONS.md`) — rebuilt
 * from scratch to fit the existing NemoClaw policy engine. Issue #2083.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================
// Types
// ============================================

export interface BoundaryViolation {
	/** The literal token / path the agent tried to use */
	raw: string;
	/** The resolved absolute path (post realpath / normalize) */
	resolved: string;
	/** Human-readable reason for rejection */
	reason: string;
}

export interface BoundaryCheckResult {
	allowed: boolean;
	violations: BoundaryViolation[];
}

/**
 * Options for command extraction. Allowlists let callers permit known safe
 * absolute prefixes outside the workspace (e.g. system binaries on PATH).
 */
export interface ExtractOptions {
	workspaceRoot: string;
	/** Absolute path prefixes that are always allowed (e.g. /usr/bin) */
	allowedAbsolutePrefixes?: string[];
}

// ============================================
// Path resolution
// ============================================

/**
 * Resolve a path through `realpathSync` if it exists; otherwise fall back to
 * `path.resolve` so we still collapse `..` segments for not-yet-created files.
 *
 * For non-existent paths we walk up to the deepest existing ancestor and
 * realpath that, then re-append the remainder. This catches the common
 * "/workspace/symlink-to-etc/passwd" pattern even when `passwd` itself does
 * not exist under the symlinked target.
 */
export function resolveSafe(p: string, cwd: string): string {
	const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);

	try {
		return fs.realpathSync(absolute);
	} catch {
		// Path doesn't exist — climb to deepest existing ancestor.
		let parent = path.dirname(absolute);
		const segments: string[] = [path.basename(absolute)];
		while (parent !== path.dirname(parent)) {
			try {
				const realParent = fs.realpathSync(parent);
				return path.resolve(realParent, ...segments.reverse());
			} catch {
				segments.push(path.basename(parent));
				parent = path.dirname(parent);
			}
		}
		// Reached filesystem root without finding any real ancestor — just
		// normalize, which still collapses `..`.
		return path.resolve(absolute);
	}
}

function canonicalize(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		// Path doesn't exist — canonicalize the deepest existing ancestor.
		const absolute = path.resolve(p);
		let parent = path.dirname(absolute);
		const segments: string[] = [path.basename(absolute)];
		while (parent !== path.dirname(parent)) {
			try {
				const realParent = fs.realpathSync(parent);
				return path.resolve(realParent, ...segments.reverse());
			} catch {
				segments.push(path.basename(parent));
				parent = path.dirname(parent);
			}
		}
		return absolute;
	}
}

/**
 * `true` iff `resolvedPath` is `workspaceRoot` itself or lives strictly
 * beneath it. Comparisons are made on canonicalised paths (both sides are
 * realpath'd) so symlink wrappers around the workspace don't false-positive
 * as escapes — and platform-specific symlinks like macOS `/var` -> `/private/var`
 * don't break the prefix check.
 */
export function isWithinWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
	const canonicalRoot = canonicalize(workspaceRoot);
	const canonicalPath = canonicalize(resolvedPath);

	if (canonicalPath === canonicalRoot) return true;

	const rootWithSep = canonicalRoot.endsWith(path.sep)
		? canonicalRoot
		: canonicalRoot + path.sep;
	return canonicalPath.startsWith(rootWithSep);
}

/**
 * Convenience: resolve a single path and check confinement in one shot.
 */
export function checkPath(
	rawPath: string,
	workspaceRoot: string,
	options: { allowedAbsolutePrefixes?: string[] } = {},
): BoundaryCheckResult {
	const resolved = resolveSafe(rawPath, workspaceRoot);

	if (isAllowedByPrefix(resolved, options.allowedAbsolutePrefixes)) {
		return { allowed: true, violations: [] };
	}

	if (isWithinWorkspace(resolved, workspaceRoot)) {
		return { allowed: true, violations: [] };
	}

	return {
		allowed: false,
		violations: [
			{
				raw: rawPath,
				resolved,
				reason: `Path escapes workspace root (${workspaceRoot})`,
			},
		],
	};
}

function isAllowedByPrefix(resolved: string, prefixes?: string[]): boolean {
	if (!prefixes || prefixes.length === 0) return false;
	for (const prefix of prefixes) {
		const canonical = path.resolve(prefix);
		if (resolved === canonical) return true;
		const withSep = canonical.endsWith(path.sep) ? canonical : canonical + path.sep;
		if (resolved.startsWith(withSep)) return true;
	}
	return false;
}

// ============================================
// Quote-aware command tokenizer
// ============================================

/**
 * A single segment of a shell pipeline split on `&&`, `||`, `;`, or `|`.
 * Each segment carries its own argv plus the `cd` target if any (so we can
 * re-anchor relative paths in the next segment, mirroring shell semantics).
 */
export interface CommandSegment {
	argv: string[];
	/** If this segment is a `cd <target>`, the resolved cwd that follows */
	cdTarget?: string;
}

/**
 * Tokenize a single shell segment into argv. Handles:
 *   - single quotes (literal, no escape recognition)
 *   - double quotes (allows backslash escape of " and \)
 *   - backslash-escaped spaces and metacharacters outside quotes
 *   - tabs/whitespace as separators
 *
 * Does NOT do variable expansion or command substitution — those are
 * deliberately left raw so we can detect them as suspicious downstream.
 */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (escape) {
			current += ch;
			started = true;
			escape = false;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			escape = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			started = true;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			started = true;
			continue;
		}

		if (!inSingle && !inDouble && (ch === " " || ch === "\t" || ch === "\n")) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}

		current += ch;
		started = true;
	}

	if (started) tokens.push(current);
	return tokens;
}

/**
 * Split a command line into pipeline segments, respecting quotes. Splits on
 * `&&`, `||`, `;`, and standalone `|` (when not piping inside a quoted token).
 */
export function splitPipeline(input: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escape = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		const next = input[i + 1];

		if (escape) {
			current += ch;
			escape = false;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			current += ch;
			escape = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}

		if (!inSingle && !inDouble) {
			if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				segments.push(current);
				current = "";
				i++;
				continue;
			}
			if (ch === ";" || ch === "|") {
				segments.push(current);
				current = "";
				continue;
			}
		}

		current += ch;
	}

	if (current.trim().length > 0) segments.push(current);
	return segments.map((s) => s.trim()).filter(Boolean);
}

// ============================================
// File-path extraction from shell commands
// ============================================

/** Argv tokens that look like file paths to a heuristic eye. */
function looksLikePath(token: string): boolean {
	if (token.length === 0) return false;
	// `--flag=value` form: peel the prefix and inspect the value side first,
	// otherwise the leading `-` causes us to skip real path arguments.
	if (token.startsWith("-") && token.includes("=")) {
		const rhs = token.slice(token.indexOf("=") + 1);
		return looksLikePath(rhs);
	}
	if (token.startsWith("-")) return false; // bare flag, not a path
	if (token.includes("$") || token.includes("`")) return true; // suspicious expansion
	return (
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token === ".." ||
		token === "." ||
		token.includes("/") ||
		// bare filename with extension — still worth checking against cwd
		/\.[A-Za-z0-9]+$/.test(token)
	);
}

/** Strip `--flag=` prefix when present and return the value side. */
function valueSide(token: string): string {
	if (token.includes("=")) return token.slice(token.indexOf("=") + 1);
	return token;
}

/**
 * Walk a command line, collect every path-like argument across pipeline
 * segments, and check each one against the workspace root. Tracks `cd`
 * statements so paths in later segments are anchored to the chained cwd
 * (the holaOS attack surface).
 */
export function extractAndCheckPaths(
	command: string,
	options: ExtractOptions,
): BoundaryCheckResult {
	const violations: BoundaryViolation[] = [];
	let cwd = options.workspaceRoot;

	for (const segment of splitPipeline(command)) {
		const argv = tokenize(segment);
		if (argv.length === 0) continue;

		const head = argv[0];

		// Track `cd <dir>` so subsequent segments resolve relative to it.
		if (head === "cd" && argv.length >= 2) {
			const target = valueSide(argv[1]);
			const resolved = resolveSafe(target, cwd);
			if (
				!isWithinWorkspace(resolved, options.workspaceRoot) &&
				!isAllowedByPrefix(resolved, options.allowedAbsolutePrefixes)
			) {
				violations.push({
					raw: target,
					resolved,
					reason: `cd target escapes workspace root (${options.workspaceRoot})`,
				});
			}
			cwd = resolved;
			continue;
		}

		for (let i = 1; i < argv.length; i++) {
			const token = argv[i];
			if (!looksLikePath(token)) continue;

			const candidate = valueSide(token);
			const resolved = resolveSafe(candidate, cwd);

			if (isAllowedByPrefix(resolved, options.allowedAbsolutePrefixes)) continue;
			if (isWithinWorkspace(resolved, options.workspaceRoot)) continue;

			violations.push({
				raw: token,
				resolved,
				reason: `Path argument escapes workspace root (${options.workspaceRoot})`,
			});
		}
	}

	return { allowed: violations.length === 0, violations };
}

// ============================================
// Public entry points
// ============================================

/**
 * Pre-check gate for file-system tool actions (write_file / read_file /
 * delete_file). Returns a list of violations or an empty array if the path
 * is safely confined.
 */
export function checkFilePathBoundary(
	rawPath: string,
	workspaceRoot: string,
	allowedAbsolutePrefixes?: string[],
): BoundaryCheckResult {
	return checkPath(rawPath, workspaceRoot, { allowedAbsolutePrefixes });
}

/**
 * Pre-check gate for shell `run_command` actions. Tokenizes the command and
 * verifies every path-like argument (including `cd` targets in chained
 * pipelines) stays inside the workspace root.
 */
export function checkCommandBoundary(
	command: string,
	workspaceRoot: string,
	allowedAbsolutePrefixes?: string[],
): BoundaryCheckResult {
	return extractAndCheckPaths(command, {
		workspaceRoot,
		allowedAbsolutePrefixes,
	});
}
