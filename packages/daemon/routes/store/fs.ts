/**
 * fs.* JSON-RPC handlers - workspace-scoped filesystem + sandboxed exec.
 *
 * Workspaces are looked up via WorkspaceDb's kv_store under the
 * `daemon.workspaces` namespace. The reserved id `default` falls back to
 * `process.cwd()` so a fresh install Just Works.
 *
 * Path enforcement: every path is resolved through `resolveSafe` and then
 * checked with `isWithinWorkspace`. Symlinks pointing out of the workspace
 * are rejected. Path traversal (`..`) is collapsed pre-check.
 *
 * Sensitive-file gate: write/edit/delete paths are classified by
 * `classifySensitivePath` (see ./sensitive.ts). Sensitive paths (.env, key
 * material, *_secret*, *_credential*) are blocked unless the caller passes
 * `confirmedSensitiveWrite: true`; both the block and the override are
 * audited. Forbidden paths (anything under `.git/`) are rejected with no
 * override.
 *
 * fs.exec routes through the existing NemoClaw policy engine
 * (`evaluatePolicy("run_command", ...)`). On top of that we apply a
 * daemon-local allowlist (`COMMAND_ALLOWLIST`) which is the actual security
 * boundary for shell exec. The `EIGHT_LEGACY_BASH=1` env var bypasses the
 * allowlist for one release; bypass is still audited and logged with a
 * warning.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluatePolicy } from "../../../permissions/policy-engine";
import {
	isWithinWorkspace,
	resolveSafe,
} from "../../../permissions/src/workspace-boundary";
import { getWorkspaceDb } from "../../../db/src/workspace-db";
import { logExecOp, logFsSensitive } from "./audit";
import {
	JSONRPC_BLOCKED,
	JsonRpcError,
	type JsonRpcContext,
	type JsonRpcHandler,
} from "./jsonrpc";
import { classifySensitivePath } from "./sensitive";

// ── Workspace registry ────────────────────────────────────────────────

const WORKSPACE_KV_PREFIX = "daemon.workspaces.";

function workspaceRoot(workspaceId: string): string {
	if (!workspaceId) throw new Error("fs: missing workspaceId");
	if (workspaceId === "default") {
		const env = process.env.EIGHT_WORKSPACE_ROOT;
		return env ? fs.realpathSync(env) : fs.realpathSync(process.cwd());
	}
	const db = getWorkspaceDb();
	const stored = db.kvGet<string>(WORKSPACE_KV_PREFIX + workspaceId);
	if (!stored) {
		throw new Error(`fs: unknown workspaceId: ${workspaceId}`);
	}
	if (!fs.existsSync(stored)) {
		throw new Error(`fs: workspace root no longer exists: ${stored}`);
	}
	return fs.realpathSync(stored);
}

/** Internal helper, also exported for tests. */
export function _registerWorkspace(workspaceId: string, root: string): void {
	if (!fs.existsSync(root)) {
		throw new Error(`workspace root does not exist: ${root}`);
	}
	const db = getWorkspaceDb();
	db.kvSet(WORKSPACE_KV_PREFIX + workspaceId, fs.realpathSync(root));
}

function assertInWorkspace(root: string, target: string): string {
	const resolved = resolveSafe(target, root);
	if (!isWithinWorkspace(resolved, root)) {
		throw new JsonRpcError(JSONRPC_BLOCKED, "path escapes workspace boundary", {
			target,
			resolved,
			workspaceRoot: root,
		});
	}
	return resolved;
}

// ── Mime helpers ──────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
	".ts": "application/typescript",
	".tsx": "application/typescript",
	".js": "application/javascript",
	".jsx": "application/javascript",
	".json": "application/json",
	".md": "text/markdown",
	".txt": "text/plain",
	".html": "text/html",
	".css": "text/css",
	".yml": "application/yaml",
	".yaml": "application/yaml",
	".toml": "application/toml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
};

