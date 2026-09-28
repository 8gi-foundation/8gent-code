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
import { type HomeEnv, resolveHome } from "../../core/home";
import { isPathWithin, pathFor } from "../../core/path-within";
import { fromLongPath } from "../../core/win-path";

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
 * The machine a command will run on. Paths are parsed with its separator and
 * case rules, and `~`, `$VAR` and `%VAR%` expand from its environment.
 * Defaults to the current process; tests inject a foreign platform, and the
 * real filesystem is consulted only when the platform is the host's own.
 */
export interface BoundaryHost {
	platform: NodeJS.Platform;
	env: HomeEnv;
}

function hostOf(host: Partial<BoundaryHost> = {}): BoundaryHost {
	return { platform: host.platform ?? process.platform, env: host.env ?? process.env };
}

/**
 * Options for command extraction. Allowlists let callers permit known safe
 * absolute prefixes outside the workspace (e.g. system binaries on PATH).
 */
export interface ExtractOptions {
	workspaceRoot: string;
	/** Absolute path prefixes that are always allowed (e.g. /usr/bin) */
	allowedAbsolutePrefixes?: string[];
	host?: Partial<BoundaryHost>;
}

// ============================================
// Path resolution
// ============================================

/**
 * Resolve a path through `realpathSync` if it exists; otherwise fall back to
 * `resolve` so we still collapse `..` segments for not-yet-created files.
 *
 * For non-existent paths we walk up to the deepest existing ancestor and
 * realpath that, then re-append the remainder. This catches the common
 * "/workspace/symlink-to-etc/passwd" pattern even when `passwd` itself does
 * not exist under the symlinked target.
 */
export function resolveSafe(p: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
	const flavor = pathFor(platform);
	const absolute = flavor.resolve(fromLongPath(cwd, platform), fromLongPath(p, platform));
	if (platform !== process.platform) return absolute;

	const tail: string[] = [];
	let cursor = absolute;
	for (;;) {
		try {
			return fromLongPath(flavor.resolve(fs.realpathSync(cursor), ...tail), platform);
		} catch {
			const parent = flavor.dirname(cursor);
			if (parent === cursor) return absolute;
			tail.unshift(flavor.basename(cursor));
			cursor = parent;
		}
	}
}

/**
 * `true` iff `resolvedPath` is `workspaceRoot` itself or lives strictly
 * beneath it. Both sides are realpath'd so symlink wrappers around the
 * workspace (macOS `/var` -> `/private/var`) don't read as escapes.
 */
export function isWithinWorkspace(
	resolvedPath: string,
	workspaceRoot: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return isPathWithin(
		resolveSafe(resolvedPath, workspaceRoot, platform),
		resolveSafe(workspaceRoot, workspaceRoot, platform),
		platform,
	);
}

/**
 * Convenience: resolve a single path and check confinement in one shot.
 */
