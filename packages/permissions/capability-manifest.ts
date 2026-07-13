/**
 * 8gent Code - Tool Capability Manifests (NemoClaw v2, issue #2756 step 1)
 *
 * Every tool declares the least capability it needs - filesystem scopes,
 * network hosts, exec commands - and the policy engine enforces the
 * declaration instead of relying on convention. A tool with no manifest
 * gets NO fs/network/exec capability: deny by default.
 *
 * Scope tokens resolved at enforcement time:
 *   ${workspace} - the session working directory
 *   ${home}      - the user home directory
 *   ${tmp}       - the OS temp directory
 *
 * Enforcement order (see evaluateToolCall in policy-engine.ts):
 *   1. Capability manifest (this module) - structural least-capability gate
 *   2. path-guard / policy rules         - content and rule based gates
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PolicyDecision } from "./types.js";

// ============================================
// Manifest types
// ============================================

/** Filesystem capability: path scopes the tool may touch. */
export interface FsCapability {
	/** Scopes the tool may read from. Supports scope tokens. */
	read?: string[];
	/** Scopes the tool may write to. Supports scope tokens. */
	write?: string[];
}

/** Network capability: hosts the tool may reach. */
export interface NetworkCapability {
	/**
	 * Allowed hosts. Exact match ("api.github.com"), subdomain wildcard
	 * ("*.github.com"), or "*" for any host (must be declared explicitly).
	 */
	hosts: string[];
}

/** Exec capability: commands the tool may spawn. */
export interface ExecCapability {
	/**
	 * Allowed executable basenames for the first token of the command
	 * ("git", "bun"), or "*" for any command. When the list is NOT "*",
	 * shell chaining metacharacters are rejected because the chained
	 * segments cannot be verified against the list.
	 */
	commands: string[];
}

/** A single tool's declared capabilities. Absent capability = denied. */
export interface ToolCapabilityManifest {
	tool: string;
	fs?: FsCapability;
	network?: NetworkCapability;
	exec?: ExecCapability;
}

/** A capability a tool call is about to use, checked before execution. */
export type CapabilityRequest =
	| { kind: "fs_read"; path: string }
	| { kind: "fs_write"; path: string }
	| { kind: "network"; url: string }
	| { kind: "exec"; command: string };

export interface EnforceOptions {
	/** Session working directory - resolves ${workspace}. Default: process.cwd(). */
	workingDirectory?: string;
}

// ============================================
// Default manifests for built-in tools
// ============================================

const WS = "${workspace}";
const TMP = "${tmp}";

/**
 * Least-capability declarations for the built-in tool set
 * (packages/eight/tools.ts). Read scopes default to the workspace;
 * only web tools get network; only git/run tools get exec.
 */
export const DEFAULT_TOOL_MANIFESTS: ToolCapabilityManifest[] = [
	// Read-only code exploration
	{ tool: "read_file", fs: { read: [WS] } },
	{ tool: "list_files", fs: { read: [WS] } },
	{ tool: "get_outline", fs: { read: [WS] } },
	{ tool: "get_symbol", fs: { read: [WS] } },
	{ tool: "search_symbols", fs: { read: [WS] } },
	{ tool: "get_project_outline", fs: { read: [WS] } },
	{ tool: "read_pdf", fs: { read: [WS] } },
	{ tool: "read_pdf_page", fs: { read: [WS] } },
	{ tool: "search_pdf", fs: { read: [WS] } },

	// Workspace mutation
	{ tool: "write_file", fs: { read: [WS], write: [WS] } },
	{ tool: "edit_file", fs: { read: [WS], write: [WS] } },

	// Git - reads the workspace, spawns only git
	{ tool: "git_status", fs: { read: [WS] }, exec: { commands: ["git"] } },
	{ tool: "git_diff", fs: { read: [WS] }, exec: { commands: ["git"] } },
	{ tool: "git_log", fs: { read: [WS] }, exec: { commands: ["git"] } },
	{ tool: "git_add", fs: { read: [WS] }, exec: { commands: ["git"] } },
	{ tool: "git_commit", fs: { read: [WS] }, exec: { commands: ["git"] } },

	// Arbitrary exec - the command itself is vetted by the policy rules
	// (checkCommand / evaluateCapabilities), the manifest scopes its fs reach.
	{
		tool: "run_command",
		fs: { read: [WS, TMP], write: [WS, TMP] },
		exec: { commands: ["*"] },
	},

	// Web - any host, declared explicitly (the only tools with network)
	{ tool: "web_search", network: { hosts: ["*"] } },
	{ tool: "web_fetch", network: { hosts: ["*"] } },
];

// ============================================
// Registry
// ============================================

const _builtin = new Set(DEFAULT_TOOL_MANIFESTS.map((m) => m.tool));
let _registry: Map<string, ToolCapabilityManifest> = seed();

function seed(): Map<string, ToolCapabilityManifest> {
	return new Map(DEFAULT_TOOL_MANIFESTS.map((m) => [m.tool, m]));
}

/**
 * Register a manifest for a custom tool (skill or agent provided).
 * Built-in manifests are immutable: re-registering one throws, so a
 * malicious skill cannot widen what write_file or run_command may touch.
 */
export function registerToolManifest(manifest: ToolCapabilityManifest): void {
	if (_builtin.has(manifest.tool)) {
		throw new Error(
			`capability-manifest: "${manifest.tool}" is a built-in tool; its manifest is immutable`,
		);
	}
	_registry.set(manifest.tool, manifest);
}

/** Look up the manifest for a tool, if one is registered. */
export function getToolManifest(tool: string): ToolCapabilityManifest | undefined {
	return _registry.get(tool);
}