function mimeOf(filePath: string): string {
	return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const SHA256_AUTO_LIMIT = 50 * 1024 * 1024; // 50MB

function sha256OfFile(absPath: string): string | undefined {
	try {
		const stat = fs.statSync(absPath);
		if (stat.size > SHA256_AUTO_LIMIT) return undefined;
		const hash = crypto.createHash("sha256");
		hash.update(fs.readFileSync(absPath));
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

// ── Handlers: read/write ──────────────────────────────────────────────

interface FsListParams {
	workspaceId: string;
	path: string;
	computeSha256?: boolean;
}

interface FsReadParams {
	workspaceId: string;
	path: string;
}

interface FsWriteParams {
	workspaceId: string;
	path: string;
	content: string;
	confirmedSensitiveWrite?: boolean;
}

interface FsEditParams {
	workspaceId: string;
	path: string;
	oldString: string;
	newString: string;
	replaceAll?: boolean;
	confirmedSensitiveWrite?: boolean;
}

interface FsDeleteParams {
	workspaceId: string;
	path: string;
	recursive?: boolean;
	confirmedSensitiveWrite?: boolean;
}

/**
 * Apply the sensitive-path gate before a write/edit/delete proceeds. Returns
 * normally if the path is clear; throws JsonRpcError(BLOCKED) otherwise. Both
 * the block and any override are written to the fs-sensitive audit log.
 */
function enforceSensitiveGate(
	verb: "write" | "edit" | "delete",
	params: { workspaceId: string; path: string; confirmedSensitiveWrite?: boolean },
	resolved: string,
	initiator: string,
): void {
	const check = classifySensitivePath(resolved);
	if (check.forbidden) {
		logFsSensitive({
			op: "blocked",
			verb,
			workspaceId: params.workspaceId,
			path: params.path,
			resolved,
			initiator,
			reason: check.reason ?? "forbidden path",
			forbidden: true,
		});
		throw new JsonRpcError(JSONRPC_BLOCKED, "blocked: forbidden path", {
			blocked: true,
			forbidden: true,
			reason: check.reason,
		});
	}
	if (check.sensitive) {
		if (!params.confirmedSensitiveWrite) {
			logFsSensitive({
				op: "blocked",
				verb,
				workspaceId: params.workspaceId,
				path: params.path,
				resolved,
				initiator,
				reason: check.reason ?? "sensitive path",
			});
			throw new JsonRpcError(JSONRPC_BLOCKED, "blocked: sensitive path", {
				blocked: true,
				reason: check.reason,
			});
		}
		// Override: log it so the audit trail shows the explicit confirmation.
		logFsSensitive({
			op: "override",
			verb,
			workspaceId: params.workspaceId,
			path: params.path,
			resolved,
			initiator,
			reason: check.reason ?? "sensitive path",
		});
	}
}

interface FsStatParams {
	workspaceId: string;
	path: string;
	computeSha256?: boolean;
}

interface FsExecParams {
	workspaceId: string;
	command: string;
	conversationId: string;
	initiator?: string;
}

export const fsList: JsonRpcHandler = (raw) => {
	const params = raw as FsListParams;
	const root = workspaceRoot(params.workspaceId);
	const target = assertInWorkspace(root, params.path);
	const stat = fs.statSync(target);
	if (!stat.isDirectory()) {
		throw new Error(`fs.list: not a directory: ${params.path}`);
	}
	const names = fs.readdirSync(target);
	const entries = names.map((name) => {
		const child = path.join(target, name);
		try {
			const st = fs.statSync(child);
			const kind: "file" | "dir" = st.isDirectory() ? "dir" : "file";
			const out: {
				name: string;
				kind: "file" | "dir";
				size: number;
				mtime: number;
				mime: string;
				sha256?: string;
			} = {
				name,
				kind,
				size: st.size,
				mtime: st.mtimeMs,
				mime: kind === "dir" ? "inode/directory" : mimeOf(child),
			};
			if (kind === "file" && params.computeSha256) {
				const sha = sha256OfFile(child);
				if (sha) out.sha256 = sha;
			}
			return out;
		} catch {
			return { name, kind: "file" as const, size: 0, mtime: 0, mime: "" };
		}
	});
	return { entries };
};

export const fsRead: JsonRpcHandler = (raw) => {
	const params = raw as FsReadParams;
	const root = workspaceRoot(params.workspaceId);
	const target = assertInWorkspace(root, params.path);
	const stat = fs.statSync(target);
	if (!stat.isFile()) throw new Error(`fs.read: not a file: ${params.path}`);
	if (stat.size > 25 * 1024 * 1024) {
		throw new Error(`fs.read: file too large (>25MB): ${params.path}`);
	}
	const mime = mimeOf(target);
	const isText =
		mime.startsWith("text/") ||
		mime.includes("json") ||
		mime.includes("yaml") ||
		mime.includes("javascript") ||
		mime.includes("typescript") ||
		mime.includes("toml") ||
		mime === "image/svg+xml";
	if (isText) {
		return { content: fs.readFileSync(target, "utf-8"), mime };
	}
	return { content: fs.readFileSync(target).toString("base64"), mime, encoding: "base64" };
};

export const fsWrite: JsonRpcHandler = (raw, ctx: JsonRpcContext) => {
	const params = raw as FsWriteParams;
	const root = workspaceRoot(params.workspaceId);
	const target = assertInWorkspace(root, params.path);
	enforceSensitiveGate("write", params, target, ctx.initiator);
	// Ensure parent dir exists.
	const parent = path.dirname(target);
	if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
	fs.writeFileSync(target, params.content);
	return { bytesWritten: Buffer.byteLength(params.content) };
};

export const fsEdit: JsonRpcHandler = (raw, ctx: JsonRpcContext) => {
	const params = raw as FsEditParams;
	const root = workspaceRoot(params.workspaceId);
	const target = assertInWorkspace(root, params.path);
	enforceSensitiveGate("edit", params, target, ctx.initiator);
	if (!fs.existsSync(target)) throw new Error(`fs.edit: file not found: ${params.path}`);
	const before = fs.readFileSync(target, "utf-8");
	if (!before.includes(params.oldString)) {
		throw new Error("fs.edit: oldString not found");
	}
	if (!params.replaceAll) {
		const occurrences = before.split(params.oldString).length - 1;
		if (occurrences > 1) {
			throw new Error(
				`fs.edit: oldString appears ${occurrences} times; pass replaceAll=true to replace all`,
			);
		}
	}
	const after = params.replaceAll
		? before.split(params.oldString).join(params.newString)
		: before.replace(params.oldString, params.newString);
	fs.writeFileSync(target, after);
	return { ok: true };
};

export const fsDelete: JsonRpcHandler = (raw, ctx: JsonRpcContext) => {
	const params = raw as FsDeleteParams;
	const root = workspaceRoot(params.workspaceId);
	const target = assertInWorkspace(root, params.path);
	enforceSensitiveGate("delete", params, target, ctx.initiator);
	if (!fs.existsSync(target)) return { ok: false };
	const stat = fs.statSync(target);
	if (stat.isDirectory()) {
		const recursive = params.recursive === true;
		if (!recursive) {
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(target);
			} catch {
				entries = [];
			}
			if (entries.length > 0) {
				throw new Error(
					`fs.delete: directory not empty (${entries.length} entries); pass recursive=true to remove`,
				);
			}
			fs.rmdirSync(target);
		} else {
			fs.rmSync(target, { recursive: true, force: true });
		}
	} else {
		fs.unlinkSync(target);
	}
	return { ok: true };
};

export const fsStat: JsonRpcHandler = (raw) => {
	const params = raw as FsStatParams;
	const root = workspaceRoot(params.workspaceId);
	const target = assertInWorkspace(root, params.path);
	const stat = fs.statSync(target);
	const kind: "file" | "dir" = stat.isDirectory() ? "dir" : "file";
	const out: {
		size: number;
		mtime: number;
		mime: string;
		kind: "file" | "dir";
		sha256?: string;
	} = {
		size: stat.size,
		mtime: stat.mtimeMs,
		mime: kind === "dir" ? "inode/directory" : mimeOf(target),
		kind,
	};
	if (kind === "file" && params.computeSha256) {
		const sha = sha256OfFile(target);
		if (sha) out.sha256 = sha;
	}
	return out;
};

// ── Exec policy ───────────────────────────────────────────────────────

/** Daemon-local allowlist of safe basics. Anything not on this list goes
 * through the policy engine for require_approval / block. */
const COMMAND_ALLOWLIST = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"find",
	"wc",
	"echo",
	"pwd",
	"git",
	"bun",
	"npm",
	"node",
	"python",
	"python3",
]);