export function checkPath(
	rawPath: string,
	workspaceRoot: string,
	options: { allowedAbsolutePrefixes?: string[]; host?: Partial<BoundaryHost> } = {},
): BoundaryCheckResult {
	const { platform } = hostOf(options.host);
	const resolved = resolveSafe(rawPath, workspaceRoot, platform);

	if (isConfined(resolved, workspaceRoot, options.allowedAbsolutePrefixes, platform)) {
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

function isConfined(
	resolved: string,
	workspaceRoot: string,
	prefixes: string[] | undefined,
	platform: NodeJS.Platform,
): boolean {
	const flavor = pathFor(platform);
	for (const prefix of prefixes ?? []) {
		if (isPathWithin(resolved, flavor.resolve(prefix), platform)) return true;
	}
	return isWithinWorkspace(resolved, workspaceRoot, platform);
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
 * `escapes` names the characters that escape the next one: `\` for POSIX
 * shells, `^` and a backtick for cmd.exe and PowerShell, where `\` is a path
 * separator.
 *
 * Does NOT do variable expansion or command substitution — those are
 * deliberately left raw so we can detect them as suspicious downstream.
 */
export function tokenize(input: string, escapes = "\\"): string[] {
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

		if (escapes.includes(ch) && !inSingle) {
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

		if (!inSingle && !inDouble && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
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
 * `&&`, `||`, `;`, `|`, `&` (cmd.exe's sequencing operator and the POSIX
 * background operator) and line breaks, none of them inside a quoted token.
 */
export function splitPipeline(input: string, escapes = "\\"): string[] {
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

		if (escapes.includes(ch) && !inSingle) {
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
			if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
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

/**
 * One way a shell may read a command line: which characters escape the next
 * one, and whether `%VAR%` and `$env:VAR` expand.
 */
interface ShellReading {
	escapes: string;
	windowsVars: boolean;
}

const POSIX_SHELL: ShellReading = { escapes: "\\", windowsVars: false };
const WINDOWS_SHELL: ShellReading = { escapes: "^`", windowsVars: true };

/**
 * On Windows the agent's shell may be sh (Git Bash), cmd.exe or PowerShell,
 * so the line is read every way and a path that escapes under any reading is
 * a violation.
 */
function readings(platform: NodeJS.Platform): ShellReading[] {
	return platform === "win32" ? [POSIX_SHELL, WINDOWS_SHELL] : [POSIX_SHELL];
}

/** Argv tokens that look like file paths to a heuristic eye. */
function looksLikePath(token: string, platform: NodeJS.Platform): boolean {
	if (token.length === 0) return false;
	if (token.includes("$") || token.includes("`")) return true; // suspicious expansion
	if (platform === "win32" && (token.includes("\\") || /^[A-Za-z]:/.test(token))) return true;
	return (
		token === ".." ||
		token === "." ||
		token.includes("/") ||
		// bare filename with extension — still worth checking against cwd
		/\.[A-Za-z0-9]+$/.test(token)
	);
}

/**
 * The operand side of an argv token, or `null` for a bare flag. `--out=x`
 * yields `x`, and on Windows so does PowerShell's `-Path:x`.
 */
function operandOf(token: string, platform: NodeJS.Platform): string | null {
	if (token.startsWith("-")) {
		const eq = token.indexOf("=");
		if (eq !== -1) return token.slice(eq + 1);
		const colon = token.indexOf(":");
		if (platform === "win32" && colon !== -1) return token.slice(colon + 1);
		return null;
	}
	const eq = token.indexOf("=");
	return eq === -1 ? token : token.slice(eq + 1);
}

function envLookup(env: HomeEnv, name: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== "win32") return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
	return key === undefined ? undefined : env[key];
}

/**
 * Expand `~`, `$VAR`, `${VAR}` and, for a Windows shell, `%VAR%` and
 * `$env:VAR` the way the shell will before the command sees them, so a path
 * rooted in the user's profile is checked where it really points. An unset
 * `$VAR` expands to nothing; an unset `%VAR%` stays literal, as in cmd.exe.
 */
function expand(token: string, host: BoundaryHost, reading: ShellReading): string {
	const { env, platform } = host;
	let out = token;
	if (reading.windowsVars) {
		out = out.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name) => envLookup(env, name, platform) ?? m);
		out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, name) => envLookup(env, name, platform) ?? "");
	}
	out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
		return envLookup(env, braced ?? bare, platform) ?? "";
	});
	const tilde = (platform === "win32" ? /^~([^/\\]*)(?=$|[/\\])/ : /^~([^/]*)(?=$|\/)/).exec(out);
	if (tilde) {
		const home = resolveHome(env, platform);
		const flavor = pathFor(platform);
		const base = tilde[1] ? flavor.join(flavor.dirname(home), tilde[1]) : home;
		out = base + out.slice(tilde[0].length);
	}
	return out;
}

/**
 * Walk a command line, collect every path-like argument across pipeline
 * segments, and check each one against the workspace root. Tracks `cd`
 * statements so paths in later segments are anchored to the chained cwd
 * (the holaOS attack surface).
 */
export function extractAndCheckPaths(command: string, options: ExtractOptions): BoundaryCheckResult {
	const host = hostOf(options.host);
	const { platform } = host;
	const { workspaceRoot, allowedAbsolutePrefixes } = options;
	const violations = new Map<string, BoundaryViolation>();
	const flag = (raw: string, resolved: string, reason: string) => {
		violations.set(`${raw}\0${resolved}`, { raw, resolved, reason });
	};
	const delimiter = pathFor(platform).delimiter;

	for (const reading of readings(platform)) {
		let cwd = workspaceRoot;
		for (const segment of splitPipeline(command, reading.escapes)) {
			const argv = tokenize(segment, reading.escapes);
			if (argv.length === 0) continue;

			let first = 1;
			if (argv[0].toLowerCase() === "cd" && argv.length >= 2) {
				// cmd.exe's `cd /d <dir>` also switches drive.
				const hasDriveSwitch = platform === "win32" && argv.length >= 3 && argv[1].toLowerCase() === "/d";
				const index = hasDriveSwitch ? 2 : 1;
				const target = expand(operandOf(argv[index], platform) ?? argv[index], host, reading);
				const resolved = resolveSafe(target, cwd, platform);
				if (!isConfined(resolved, workspaceRoot, allowedAbsolutePrefixes, platform)) {
					flag(argv[index], resolved, `cd target escapes workspace root (${workspaceRoot})`);
				}
				cwd = resolved;
				first = index + 1;
			}

			for (const token of argv.slice(first)) {
				const operand = operandOf(token, platform);
				if (operand === null) continue;
				const candidate = expand(operand, host, reading);
				// `echo $PATH` names a search list, not a file.
				if (candidate !== operand && candidate.includes(delimiter)) continue;
				if (!looksLikePath(candidate, platform)) continue;

				const resolved = resolveSafe(candidate, cwd, platform);
				if (isConfined(resolved, workspaceRoot, allowedAbsolutePrefixes, platform)) continue;
				flag(token, resolved, `Path argument escapes workspace root (${workspaceRoot})`);
			}
		}
	}

	return { allowed: violations.size === 0, violations: [...violations.values()] };
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
	host?: Partial<BoundaryHost>,
): BoundaryCheckResult {
	return checkPath(rawPath, workspaceRoot, { allowedAbsolutePrefixes, host });
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
	host?: Partial<BoundaryHost>,
): BoundaryCheckResult {
	return extractAndCheckPaths(command, { workspaceRoot, allowedAbsolutePrefixes, host });
}
