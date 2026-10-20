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
 * daemon-local allowlist (`COMMAND_ALLOWLIST`). Before either runs, `execRefusal`
 * applies the engine's shell chain (sanitizer, wipe guard, pre-spawn backstops);
 * the allowlist is an extra layer, never the only one.
 * There is no bypass: the same chain and allowlist run whatever the environment says.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { killProcessTree, shellInvocation } from "../../../core/shell";
import { getWorkspaceDb } from "../../../db/src/workspace-db";
import { blockedReason, commandArgvs } from "../../../permissions/always-blocked";
import { evaluatePolicy } from "../../../permissions/policy-engine";
import { preSpawnRefusal } from "../../../permissions/pre-spawn-backstops";
import { refusalLead } from "../../../permissions/refusal-lead";
import { sanitizeShellCommand } from "../../../permissions/shell-sanitizer";
import { isWithinWorkspace, resolveSafe } from "../../../permissions/src/workspace-boundary";
import { logExecOp, logFsSensitive } from "./audit";
import { JSONRPC_BLOCKED, type JsonRpcContext, JsonRpcError, type JsonRpcHandler } from "./jsonrpc";
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

/** Permissive but bounded workspaceId charset. Prevents KV-key injection
 *  and keeps ids file-system friendly. */
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

/**
 * fs.register - tell the daemon that `workspaceId` maps to the directory
 * at `root`. Required before any fs.list / fs.read / fs.write call on that
 * id; without it, every op rejects with "unknown workspaceId". Idempotent:
 * re-registering an id with the same (or a different) root just updates
 * the mapping. The reserved id "default" cannot be registered through this
 * RPC - it always resolves via EIGHT_WORKSPACE_ROOT / process.cwd().
 */
export const fsRegister: JsonRpcHandler = (raw) => {
	const params = raw as { workspaceId?: string; root?: string } | undefined;
	if (!params?.workspaceId) {
		throw new Error("fs.register: missing workspaceId");
	}
	if (!params?.root) {
		throw new Error("fs.register: missing root");
	}
	const { workspaceId, root } = params;
	if (workspaceId === "default") {
		throw new Error("fs.register: 'default' is reserved");
	}
	if (!WORKSPACE_ID_RE.test(workspaceId)) {
		throw new Error("fs.register: invalid workspaceId (allowed: [A-Za-z0-9_.-], max 128 chars)");
	}
	if (!fs.existsSync(root)) {
		throw new Error(`fs.register: root does not exist: ${root}`);
	}
	const realRoot = fs.realpathSync(root);
	const stat = fs.statSync(realRoot);
	if (!stat.isDirectory()) {
		throw new Error(`fs.register: root is not a directory: ${realRoot}`);
	}
	if (realRoot === path.parse(realRoot).root) {
		throw new Error("fs.register: refusing to register filesystem root");
	}
	_registerWorkspace(workspaceId, realRoot);
	return { ok: true, workspaceId, root: realRoot };
};

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
	"xargs",
]);

/** Git subcommands that are read-only enough to allow without policy. */
const GIT_SAFE_SUBS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"blame",
	"rev-parse",
	"ls-files",
	"branch",
	"tag",
]);

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
 * a parallel hard-deny regex list: it would only catch the most naive
 * obfuscations and create a false sense of completeness. Trust the
 * allowlist; do not pretend a finite regex set can enumerate "bad shell".
 */
function evaluateExec(command: string): ExecPolicyResult {
	// EIGHT_LEGACY_BASH no longer bypasses anything: this route has no approval card, so it is
	// strictly confined and the same chain and allowlist run whatever the environment says.
	const trimmed = command.trim();
	if (!trimmed) return { allowed: false, reason: "empty command" };

	// Pipelines / && / ; - split and verify every leg's head verb is allow-listed.
	const segments = trimmed.split(/\s*(?:\|\||\||&&|;)\s*/g);
	for (const seg of segments) {
		const head = seg.trim().split(/\s+/)[0] ?? "";
		// An env-assignment prefix (FOO=bar cmd) sets what the command runs under: refused.
		const verb = head;
		const rest = seg.trim();
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(verb)) {
			return { allowed: false, reason: "environment assignment before a command" };
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
						: (decision.reason ?? `not on allowlist: ${verb}`),
				};
			}
			return {
				allowed: false,
				reason: `not on daemon allowlist: ${verb}`,
			};
		}
		// git subcommand check: the first word after git must be a safe subcommand; no policy-engine fallback.
		if (verb === "git") {
			const sub = rest.split(/\s+/)[1] ?? "";
			if (!GIT_SAFE_SUBS.has(sub)) {
				return { allowed: false, reason: `git subcommand not safe: ${sub}` };
			}
		}
	}

	return { allowed: true };
}