/** Git subcommands that are read-only enough to allow without policy. */
const GIT_SAFE_SUBS = new Set(["status", "diff", "log", "branch", "show", "rev-parse"]);

interface ExecPolicyResult {
	allowed: boolean;
	reason?: string;
	bypass?: boolean;
}

/**
 * Evaluate a shell command against the daemon's exec policy.
 *
 * The security boundary is `COMMAND_ALLOWLIST` plus the per-pipeline-segment
 * verb check below. The allowlist is deny-by-default: anything not on it is
 * rejected (or escalated through the NemoClaw policy engine). We do NOT keep
 * a parallel hard-deny regex list — it would only catch the most naive
 * obfuscations and create a false sense of completeness. Trust the
 * allowlist; do not pretend a finite regex set can enumerate "bad shell".
 */
function evaluateExec(command: string): ExecPolicyResult {
	if (process.env.EIGHT_LEGACY_BASH === "1") {
		console.warn(
			"[fs.exec] EIGHT_LEGACY_BASH=1 is set; bypassing daemon allowlist (legacy mode, removed next release)",
		);
		return { allowed: true, bypass: true };
	}

	const trimmed = command.trim();
	if (!trimmed) return { allowed: false, reason: "empty command" };

	// Pipelines / && / ; - split and verify every leg's head verb is allow-listed.
	const segments = trimmed.split(/\s*(?:\|\||\||&&|;)\s*/g);
	for (const seg of segments) {
		const head = seg.trim().split(/\s+/)[0] ?? "";
		// Strip leading env-var assignments (FOO=bar BAZ=qux cmd ...).
		let verb = head;
		let rest = seg.trim();
		while (/^[A-Za-z_][A-Za-z0-9_]*=\S*/.test(verb)) {
			rest = rest.replace(/^\S+\s*/, "");
			verb = rest.split(/\s+/)[0] ?? "";
		}
		if (!verb) return { allowed: false, reason: "empty pipeline segment" };
		// Strip leading `-l` shell-login flag attempts on the verb itself.
		if (verb === "-l") return { allowed: false, reason: "login-flag injection" };
		if (!COMMAND_ALLOWLIST.has(verb)) {
			// Daemon layer is deny-by-default for fs.exec. We still consult
			// the policy engine first: if the engine has an explicit
			// require_approval rule, surface that reason. Otherwise reject
			// with a clean "not on allowlist" message so callers know to add
			// the verb to the allowlist (or prompt the user out-of-band).
			const decision = evaluatePolicy("run_command", { command: seg.trim() });
			if (!decision.allowed) {
				return {
					allowed: false,
					reason: decision.requiresApproval
						? `requires approval: ${decision.reason}`
						: decision.reason ?? `not on allowlist: ${verb}`,
				};
			}
			return {
				allowed: false,
				reason: `not on daemon allowlist: ${verb}`,
			};
		}
		// git subcommand check.
		if (verb === "git") {
			const sub = rest.split(/\s+/)[1] ?? "";
			if (!GIT_SAFE_SUBS.has(sub)) {
				const decision = evaluatePolicy("run_command", { command: seg.trim() });
				if (!decision.allowed) {
					return {
						allowed: false,
						reason: `git subcommand not safe: ${sub}`,
					};
				}
			}
		}
	}

	return { allowed: true };
}