/** Test hook: reset the registry to the built-in defaults. */
export function resetToolManifests(): void {
	_registry = seed();
}

// ============================================
// Path resolution
// ============================================

function homeDir(): string {
	// Same test hook as path-guard so fixtures can fake the home root.
	return process.env.EIGHT_FAKE_HOME || os.homedir();
}

/**
 * Resolve a path to its canonical absolute form, collapsing symlinks so a
 * link inside an allowed scope cannot tunnel out. For paths that do not
 * exist yet (writes), the deepest existing ancestor is canonicalised and
 * the remaining segments re-joined.
 */
function canonicalise(raw: string, cwd: string): string {
	const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
	const normalised = path.normalize(absolute);
	try {
		return fs.realpathSync(normalised);
	} catch {
		let cursor = normalised;
		const tail: string[] = [];
		while (cursor && cursor !== path.dirname(cursor)) {
			try {
				const real = fs.realpathSync(cursor);
				return tail.length === 0 ? real : path.join(real, ...tail.reverse());
			} catch {
				tail.push(path.basename(cursor));
				cursor = path.dirname(cursor);
			}
		}
		return normalised;
	}
}

/** Expand scope tokens, then canonicalise the scope root. */
function resolveScope(scope: string, cwd: string): string {
	const expanded = scope
		.replaceAll("${workspace}", cwd)
		.replaceAll("${home}", homeDir())
		.replaceAll("${tmp}", os.tmpdir());
	return canonicalise(expanded, cwd);
}

function isWithin(target: string, scopeRoot: string): boolean {
	if (target === scopeRoot) return true;
	return target.startsWith(scopeRoot + path.sep);
}

function fsAllowed(scopes: string[] | undefined, rawPath: string, cwd: string): boolean {
	if (!scopes || scopes.length === 0) return false;
	const target = canonicalise(rawPath, cwd);
	for (const scope of scopes) {
		if (scope === "*") return true;
		if (isWithin(target, resolveScope(scope, cwd))) return true;
	}
	return false;
}

// ============================================
// Network + exec matching
// ============================================

function hostAllowed(hosts: string[], url: string): { ok: boolean; host?: string } {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return { ok: false };
	}
	if (host.length === 0) return { ok: false };
	for (const pattern of hosts) {
		const p = pattern.toLowerCase();
		if (p === "*") return { ok: true, host };
		if (p.startsWith("*.")) {
			if (host.endsWith(p.slice(1))) return { ok: true, host };
			continue;
		}
		if (host === p) return { ok: true, host };
	}
	return { ok: false, host };
}

/** Metacharacters that chain or substitute commands past the first token. */
const CHAIN_PATTERN = /[;&|`\n]|\$\(|<\(|>\(/;

function execAllowed(commands: string[], command: string): { ok: boolean; reason?: string } {
	if (commands.includes("*")) return { ok: true };
	if (CHAIN_PATTERN.test(command)) {
		return {
			ok: false,
			reason: "command chaining cannot be verified against the manifest allow-list",
		};
	}
	const first = command.trim().split(/\s+/)[0] ?? "";
	const base = path.basename(first);
	if (base.length === 0) return { ok: false, reason: "empty command" };
	if (commands.includes(base)) return { ok: true };
	return { ok: false, reason: `executable "${base}" is not in the manifest allow-list` };
}

// ============================================
// Enforcement
// ============================================

/**
 * Enforce a tool's capability manifest against a capability it is about to
 * use. Deny by default: no manifest, or a manifest without the requested
 * capability, is a denial. Denials for unmanifested tools carry
 * requiresApproval so the session can surface an approval gate instead of
 * silently failing (issue #2756 step 4 builds on this).
 */
export function enforceCapability(
	toolName: string,
	request: CapabilityRequest,
	opts: EnforceOptions = {},
): PolicyDecision {
	const cwd = opts.workingDirectory ?? process.cwd();
	const manifest = _registry.get(toolName);

	if (!manifest) {
		return {
			allowed: false,
			reason: `[capability-manifest] tool "${toolName}" has no capability manifest; ${request.kind} denied by default`,
			requiresApproval: true,
		};
	}

	switch (request.kind) {
		case "fs_read": {
			if (fsAllowed(manifest.fs?.read, request.path, cwd)) return { allowed: true };
			return {
				allowed: false,
				reason: `[capability-manifest] "${toolName}" may not read outside its declared scopes: ${request.path}`,
			};
		}
		case "fs_write": {
			if (fsAllowed(manifest.fs?.write, request.path, cwd)) return { allowed: true };
			return {
				allowed: false,
				reason: `[capability-manifest] "${toolName}" may not write outside its declared scopes: ${request.path}`,
			};
		}
		case "network": {
			if (!manifest.network) {
				return {
					allowed: false,
					reason: `[capability-manifest] "${toolName}" declares no network capability`,
				};
			}
			const net = hostAllowed(manifest.network.hosts, request.url);
			if (net.ok) return { allowed: true };
			return {
				allowed: false,
				reason: `[capability-manifest] "${toolName}" may not reach host "${net.host ?? "<unparseable url>"}"`,
			};
		}
		case "exec": {
			if (!manifest.exec) {
				return {
					allowed: false,
					reason: `[capability-manifest] "${toolName}" declares no exec capability`,
				};
			}
			const ex = execAllowed(manifest.exec.commands, request.command);
			if (ex.ok) return { allowed: true };
			return {
				allowed: false,
				reason: `[capability-manifest] "${toolName}" exec denied: ${ex.reason}`,
			};
		}
	}
}