const OPTION_VALUE = /^-[-A-Za-z0-9]*=/;
const GIT_REFUSED_FLAG =
	/^(--config.*|--exec-path.*|--output.*|--ext-diff|--textconv|--open-files-in-pager.*|--upload-pack.*|--receive-pack.*|-O.*|--git-dir.*|--work-tree.*|--namespace.*)$/;
const RG_REFUSED_FLAG = /^(--pre|--pre=.*|--pre-glob.*|--hostname-bin.*|-z|--search-zip)$/;

function insideRoot(root: string, target: string): boolean {
	const rel = path.relative(root, path.resolve(root, target));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A word that names a place the route cannot prove is inside root: absolute, ~, ..-escaping, or an expansion. */
/** A glob that could expand to `..` (.?, .*, [.][.], [!a][!a]): the shell reads it, not the lexical check. */
function globReachesParent(word: string): boolean {
	const w = word.replace(OPTION_VALUE, "").replace(/^['"]|['"]$/g, "");
	return w.split(/[\\/]+/).some((c) => /[*?[]/.test(c) && (c.startsWith(".") || c.startsWith("[")));
}

function escapesRoot(root: string, word: string): boolean {
	const w = word.replace(OPTION_VALUE, "").replace(/^['"]|['"]$/g, "");
	if (/\$[A-Za-z_{(]|`/.test(w)) return true;
	if (w.startsWith("~")) return true;
	if (w === "/dev/null") return false;
	if (globReachesParent(w)) return true;
	return !realInsideRoot(root, w);
}

const GIT_LIST_FLAG = /^(-l|--list|--contains|--merged|--no-merged|--points-at)$/;
const GIT_READ_FLAG =
	/^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--no-color|--color(=.*)?|--sort=.*|--format=.*|--no-column|--column(=.*)?)$/;

/** `git branch` / `git tag` that only lists: read-only flags, and names only as list patterns or ref filters. */
function gitListOnly(rest: string[]): boolean {
	const listing = rest.some((w) => GIT_LIST_FLAG.test(w));
	return rest.every((w) =>
		w.startsWith("-") ? GIT_LIST_FLAG.test(w) || GIT_READ_FLAG.test(w) : listing,
	);
}

/**
 * Walk `word` component by component from root (or /), following every symlink that exists, so a
 * link inside root that points out is seen. A component that does not exist stays lexical, which is
 * judging a dangling path by its nearest existing ancestor.
 */
function realInsideRoot(root: string, word: string): boolean {
	let realRoot = root;
	try {
		realRoot = fs.realpathSync(root);
	} catch {}
	let cur = path.isAbsolute(word) ? path.parse(word).root : realRoot;
	for (const comp of word.split(/[\\/]+/)) {
		if (comp === "" || comp === ".") continue;
		if (comp === "..") {
			cur = path.dirname(cur);
			continue;
		}
		const next = path.join(cur, comp);
		try {
			cur = fs.realpathSync(next);
		} catch {
			cur = next;
		}
	}
	return insideRoot(realRoot, cur);
}

/** The first reason `command` leaves root or runs something the route cannot confine, or null. */
function confinementRefusal(command: string, root: string): string | null {
	const deny = (why: string) =>
		refusalLead(`[PERMISSION DENIED] ${why}. This route has no approval card. Command: ${command}`);
	// Redirect targets (> >> <), judged on the line itself: the engine's parse drops them.
	for (const m of command.matchAll(/(?:^|[^<>&\d-])\d*(>>?|<(?!<))\s*([^\s;&|<>()]+)/g)) {
		const target = m[2].replace(/^['"]|['"]$/g, "");
		if (target === "/dev/null") continue;
		if (escapesRoot(root, target)) return deny("A redirect reaches outside the workspace");
		if (m[1] !== "<") {
			const c = classifySensitivePath(path.resolve(root, target));
			if (c.sensitive || c.forbidden)
				return deny("A redirect writes a sensitive or git-internal path");
		}
	}
	for (const argv of commandArgvs(command)) {
		const name = path.basename(argv[0] ?? "").toLowerCase();
		if (name && !COMMAND_ALLOWLIST.has(name) && !name.startsWith("-") && !DELETE_VERBS.has(name)) {
			return deny(`${name} is not on the daemon allowlist`);
		}
		for (const w of argv.slice(1)) {
			if (globReachesParent(w)) {
				return deny(
					"This operand looks like a glob that could reach the parent directory. Rephrase it or quote it differently",
				);
			}
			if (escapesRoot(root, w)) return deny("A path reaches outside the workspace");
			if (name === "git") {
				if (GIT_REFUSED_FLAG.test(w))
					return deny("That git option can run a program or move the repository");
			}
			if ((name === "rg" || name === "grep") && RG_REFUSED_FLAG.test(w)) {
				return deny("That search option runs a program");
			}
		}
		if (
			name === "git" &&
			(argv[1] === "branch" || argv[1] === "tag") &&
			!gitListOnly(argv.slice(2))
		) {
			return deny("git branch and git tag are accepted only to list");
		}
		if (name === "git") {
			const sub = argv.findIndex((w, i) => i > 0 && !w.startsWith("-"));
			const flagsBefore = argv.slice(1, sub === -1 ? undefined : sub);
			if (flagsBefore.some((w) => w === "-c" || w === "-C" || w.startsWith("-c"))) {
				return deny("git configuration or directory flags are not accepted");
			}
		}
	}
	return null;
}

const DELETE_VERBS = new Set(["rm", "rmdir", "unlink", "shred"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * The refusal for `command` from the same chain the TUI's run_command runs before it spawns
 * (preSpawnRefusal, sanitizeShellCommand, blockedReason over every command on the line), in the
 * engine's own words; null when the chain refuses nothing. The verb allowlist is an extra layer
 * on top of this, never the only one. Then two route-local rules for what the TUI would put to a
 * person: this route has no approval card, so `find` that deletes or runs commands, and a heredoc
 * that writes a file, are refused outright (fs.write is the route for writing).
 */
export function execRefusal(command: string, cwd: string): string | null {
	const backstop = preSpawnRefusal(command, cwd);
	if (backstop) return refusalLead(backstop);
	const validation = sanitizeShellCommand(command);
	if (!validation.safe) {
		return refusalLead(`[BLOCKED] ${validation.reason}. Command: ${command}`);
	}
	// Fail-closed: a throw from the engine propagates and the command is not spawned.
	for (const argv of commandArgvs(command)) {
		const reason = blockedReason(argv);
		if (reason) return refusalLead(`[PERMISSION DENIED] ${reason}. Command: ${command}`);
	}
	for (const argv of commandArgvs(command)) {
		const name = path.basename(argv[0] ?? "").toLowerCase();
		if (
			name === "find" &&
			argv.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a))
		) {
			return refusalLead(
				`[PERMISSION DENIED] find that deletes, writes or runs commands needs an approval this route cannot ask for. Command: ${command}`,
			);
		}
	}
	const confined = confinementRefusal(command, cwd);
	if (confined) return confined;
	// A delete verb fed its paths on stdin (`find ... -print0 | xargs -0 <verb>`): the engine's parse drops
	// xargs and leaves the bare verb, so a delete verb with no path operand is such a feed. A delete
	// verb named behind xargs, parallel or a shell -c is refused too.
	for (const argv of commandArgvs(command)) {
		const name = path.basename(argv[0] ?? "").toLowerCase();
		const feeder = name === "xargs" || name === "parallel" || SHELLS.has(name);
		const bare = DELETE_VERBS.has(name) && !argv.slice(1).some((a) => !a.startsWith("-"));
		const delegated =
			feeder && argv.slice(1).some((a) => DELETE_VERBS.has(path.basename(a).toLowerCase()));
		if (bare || delegated) {
			return refusalLead(
				`[PERMISSION DENIED] A delete that takes its paths from another command needs an approval this route cannot ask for. Command: ${command}`,
			);
		}
	}
	if (/<<(?!<)/.test(command)) {
		return refusalLead(
			`[PERMISSION DENIED] Use fs.write to create or change a file; a heredoc is not accepted on fs.exec. Command: ${command}`,
		);
	}
	return null;
}

export const fsExec: JsonRpcHandler = async (raw, ctx: JsonRpcContext) => {
	const params = raw as FsExecParams;
	if (!params?.command) throw new Error("fs.exec: missing command");
	if (!params?.conversationId) throw new Error("fs.exec: missing conversationId");
	const initiator = params.initiator ?? ctx.initiator;
	const root = workspaceRoot(params.workspaceId);

	// The engine's chain runs first and always: the allowlist is not the only gate.
	const refusal = execRefusal(params.command, root);
	const policy: ExecPolicyResult = refusal
		? { allowed: false, reason: refusal }
		: evaluateExec(params.command);
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
	const sh = shellInvocation(params.command, { posix: ["/bin/sh", "-c"] });
	const child = Bun.spawn([sh.file, ...sh.args], {
		cwd: root,
		env: {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: process.env.HOME ?? root,
			LANG: process.env.LANG ?? "en_US.UTF-8",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		windowsVerbatimArguments: sh.windowsVerbatimArguments,
	});
	const killTimer = setTimeout(() => killProcessTree(child.pid, "SIGTERM"), 30_000);
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