export const fsExec: JsonRpcHandler = async (raw, ctx: JsonRpcContext) => {
	const params = raw as FsExecParams;
	if (!params?.command) throw new Error("fs.exec: missing command");
	if (!params?.conversationId) throw new Error("fs.exec: missing conversationId");
	const initiator = params.initiator ?? ctx.initiator;
	const root = workspaceRoot(params.workspaceId);

	const policy = evaluateExec(params.command);
	if (!policy.allowed) {
		logExecOp({
			op: "denied",
			command: params.command,
			workspaceId: params.workspaceId,
			workspaceRoot: root,
			conversationId: params.conversationId,
			initiator,
			reason: policy.reason,
		});
		throw new JsonRpcError(JSONRPC_BLOCKED, "command denied", {
			blocked: true,
			reason: policy.reason,
		});
	}

	const start = Date.now();
	const child = Bun.spawn(["/bin/sh", "-c", params.command], {
		cwd: root,
		env: {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: process.env.HOME ?? root,
			LANG: process.env.LANG ?? "en_US.UTF-8",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const killTimer = setTimeout(() => {
		try {
			child.kill();
		} catch {}
	}, 30_000);
	let stdout = "";
	let stderr = "";
	try {
		const [out, err, exitCode] = await Promise.all([
			new Response(child.stdout as ReadableStream).text(),
			new Response(child.stderr as ReadableStream).text(),
			child.exited,
		]);
		stdout = out.length > 1_000_000 ? `${out.slice(0, 1_000_000)}\n...[truncated at 1MB]` : out;
		stderr = err.length > 200_000 ? `${err.slice(0, 200_000)}\n...[truncated]` : err;
		clearTimeout(killTimer);
		const result = { stdout, stderr, exitCode: typeof exitCode === "number" ? exitCode : -1 };
		logExecOp({
			op: "exec",
			command: params.command,
			workspaceId: params.workspaceId,
			workspaceRoot: root,
			conversationId: params.conversationId,
			initiator,
			exitCode: result.exitCode,
			durationMs: Date.now() - start,
			bypass: policy.bypass,
		});
		return result;
	} catch (err) {
		clearTimeout(killTimer);
		try {
			child.kill();
		} catch {}
		const message = err instanceof Error ? err.message : String(err);
		logExecOp({
			op: "exec",
			command: params.command,
			workspaceId: params.workspaceId,
			workspaceRoot: root,
			conversationId: params.conversationId,
			initiator,
			exitCode: -1,
			durationMs: Date.now() - start,
			bypass: policy.bypass,
			reason: message,
		});
		return { stdout: "", stderr: message, exitCode: -1 };
	}
};

// Test hook
export function _evaluateExecForTest(command: string): ExecPolicyResult {
	return evaluateExec(command);
}

export function _assertInWorkspaceForTest(root: string, target: string): string {
	return assertInWorkspace(root, target);
}
