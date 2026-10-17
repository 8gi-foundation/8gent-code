/**
 * 8gent Code - Tool Executor
 *
 * Defines all tools available to the agent and handles their execution.
 * This is the bridge between LLM tool calls and actual system operations.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtractVideoMode, extractVideo, formatExtractVideoResult } from "@8gent/eyes/marlin";
import { z } from "zod";
import {
	type FormattingStop,
	checkDraftConstraints,
	describeFailures,
	namedSources,
} from "../ai/draft-constraints";
import { withImagesWritten } from "../ai/image-shape";
import {
	type Attachment,
	POST_MESSAGE_TOOL_DEF,
	postMessage,
	postMessageAvailable,
	postMessageDeps,
	resolveAttachment,
} from "../ai/post-message";
import {
	IMAGE_ATTACHMENT_MARKER,
	IMAGE_ATTACHMENT_TOOL,
	hasImageAttachmentLine,
	imageAttachmentResult,
} from "../ai/text-tool-loop";
import { PLAN_STATUSES, UPDATE_PLAN_DESCRIPTION, updatePlan } from "../ai/update-plan";
import { writeScopeLine } from "../ai/write-scope";
import { writeShapeLine } from "../ai/write-shape";
import {
	type FileOutline,
	type RepoIndex,
	ensureIndexed as astEnsureIndexed,
	getFileOutline as astGetFileOutline,
	getFileTree as astGetFileTree,
	getFreshFileOutline as astGetFreshFileOutline,
	listRepos as astListRepos,
	refreshIndex as astRefreshIndex,
	searchSymbols as astSearchSymbols,
} from "../ast-index";
import {
	LOCATE_INDEX_WAIT_MS,
	locate as astLocate,
	awaitIndex,
	formatLocate,
} from "../ast-index/locate";
import { getSymbolSource, parseTypeScriptFile } from "../ast-index/typescript-parser";
import {
	addToSafeList as computerAddToSafeList,
	click as computerClick,
	clipboardGet as computerClipboardGet,
	clipboardSet as computerClipboardSet,
	drag as computerDrag,
	hover as computerHover,
	listProcesses as computerListProcesses,
	loadSafeList as computerLoadSafeList,
	mousePosition as computerMousePosition,
	press as computerPress,
	quitByName as computerQuitByName,
	quitProcess as computerQuitProcess,
	removeFromSafeList as computerRemoveFromSafeList,
	screenshot as computerScreenshot,
	scroll as computerScroll,
	suggestQuittable as computerSuggestQuittable,
	typeText as computerType,
	windowList as computerWindowList,
	decodeCoordMap,
	getToolDefinitions as getComputerToolDefs,
	imageToDesktop,
} from "../computer";
import {
	DESKTOP_ACT_TOOL_DEF,
	DesktopActSession,
	desktopAct,
	detectScreenScale,
	validateDesktopActArgs,
} from "../computer/desktop-act";
import {
	askOnTerminal,
	desktopApprovalCard,
	desktopApprovalDetails,
	redactDesktopArgs,
} from "../computer/desktop-approval";
import { DESKTOP_POLICY_ACTION, desktopPolicyContext } from "../computer/desktop-policy";
import { desktopPreflight } from "../computer/preflight";
import {
	type ResolvedShell,
	activeShellKind,
	killProcessTree,
	resolvePowerShell,
	spawnShell,
	withForcedShell,
} from "../core/shell";
import { deckVideoAfterWrite } from "../deck/auto";
import {
	detectDesignNeed,
	getAvailableDesignSystems,
	needsDesignDecision,
	suggestDesignSystems,
} from "../design-agent/index.js";
import {
	findByMood as findDesignByMood,
	findByStyle as findDesignByStyle,
	generateCssVariables,
	generateTailwindConfig,
	getComplete as getCompleteDesignSystem,
	getHexPalette,
	initDatabase as initDesignDb,
	listAll as listAllDesignSystems,
	listMoods as listDesignMoods,
	listStyles as listDesignStyles,
	search as searchDesignSystems_db,
	suggestForProject as suggestDesignForProject,
} from "../design-systems/index.js";
import { filmCraft } from "../film-craft/index";
import { type HookManager, getHookManager } from "../hooks";
import { type InfiniteRunner, createInfiniteRunner, formatInfiniteState } from "../infinite";
import {
	lspDiagnostics,
	lspDocumentSymbols,
	lspFindReferences,
	lspGoToDefinition,
	lspHover,
} from "../lsp";
import { formatToolResult, getMCPClient } from "../mcp";
import { getMemoryManager } from "../memory";
import {
	ALLOWED_PATHS_DESCRIPTION,
	CHECK_AGENT_DESCRIPTION,
	LIST_AGENTS_DESCRIPTION,
	PERMISSION_MODE_DESCRIPTION,
	SPAWN_AGENT_DESCRIPTION,
	SPAWN_MODEL_DESCRIPTION,
	SPAWN_RUNTIME_DESCRIPTION,
	checkAgentTool,
	listAgentsTool,
	spawnAgentTool,
} from "../orchestration/delegation-tools";
import {
	type PermissionManager,
	channelDenialMessage,
	getPermissionManager,
	isCommandDangerous,
} from "../permissions";
import {
	cdPrefix,
	chainInFolderNote,
	commandAfterCdPrefix,
	commandInFolder,
	folderLabel,
} from "../permissions/cd-prefix";
import { commandDir, withCommandDir } from "../permissions/command-policy";
import {
	editScopeViolation,
	emptyOldTextError,
	filmCraftWriteTargets,
	normaliseAllowedPaths,
} from "../permissions/edit-guards";
import {
	MakerCheckerBlockedError,
	assertMakerCheckerApproved,
} from "../permissions/maker-checker-enforcer";
import {
	MCP_POLICY_ACTION,
	askMcpApproval,
	askMcpStartApproval,
	mcpPolicyContext,
} from "../permissions/mcp-gate";
import { filterToolOutput } from "../permissions/output-filter";
import { type PathAccess, validatePath as guardPath } from "../permissions/path-guard.js";
import {
	type PermissionModeHolder,
	currentPermissionHolder,
	currentPermissionMode,
	guardedSkipsCard,
	planModeRefusal,
	runWithPermissionHolder,
	systemOneEnvFor,
} from "../permissions/permission-mode";
import { preSpawnRefusal } from "../permissions/pre-spawn-backstops";
import { REFUSAL_LEAD, REFUSAL_NOTE, refusalLead } from "../permissions/refusal-lead";
import { runCommandSandboxRefusal, wrapRunCommand } from "../permissions/run-command-sandbox";
import {
	CreatedFiles,
	pathAbsent,
	watchRedirects,
	watchWrite,
} from "../permissions/s1-created-files";
import { sanitizeShellCommand } from "../permissions/shell-sanitizer";
import { systemOneGate, systemOneMode } from "../permissions/system-one-gate";
import { ToolG8 } from "../permissions/toolg8.js";
import { hasTuiApprovalHandler, requestTuiApproval } from "../permissions/tui-approval-channel";
import type { PolicyActionType } from "../permissions/types.js";
import { gateWriteTool } from "../permissions/write-content-gate.js";
import {
	WRITE_CONTENT_TOOLS,
	applyAt,
	blockedToolMessage,
	editRefusal,
	logEditRefusal,
	resolveEdit,
	writtenContentFor,
} from "../permissions/write-content-gate.js";
import { loadSettings } from "../settings/store";
import { formatTaskOutput, formatTaskStatus, getBackgroundTaskManager } from "../tools/background";
import { browserOpen, browserScreenshot, browserState, browserTask } from "../tools/browser-use";
import {
	ANCHORED_NEWTEXT_DESC,
	ANCHOR_PARAM_DESC,
	HASHLINE_EDIT_DESC,
	HASHLINE_READ_DESC,
	OPTIONAL_OLDTEXT_DESC,
	anchoredEditMessage,
	applyAnchoredEdit,
	hashLines,
	hashlineEnabled,
} from "../tools/edit-anchor";
import { createEightBrowser, isolatedBrowser } from "../tools/eight-browser";
import { describeImage, readImage, resizeImage } from "../tools/image";
import { deleteCell, editCell, insertCell, readNotebook } from "../tools/notebook";
import { DocxSpecSchema } from "../tools/office/docx";
import { PptxSpecSchema } from "../tools/office/pptx";
import { isOfficeFile, readOfficeFile } from "../tools/office/read";
import { XlsxSpecSchema } from "../tools/office/xlsx";
import { readPdf, readPdfPage, searchPdf } from "../tools/pdf";
import { RateLimiter } from "../tools/rate-limiter";
import {
	vercelDeploy,
	vercelGetDeploymentLogs,
	vercelGetDeployments,
	vercelGetEnv,
	vercelListDomains,
	vercelListProjects,
	vercelSetEnv,
} from "../tools/vercel";
import {
	DeckSpecSchema,
	RENDER_VIDEO_DECK_DESCRIPTION,
	chaptersPathFor,
} from "../tools/video-deck";
import { formatFetchResult, formatSearchResults, webFetch, webSearch } from "../tools/web";
import { isNoToolScope } from "./agent-scopes";
import { ArtifactStore } from "./artifact-store";
import { formatCommandOutput } from "./command-output";
import { CommitGate, type CommitTarget, parseGitCommit } from "./commit-gate";
import { formatEditNotFound } from "./edit-hint";
import { linksFooter } from "./file-links";
import {
	ENV_PASS_HINT,
	GH_ENV_NAMES,
	GIT_ENV_NAMES,
	buildChildEnv,
	withheldAny,
} from "./harness/child-env";
import { downscaleNote, imageMaxSide } from "./image-fit";
import { IssueBlameGate, issueBodyOf } from "./issue-blame";
import { layoutMeasureLine } from "./layout-measure";
import { MESSAGE_BOARDROOM_TOOL_DEF, messageBoardroom } from "./message-boardroom";
import { decideOpenOnWrite, openWrittenFile } from "./open-on-write";
import { RetiredFacts } from "./retired-facts";
import { ensureScratchExcludedIfPresent } from "./scratch-exclude";
import { scrubKeepingAttachment, scrub as scrubSecrets } from "./secret-scanner";
import { executeTermTool, getTermToolDefs, isTermTool } from "./term-tools.js";
import { USE_SKILL_DESCRIPTION, useSkill } from "./use-skill";
import { type VisionRouterResult, findVisionModel } from "./vision-router";

/**
 * A chained command the sanitizer refuses comes back as its pieces, so a piece
 * System One's loopback lane will refuse on its own is named in the same
 * refusal (#4072). The browser-op pilot sent `curl -sL ...; cat ...`, was told
 * only to split it, resent the curl with -L and was blocked a second time.
 * Only the lane's deterministic refusal is used, only in the mode where the
 * lane runs (system-one-gate), so this never says more than System One would.
 * A piece that is not a loopback curl, or a split that lands inside quotes,
 * gives no hint rather than a wrong one.
 */
export async function chainedPieceRefusal(
	command: string,
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
	if (systemOneMode(env) !== "default") return undefined;
	const { curlToLoopback } = await import("../permissions/s1-curl-loopback");
	for (const piece of command.split(/;|&&|\|\|/)) {
		const c = curlToLoopback(piece.trim(), cwd);
		if (!c.ok && c.refuse) return c.refuse;
	}
	return undefined;
}

/**
 * Replay class per tool (#3653), used when a crashed session resumes with a
 * tool call that was still running (EIGHT_RESUME_ON_BOOT=1).
 *  - "replay": a checked local read with no side effect; safe to run again.
 *  - "never":  writes, shell, git changes, messages, network and desktop
 *              actions; it may already have happened, so it is never rerun.
 *  - "ask":    anything not listed (the default); not rerun either, the
 *              model is told to check with the user first.
 */
export type ReplayClass = "replay" | "never" | "ask";

/**
 * Version of the replay policy below, written into the session journal.
 * RULE: bump this whenever REPLAY_SAFE_TOOLS, NEVER_REPLAY_TOOLS or
 * NEVER_REPLAY_PREFIXES change. Each journaled call also records the class it
 * started under, and resume refuses to re-run a call whose class has changed
 * since (8SO review, #4118).
 */
export const REPLAY_POLICY_VERSION = 3;

export function isReplayClass(v: unknown): v is ReplayClass {
	return v === "replay" || v === "never" || v === "ask";
}

/**
 * Only reads with no side effect that pass the same path and policy checks
 * as a live call: read_file (safePath + ToolG8 read_file) and git_log (no
 * repo-configured helpers run). Language-server tools can start a server that
 * runs project code; git status/diff can run fsmonitor, external diff and
 * textconv helpers; the PDF, notebook, outline and listing readers take paths
 * without the full checks. Those stay "ask" (#3653 review).
 */
/** message_boardroom is offered unless EIGHT_MESSAGE_BOARDROOM=0 (#4344). */
export function messageBoardroomOn(): boolean {
	return process.env.EIGHT_MESSAGE_BOARDROOM !== "0";
}

// Changing this set, NEVER_REPLAY_TOOLS or NEVER_REPLAY_PREFIXES: bump REPLAY_POLICY_VERSION.
const REPLAY_SAFE_TOOLS = new Set(["read_file", "git_log"]);

// Changing this set: bump REPLAY_POLICY_VERSION.
const NEVER_REPLAY_TOOLS = new Set([
	"write_file",
	"edit_file",
	"run_command",
	"powershell",
	"git_checkout",
	"git_create_branch",
	"git_add",
	"git_commit",
	"git_push",
	"gh_pr_create",
	"gh_issue_create",
	"post_message",
	"message_boardroom",
	"spawn_agent",
	"speak",
	"render_video_deck",
	"make_docx",
	"make_xlsx",
	"make_pptx",
	"notebook_edit_cell",
	"notebook_insert_cell",
	"notebook_delete_cell",
	"web_search",
	"web_fetch",
	"vercel_deploy",
	"vercel_set_env",
	"mcp_call_tool",
	"background_start",
	"remember",
	"enable_infinite_mode",
	"run_computer_task",
]);

/** Prefixes whose tools act on the desktop or a browser: never replayed. Changing: bump REPLAY_POLICY_VERSION. */
const NEVER_REPLAY_PREFIXES = ["desktop_", "browser_"];

export function toolReplayClass(toolName: string): ReplayClass {
	if (REPLAY_SAFE_TOOLS.has(toolName)) return "replay";
	if (NEVER_REPLAY_TOOLS.has(toolName)) return "never";
	if (NEVER_REPLAY_PREFIXES.some((p) => toolName.startsWith(p))) return "never";
	return "ask";
}

/**
 * Validate that a user-provided path stays within the working directory.
 * Prevents path traversal attacks (../../etc/passwd).
 * Always normalizes the raw input - no pre-processing should be done by callers.
 */
export function safePath(userPath: string, workingDirectory: string, access: PathAccess): string {
	// Static credential / UNC / device guard runs FIRST so a misconfigured
	// workspace boundary cannot expose protected paths. Issue #2465.
	const guard = guardPath(userPath, workingDirectory, {}, access);
	if (!guard.ok) {
		throw new Error(`Path blocked by path-guard: ${guard.reason} ("${userPath}")`);
	}

	// Expand a leading `~` to the real home directory BEFORE normalizing, so a
	// model-supplied "~/notes.txt" resolves to the actual home path instead of
	// a literal "./~" directory (issue #2747, secondary).
	const expanded =
		userPath === "~"
			? os.homedir()
			: userPath.startsWith("~/")
				? path.join(os.homedir(), userPath.slice(2))
				: userPath;

	// Normalize first to collapse ../ sequences before resolving
	const normalized = path.normalize(expanded);
	const absolutePath = path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(workingDirectory, normalized);

	const normalizedBase = path.resolve(workingDirectory);
	const normalizedTarget = path.resolve(absolutePath);

	// Allow the working directory itself
	if (normalizedTarget === normalizedBase) return normalizedTarget;

	// Must be inside the working directory
	if (!normalizedTarget.startsWith(normalizedBase + path.sep)) {
		throw new Error(
			`Path traversal blocked: "${userPath}" resolves outside working directory. ` +
				`Files can only be read or written inside ${normalizedBase} - use a path inside that directory.`,
		);
	}

	return assertNoSymlinkEscape(normalizedTarget, normalizedBase, userPath);
}

/**
 * Lexical containment is not enough: a symlinked directory inside the workspace
 * lets a path that looks inside resolve outside (#3607). Resolve the nearest
 * existing ancestor of the target and require it inside the real workspace.
 * A symlink at the final component is followed to its fully resolved target,
 * which is returned (so a write lands on the target, e.g. CLAUDE.md -> AGENTS.md)
 * only when that target is inside the real workspace. Returns the path to use.
 */
function assertNoSymlinkEscape(target: string, base: string, userPath: string): string {
	const escape = () =>
		new Error(
			`Path escapes workspace via symlink: "${userPath}" points outside ${base}. ` +
				"Files can only be read or written inside the workspace.",
		);
	const inside = (real: string, realBase: string) =>
		real === realBase || real.startsWith(realBase + path.sep);

	let realBase: string;
	try {
		realBase = fs.realpathSync(base);
	} catch {
		return target; // workspace itself does not exist yet; nothing to escape through
	}

	let finalStat: fs.Stats | undefined;
	try {
		finalStat = fs.lstatSync(target, { throwIfNoEntry: false });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(
				`Refused: "${userPath}" passes through a symlink loop (not a symlink escape). Use a real path.`,
			);
		}
		throw err;
	}
	if (finalStat?.isSymbolicLink()) {
		let real: string;
		try {
			real = fs.realpathSync(target);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ELOOP") {
				throw new Error(
					`Refused: "${userPath}" is part of a symlink loop (not a symlink escape). Use a real path.`,
				);
			}
			// Dangling: say where it points. Inside the workspace the agent can write that path directly.
			let dest = "";
			try {
				dest = path.resolve(fs.realpathSync(path.dirname(target)), fs.readlinkSync(target));
			} catch {}
			if (dest && inside(dest, realBase)) {
				throw new Error(
					`Refused: "${userPath}" is a dangling symlink to ${dest} (inside the workspace, not an escape). ` +
						"Create or write that real path directly.",
				);
			}
			throw escape();
		}
		if (!inside(real, realBase)) throw escape();
		return real;
	}

	// Walk up to the nearest ancestor that exists (lstat, so a dangling link counts as existing).
	let ancestor = target;
	let realAncestor: string;
	try {
		while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
			const parent = path.dirname(ancestor);
			if (parent === ancestor) return target;
			ancestor = parent;
		}
		realAncestor = fs.realpathSync(ancestor);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(
				`Refused: "${userPath}" passes through a symlink loop (not a symlink escape). Use a real path.`,
			);
		}
		throw escape();
	}
	if (!inside(realAncestor, realBase)) throw escape();
	return target;
}

/**
 * Where speak may write: inside the working directory (safePath), .wav only.
 * Shared by the text-tool and native handlers.
 */
export function resolveSpeakOut(out: unknown, workingDirectory: string): string {
	const named = typeof out === "string" && out.trim() ? out.trim() : `speak-${Date.now()}.wav`;
	if (!named.toLowerCase().endsWith(".wav")) throw new Error(`out must end in .wav ("${named}")`);
	const target = safePath(named, workingDirectory, "write");
	// safePath is lexical. A directory symlink inside the workspace would carry the
	// write outside it, so check real locations: the nearest existing ancestor of the
	// parent must sit under the real workspace, and the file itself must not be a link.
	const root = fs.realpathSync(workingDirectory);
	let ancestor = path.dirname(target);
	while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
	const real = fs.realpathSync(ancestor);
	if (real !== root && !real.startsWith(root + path.sep)) {
		throw new Error(
			`Path traversal blocked: "${named}" resolves through a link outside the working directory`,
		);
	}
	try {
		if (fs.lstatSync(target).isSymbolicLink())
			throw new Error(`refusing to write through a symlink: "${named}"`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return target;
}

/** The nearest existing ancestor's real location must sit under the real workspace. */
function assertRealInside(target: string, named: string, workingDirectory: string): void {
	const root = fs.realpathSync(workingDirectory);
	let ancestor = target;
	while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
	const real = fs.realpathSync(ancestor);
	if (real !== root && !real.startsWith(root + path.sep)) {
		throw new Error(
			`Path traversal blocked: "${named}" resolves through a link outside the working directory`,
		);
	}
}

/**
 * A path a tool may write: inside the working directory (safePath, which is lexical), the real
 * location of its nearest existing parent inside the real workspace, and not itself a symlink.
 */
export function confineWrite(named: string, workingDirectory: string): string {
	const target = safePath(named, workingDirectory, "write");
	assertRealInside(path.dirname(target), named, workingDirectory);
	const st = fs.lstatSync(target, { throwIfNoEntry: false });
	if (st?.isSymbolicLink()) throw new Error(`refusing to write through a symlink: "${named}"`);
	return target;
}

/** Where render_video_deck may write: a .mp4 inside the working directory, no symlinks. */
export function resolveDeckOut(out: unknown, workingDirectory: string): string {
	const named = typeof out === "string" && out.trim() ? out.trim() : "deck.mp4";
	if (!named.toLowerCase().endsWith(".mp4")) throw new Error(`out must end in .mp4 ("${named}")`);
	return confineWrite(named, workingDirectory);
}

/** The chapters.txt a deck render writes beside its mp4, confined like the mp4 itself. */
export function resolveDeckChapters(out: string, workingDirectory: string): string {
	return confineWrite(chaptersPathFor(out), workingDirectory);
}

/** The office tools and the extension each one writes (#4274). */
export const OFFICE_TOOLS = { make_docx: "docx", make_xlsx: "xlsx", make_pptx: "pptx" } as const;
export type OfficeToolName = keyof typeof OFFICE_TOOLS;

export function isOfficeTool(name: string): name is OfficeToolName {
	return Object.hasOwn(OFFICE_TOOLS, name);
}

/**
 * Where make_docx / make_xlsx / make_pptx may write: a file with exactly that extension inside
 * the working directory, no symlinks. A macro-enabled name (.docm, .xlsm, .pptm) never matches.
 */
export function resolveOfficeOut(
	tool: OfficeToolName,
	out: unknown,
	workingDirectory: string,
): string {
	const ext = OFFICE_TOOLS[tool];
	const fallback = { docx: "document.docx", xlsx: "workbook.xlsx", pptx: "deck.pptx" }[ext];
	const named = typeof out === "string" && out.trim() ? out.trim() : fallback;
	if (!named.toLowerCase().endsWith(`.${ext}`))
		throw new Error(`out must end in .${ext} ("${named}")`);
	return confineWrite(named, workingDirectory);
}

/** A path a tool may read: inside the working directory after following every link. */
export function confineRead(named: string, workingDirectory: string): string {
	const target = safePath(named, workingDirectory, "read");
	assertRealInside(target, named, workingDirectory);
	return target;
}

/**
 * Execute a git command safely using spawn with argument arrays.
 * Prevents shell injection from LLM-generated arguments.
 */
const GIT_NON_INTERACTIVE_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "/usr/bin/true",
	SSH_ASKPASS: "/usr/bin/true",
	SSH_ASKPASS_REQUIRE: "force",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
};

const SPAWN_NON_INTERACTIVE_ENV = {
	...GIT_NON_INTERACTIVE_ENV,
	DEBIAN_FRONTEND: "noninteractive",
	NPM_CONFIG_YES: "true",
};

function spawnGit(args: string[], cwd: string): Promise<string> {
	const TIMEOUT_MS = 30_000;
	return new Promise(async (resolve) => {
		const { spawn } = await import("node:child_process");
		const proc = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: {
				...(buildChildEnv(process.env, GIT_ENV_NAMES) as NodeJS.ProcessEnv),
				...GIT_NON_INTERACTIVE_ENV,
			},
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		const timer = setTimeout(() => {
			killProcessTree(proc.pid, "SIGKILL");
			resolve(`TIMEOUT after ${TIMEOUT_MS / 1000}s: git ${args[0]}`);
		}, TIMEOUT_MS);
		const finish = (code: number | null) => {
			clearTimeout(timer);
			resolve(code === 0 ? stdout.trim() : `Error (exit ${code}): ${stderr.trim()}`);
		};
		proc.on("close", finish);
		proc.on("error", (err: Error) => {
			clearTimeout(timer);
			resolve(`Error: ${err.message}`);
		});
		proc.unref();
	});
}

// read_file line numbers (#3375): the `cat -n` gutter, a right-aligned number
// and a tab. Models cite line numbers from it instead of counting by hand.
// Exactly what numberLines emits: the number right-aligned in 6 columns (or
// wider past 999999), then a tab. A TSV row like "2024\tbudget" is not it.
const GUTTER = /^(?: {5}\d| {4}\d{2}| {3}\d{3}| {2}\d{4}| \d{5}|\d{6,})\t/;

/** Number `lines` as `cat -n` does, the first one being line `first`. */
export function numberLines(lines: string[], first: number): string {
	return lines.map((line, i) => `${String(first + i).padStart(6)}\t${line}`).join("\n");
}

const DIFF_FILE = /\.(diff|patch)$/i;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A unified diff with the patched file's line numbers in the gutter. The cat -n
 * numbers of a .diff are rows of the diff, and a reviewer cited them as source
 * lines (store.test.ts:75, a 12-line file). Added and context rows get their
 * line in the patched file; headers and removed rows get none. Null when the
 * text has no hunk, so a stray .patch file keeps the plain gutter.
 */
export function numberDiffLines(lines: string[]): string | null {
	let oldLeft = 0;
	let newLeft = 0;
	let next = 0;
	let hunks = 0;
	const blank = " ".repeat(6);
	const rows = lines.map((line) => {
		const h = oldLeft <= 0 && newLeft <= 0 ? HUNK.exec(line) : null;
		if (h) {
			hunks++;
			oldLeft = h[1] === undefined ? 1 : Number(h[1]);
			newLeft = h[3] === undefined ? 1 : Number(h[3]);
			next = Number(h[2]);
			return `${blank}\t${line}`;
		}
		if (oldLeft <= 0 && newLeft <= 0) return `${blank}\t${line}`;
		const c = line[0];
		if (c === "-") {
			oldLeft--;
			return `${blank}\t${line}`;
		}
		if (c === "\\") return `${blank}\t${line}`;
		if (c === "+") newLeft--;
		else {
			oldLeft--;
			newLeft--;
		}
		return `${String(next++).padStart(6)}\t${line}`;
	});
	if (hunks === 0) return null;
	const note =
		"[Unified diff. The numbers are line numbers in the patched file, blank on headers and removed lines. Cite those with the file named after +++, never a row of this diff.]";
	return `${note}\n${rows.join("\n")}`;
}

/** True when every non-empty line of `text` starts with a read_file gutter. */
export function hasLineNumberGutter(text: string): boolean {
	const rows = text.split("\n").filter((l) => l.trim() !== "");
	return rows.length > 0 && rows.every((l) => GUTTER.test(l));
}

/** A positive integer from a model-supplied argument, or undefined. */
function positiveInt(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 1 ? n : undefined;
}

type FnDef = { type: string; function: { name: string; description: string; parameters: any } };

/**
 * With EIGHT_EDIT_FORMAT=hashline (#3472), read_file and edit_file advertise
 * anchors; edit_file keeps oldText as an optional alternative. Flag off: the
 * definitions are returned untouched.
 */
function withHashline(defs: object[]): object[] {
	if (!hashlineEnabled()) return defs;
	return defs.map((d) => {
		const def = d as FnDef;
		const name = def.function?.name;
		if (name === "read_file") {
			return { ...def, function: { ...def.function, description: HASHLINE_READ_DESC } };
		}
		if (name !== "edit_file") return d;
		const { path, oldText, newText, startLine } = def.function.parameters.properties;
		return {
			...def,
			function: {
				...def.function,
				description: HASHLINE_EDIT_DESC,
				parameters: {
					type: "object",
					properties: {
						path,
						anchor: { type: "string", description: ANCHOR_PARAM_DESC },
						newText: { ...newText, description: ANCHORED_NEWTEXT_DESC },
						oldText: { ...oldText, description: OPTIONAL_OLDTEXT_DESC },
						startLine,
					},
					required: ["path", "newText"],
				},
			},
		};
	});
}

/** Text-tool definitions for lean MCP access (#3474); only sent with EIGHT_MCP_LEAN=1. */
export const MCP_LEAN_TOOL_DEFS = [
	{
		type: "function",
		function: {
			name: "mcp_list_tools",
			description:
				"[MCP] Find tools on the connected MCP servers. Pass query (a few words) to get the best matching tools, one line each. Pass tool (and server) to get that one tool's full input schema before calling it. With no arguments it lists the servers and their tool counts.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Words describing the job, e.g. 'weather forecast'",
					},
					tool: { type: "string", description: "Exact tool name whose input schema you need" },
					server: { type: "string", description: "Limit to this MCP server" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "mcp_call_tool",
			description:
				"[MCP] Calls one MCP tool: pass server, tool (its exact name) and args (per its input schema). Pass fields (dotted paths such as 'data.total') to keep only those parts of a JSON answer. Answers over 4000 characters are saved to a file and you get its path plus a short preview.",
			parameters: {
				type: "object",
				properties: {
					server: { type: "string", description: "MCP server name" },
					tool: { type: "string", description: "Tool name" },
					args: { type: "object", description: "Tool arguments, per its input schema" },
					fields: { type: "array", items: { type: "string" }, description: "Dotted paths to keep" },
				},
				required: ["server", "tool"],
			},
		},
	},
];

/** 8gent Browser drives browser_*; the external browser-use CLI is opt-in only (#3589). */
const useBrowserUse = () => process.env.EIGHT_BROWSER_BACKEND === "browser-use";
let eightBrowser: ReturnType<typeof createEightBrowser> | undefined;
/** The workspace of the executor that last used the browser: the source of its loopback allowlist. */
let browserWorkspace: string | undefined;
const getEightBrowser = (workspace: string) => {
	browserWorkspace = workspace;
	if (!eightBrowser) {
		// A named profile (#3622) is the bot's own login-free browser: it never opens private hosts, and
		// reaches loopback, or types into a password field, only on the run's own listed ports (#3785).
		eightBrowser = createEightBrowser(undefined, {
			isolated: () => isolatedBrowser(),
			workspace: () => browserWorkspace,
		});
		// Session end: close the tabs this process opened (natural exit only; never other tabs).
		process.once("beforeExit", () => void eightBrowser?.closeAll());
	}
	return eightBrowser;
};
/**
 * 8gent Browser tabs share the person's logged-in session partition (8gent-browser #80), so tools that
 * act or capture there ask first, like desktop_*: gated as desktop_use, where no rule allows them.
 * Exception (#3622, James 7 Oct): under a valid named EIGHT_BROWSER_PROFILE the calls go to that
 * profile's own login-free instance, so the tool-level card is skipped. Sensitive clicks still go to the
 * approver, and password or payment fields are never typed into.
 */
const BROWSER_ASK_FIRST = new Set(["browser_task", "browser_screenshot"]);
/** Approval-card view of browser args: typed text shows as its length only. */
function redactBrowserArgs(args: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(args.actions)) return args;
	const actions = args.actions.map((a) =>
		a && typeof a === "object" && typeof (a as { text?: unknown }).text === "string"
			? { ...(a as object), text: `<${(a as { text: string }).text.length} chars>` }
			: a,
	);
	return { ...args, actions };
}

/** The PowerShell for the optional `powershell` tool: win32 only, and only when settings.shell.powershellTool is on. */
function powershellToolShell(): ResolvedShell | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		if (!loadSettings().shell?.powershellTool) return undefined;
	} catch {
		return undefined;
	}
	return resolvePowerShell();
}

export const POWERSHELL_TOOL_DEF = {
	type: "function",
	function: {
		name: "powershell",
		description:
			"[SHELL] Windows only: pass command, a PowerShell command line. Runs a PowerShell command (-NoProfile -NonInteractive) and returns stdout/stderr. Use for Windows-native work (Get-ChildItem, registry, services); use run_command for git, bun, npm and POSIX tools. Same permission checks as run_command.",
		parameters: {
			type: "object",
			properties: { command: { type: "string", description: "PowerShell command to run" } },
			required: ["command"],
		},
	},
};

/** Policy action class for every one-file extension tool call (G1). */
export const EXTENSION_POLICY_ACTION = "extension_call" as const;

/**
 * render_video_deck's `spec` parameter as a real nested schema (#4172), derived from the
 * renderer's own DeckSpecSchema so the fields a model is shown are the fields it is checked
 * against. The native tool list carries no function description in a headless run, so this
 * schema is where a model learns slides[{title, text, bullets, narration, ...}], size and voice.
 * Only names, types, enums and nesting go out: lengths, counts, ranges, defaults and the
 * closed-object flags are left out to keep every request inside the headless prompt budget
 * (headless-prompt.test.ts, 60% rule). The renderer still enforces them and says which failed.
 */
const LEAN_DROP = new Set([
	"$schema",
	"additionalProperties",
	"default",
	"maxItems",
	"maxLength",
	"maximum",
	"minItems",
	"minLength",
	"minimum",
	"pattern",
]);

/**
 * A tagged union ({type:'a', ...} | {type:'b', ...}) as one object whose `type` is an enum and
 * whose properties are every variant's: about a third of the size, and the builder still checks
 * each variant exactly. Anything else is returned unchanged.
 */
function collapseTaggedUnion(node: Record<string, unknown>): Record<string, unknown> {
	const variants = node.oneOf;
	if (!Array.isArray(variants) || variants.length < 2) return node;
	const tags: string[] = [];
	const properties: Record<string, unknown> = {};
	for (const v of variants as Array<{ properties?: Record<string, { const?: unknown }> }>) {
		const tag = v.properties?.type?.const;
		if (typeof tag !== "string") return node;
		tags.push(tag);
		for (const [k, p] of Object.entries(v.properties ?? {})) if (k !== "type") properties[k] ??= p;
	}
	return {
		type: "object",
		properties: { type: { type: "string", enum: tags }, ...properties },
		required: ["type"],
	};
}

/** A zod schema as the lean JSON schema a tool parameter carries (names, types, enums, nesting). */
export function leanParameter(schema: z.ZodType): Record<string, unknown> {
	const lean = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(lean);
		if (node === null || typeof node !== "object") return node;
		let obj = collapseTaggedUnion(node as Record<string, unknown>);
		// anyOf inside anyOf (a union of a union) says the same thing flat.
		if (Array.isArray(obj.anyOf)) {
			const flat = (obj.anyOf as Array<Record<string, unknown>>).flatMap((a) =>
				a && Array.isArray(a.anyOf) && Object.keys(a).length === 1 ? (a.anyOf as unknown[]) : [a],
			);
			obj = { ...obj, anyOf: flat };
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (LEAN_DROP.has(k)) continue;
			out[k] = lean(v);
		}
		return out;
	};
	return lean(z.toJSONSchema(schema, { io: "input" })) as Record<string, unknown>;
}

export const DECK_SPEC_PARAMETER: Record<string, unknown> = leanParameter(DeckSpecSchema);

/**
 * The office tools' spec parameters (#4274), from the builders' own schemas like the deck's.
 * The first sentence of each description is the input shape: a local model reads that first.
 */
export const OFFICE_TOOL_DESCRIPTIONS: Record<OfficeToolName, string> = {
	make_docx:
		"Word .docx from args {spec:{title?, blocks:[{type:'heading'|'paragraph'|'bullets'|'table'|'image'|'pageBreak', ...}]}, out:'a.docx'}. Block fields: heading {text, level?: 1-3}, paragraph {text}, bullets {items, numbered?}, table {rows: [[cells]], header?}, image {path, caption?}. You write the spec, local code writes the file: A4, real Word heading and list styles, **bold** inside text, png/jpg images from the working directory. Returns { path, bytes, blocks, textChars }. No macros, no network. read_file on a .docx returns its text.",
	make_xlsx:
		"Excel .xlsx from args {spec:{sheets:[{name, rows:[[cell,...]], header?, columns?:[widths]}]}, out:'data.xlsx'}. A cell is a string, number, boolean, null or {value?, formula?:'=SUM(B2:B9)', format?:'#,##0.00', date?:'YYYY-MM-DD', bold?}. header:true bolds and freezes row 1. Formulas recalculate when the file opens and may call only local functions (SUM, IF, VLOOKUP...). Returns { path, bytes, sheets, cells }. No macros, no network. read_file on a .xlsx returns its cells.",
	make_pptx:
		"PowerPoint .pptx from args {spec:{title?, slides:[{kicker?, title?, text?, bullets?, image?, notes?}]}, out:'deck.pptx'}. Same slide shape as render_video_deck, so one spec can be a film or a deck: narration becomes the speaker notes when notes is absent. 16:9 slides, png/jpg images from the working directory. Returns { path, bytes, slides, notes }. No macros, no network. read_file on a .pptx returns slide text and notes.",
};

export const OFFICE_SPEC_PARAMETERS: Record<OfficeToolName, Record<string, unknown>> = {
	make_docx: leanParameter(DocxSpecSchema),
	make_xlsx: leanParameter(XlsxSpecSchema),
	make_pptx: leanParameter(PptxSpecSchema),
};

export { REFUSAL_LEAD, REFUSAL_NOTE, refusalLead };

export class ToolExecutor {
	private workingDirectory: string;
	private permissionManager: PermissionManager;
	/** Step cap and repeat stop for desktop_act, per executor lifetime. */
	private desktopActSession = new DesktopActSession();
	private hookManager: HookManager;
	private toolG8: ToolG8;
	private agentId: string;
	private astIndexReady = false;
	private astRepoId: string | null = null;
	private astIndexPromise: Promise<RepoIndex> | null = null;
	private artifactStore: ArtifactStore;
	/**
	 * Whether this executor runs unattended (autonomous engine / infinite mode /
	 * heartbeat). When true, destructive tools are gated by the maker-checker at
	 * executeRaw. Interactive executors leave this false so human-approved flows
	 * are never blocked. See packages/permissions/maker-checker-enforcer.ts.
	 */
	private unattended: boolean;
	/**
	 * Files (or directories) this agent may write and edit, from spawn_agent's
	 * `allowedPaths` (#3101). Undefined means no limit (the default).
	 */
	private allowedPaths: string[] | undefined;
	/**
	 * Whether write_file may open a written deliverable for the user (#3107).
	 * False for agents the agent pool spawns.
	 */
	private openOnWrite: boolean;
	/** Paths write_file opened this turn: each opens at most once per turn. */
	private openedThisTurn = new Set<string>();
	/** Dates and numbers files read this turn mark as retired (#3811). */
	private retiredFacts = new RetiredFacts();
	/** Absolute paths read or written this session; write_file replaces only these or new files (#4238). */
	private seenPaths = new Set<string>();
	/** Commands the harness refused; a refused probe proves nothing about the files it named (#4238). */
	private blockedCommands: string[] = [];
	private issueBlameGate = new IssueBlameGate();
	/**
	 * Files this agent created (write_file, run_command redirects), in memory
	 * only (#3177). System One lets it rm them without the judge. The Agent
	 * hands the same record to its native tool context, so both tool paths
	 * share it; another agent or tab has its own.
	 */
	readonly createdFiles = new CreatedFiles();
	/**
	 * Runs the repo's test script before a commit and refuses a red suite (#3402).
	 * Per executor, so "unchanged since a green run" means this agent's session.
	 */
	private commitGate: CommitGate;
	/**
	 * This agent's permission mode (#3170), shared with its Agent and, in the
	 * TUI, with its tab. Undefined: no mode, today's behaviour.
	 */
	private permission: PermissionModeHolder | undefined;
	/** Keys the post_message session limit (#3595); a real session id when one was given. */
	private postSession: string;
	/** The turn's task text; post_message checks its countable rules before sending (#4191). */
	private presendTask = "";
	/** Redrafts asked for this turn; one is allowed, a second failure stops the turn. */
	private presendRedrafts = 0;
	/** Set on the second failed draft; the turn loop takes it and stops the turn with it. */
	private presendStop: FormattingStop | null = null;
	/**
	 * Can the model driving this executor see images (#3641)? Asked when
	 * read_image runs, never before, so a turn that reads no image costs no
	 * probe. True: read_image attaches the pixels for the model. False (the
	 * default): read_image returns metadata, as it always did.
	 */
	private visionCapable: () => Promise<boolean>;
	private localRuntime: () => boolean;
	private tabVoice: string | undefined;
	/**
	 * Results the harness itself built with an image attachment (#4295). Held by
	 * value, so text a tool or a filename can produce never matches. execute()
	 * consumes the entry; only a hit lets the scrubber hold the attachment line out.
	 */
	private harnessAttachmentResults = new Set<string>();
	/** Finds the vision model describe_image calls (#3642). Injectable for tests. */
	private resolveVisionModel: () => Promise<VisionRouterResult>;
	/** The minimal-environment hint is appended once per session (see runCommand). */
	private envHintShown = false;

	constructor(
		workingDirectory: string = process.cwd(),
		agentId = "primary",
		sessionId?: string,
		options: {
			unattended?: boolean;
			allowedPaths?: string[];
			openOnWrite?: boolean;
			permission?: PermissionModeHolder;
			visionCapable?: () => Promise<boolean>;
			/** The model runs on this box, so read_image keeps the small image bound (#4293). */
			localRuntime?: () => boolean;
			/** Voice for `speak` when the call names none (the voice of the tab this 8gent serves). */
			tabVoice?: string;
			resolveVisionModel?: () => Promise<VisionRouterResult>;
			/**
			 * A person is at the keyboard (G1 extension_call policy). Default: not
			 * unattended and both stdin and stdout are terminals.
			 */
			attended?: boolean;
		} = {},
	) {
		this.workingDirectory = workingDirectory;
		this.postSession = sessionId ?? `${agentId}-${process.pid}-${Date.now()}`;
		this.permission = options.permission;
		this.visionCapable = options.visionCapable ?? (async () => false);
		this.localRuntime = options.localRuntime ?? (() => true);
		this.tabVoice = options.tabVoice;
		this.resolveVisionModel =
			options.resolveVisionModel ?? (() => findVisionModel({ preferLocal: true }));
		this.agentId = agentId;
		this.unattended = options.unattended ?? false;
		this.attended =
			options.attended ??
			(!this.unattended && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
		this.allowedPaths = normaliseAllowedPaths(options.allowedPaths);
		this.openOnWrite = options.openOnWrite ?? true;
		this.commitGate = new CommitGate(workingDirectory, (command, timeoutSec) =>
			this.runCommand(command, timeoutSec),
		);
		this.toolG8 = ToolG8.instance();
		this.permissionManager = getPermissionManager();
		this.hookManager = getHookManager();
		// Per-executor artifact store. Default sessionId derives from
		// agentId + pid so two long-lived executors in one process never
		// collide. Callers (agent.ts, mcp/server.ts) can pass an explicit
		// sessionId to thread it through to disk for later inspection.
		this.artifactStore = new ArtifactStore(sessionId ?? `${agentId}-${process.pid}`);

		// Background AST indexing of the working directory. The build yields to
		// the event loop between batches of files, so the constructor returns
		// at once. ensureIndexed shares one build per folder per process, keyed
		// by absolute path, so the agent and every executor on the same
		// directory reuse it instead of re-indexing.
		this.astIndexPromise = astEnsureIndexed(this.workingDirectory)
			.then((index) => {
				this.astIndexReady = true;
				this.astRepoId = index.id;
				return index;
			})
			.catch(() => {
				this.astIndexReady = false;
				return null as any;
			});
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	/** Once per turn, at its end: a retired fact still in a file that was warned about (#3811). */
	retiredTurnEndNudge(): string | null {
		// Regular files up to 1 MB only: a FIFO, device or huge file must not hang or bloat the turn.
		return this.retiredFacts.turnEndNudge((file) => {
			const st = fs.statSync(file, { throwIfNoEntry: false });
			if (!st || !st.isFile() || st.size > 1_048_576) return null;
			return fs.readFileSync(file, "utf-8");
		});
	}

	/** Measured-layout blocks already in this turn's context (#3823), so read_image does not repeat them. */
	private layoutNotesSent = new Set<string>();

	/** The agent put this measured-layout block in front of the model already this turn. */
	markLayoutSent(block: string): void {
		this.layoutNotesSent.add(block);
	}

	/** The measured layout for read_image, or "" when there is none or the model already has it this turn. */
	private async layoutForRead(file: string): Promise<string> {
		const measured = await layoutMeasureLine(file);
		return measured && !this.layoutNotesSent.has(measured) ? measured : "";
	}

	/** A new turn starts: files may be opened once again (#3107). */
	beginTurn(task = ""): void {
		this.presendTask = task;
		this.presendRedrafts = 0;
		this.presendStop = null;
		this.openedThisTurn.clear();
		this.layoutNotesSent.clear();
		this.retiredFacts.reset();
	}

	/**
	 * Check an outward draft against the turn task's countable rules (#4191). null: send it.
	 * First failure: nothing is sent and the model gets the draft and the broken rule for ONE
	 * redraft. Second failure: nothing is sent and the turn stops with formatting_rule_violation.
	 */
	private presendCheck(draft: string): string | null {
		if (!this.presendTask || draft.trim() === "") return null;
		const sources: Record<string, string> = {};
		let root: string;
		try {
			root = fs.realpathSync(path.resolve(this.workingDirectory));
		} catch {
			root = "";
		}
		for (const rel of root ? namedSources(this.presendTask) : []) {
			try {
				// A symlink, or a real path outside the working directory, is never read.
				const abs = path.resolve(root, rel);
				if (fs.lstatSync(abs).isSymbolicLink()) continue;
				const real = fs.realpathSync(abs);
				if (!real.startsWith(root + path.sep)) continue;
				if (fs.statSync(real).size <= 256 * 1024) sources[rel] = fs.readFileSync(real, "utf8");
			} catch {
				// a source that cannot be read is unchecked, never a failure
			}
		}
		const v = checkDraftConstraints(this.presendTask, draft, sources);
		if (v.ok) return null;
		const broken = describeFailures(v);
		if (this.presendRedrafts === 0) {
			this.presendRedrafts++;
			console.log(`[pre-send] draft breaks a task rule, one redraft asked: ${broken}`);
			return `[BLOCKED] post_message pre-send check: the draft breaks a rule in the task, so nothing was sent. Broken: ${broken}. Your draft was:\n${draft}\nRewrite it once so every rule holds, then call post_message again. A second draft that breaks a rule stops the turn.`;
		}
		const constraint = v.failed[0].constraint.phrase;
		this.presendStop = {
			kind: "formatting_rule_violation",
			reason: `post_message draft broke a task rule after one redraft: ${broken}`,
			constraint,
			draft,
		};
		console.log(`[pre-send] redraft broke a task rule again, turn stopped: ${broken}`);
		return `[BLOCKED] post_message pre-send check: the redraft still breaks a rule in the task (${broken}). Nothing was sent. The turn is stopped. Do not retry.`;
	}

	/** The formatting_rule_violation stop from the second failed draft, once (#4191). */
	takePresendStop(): FormattingStop | null {
		const s = this.presendStop;
		this.presendStop = null;
		return s;
	}

	/**
	 * Get tool definitions for the LLM
	 */
	getToolDefinitions(): object[] {
		return withHashline([
			// Code exploration
			{
				type: "function",
				function: {
					name: "get_outline",
					description:
						"[CODE] Pass filePath; returns every symbol (functions, classes, types, exports) in that file with line numbers and signatures. Use this FIRST before read_file to understand file structure - much cheaper than reading the whole file. Typically followed by get_symbol to extract just the function you need. If the file is not indexed, falls back to AST parsing.",
					parameters: {
						type: "object",
						properties: {
							filePath: {
								type: "string",
								description: "Path to the file to analyze",
							},
						},
						required: ["filePath"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "get_symbol",
					description:
						"[CODE] Pass symbolId as 'path/to/file.ts::name'; returns the full source of that one symbol (function, class, variable, type). Use this after get_outline to extract exactly the code you need without reading the entire file. Typically used after get_outline or search_symbols. If the symbol is not found, check the ID format: 'path/to/file.ts::symbolName'.",
					parameters: {
						type: "object",
						properties: {
							symbolId: {
								type: "string",
								description: "Symbol ID in format 'path/to/file.ts::symbolName'",
							},
						},
						required: ["symbolId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "search_symbols",
					description:
						"[CODE] Pass query (a name or a few words); returns matching symbol names, locations and kinds across the whole indexed codebase. Use this when you know what you are looking for but not where it lives. Prefer this over reading multiple files to find a function. If no results, try broader query terms or check that the project is indexed with get_project_outline.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Search query" },
							kinds: {
								type: "array",
								items: { type: "string" },
								description: "Filter by kinds: function, class, method, variable",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "locate",
					description:
						'[CODE] Pass query (a symbol, path, quoted text or error) to answer "where is X?" in one call: at most 5 "file:line kind text" rows. Give it a symbol name (createDecider, Foo::bar), a path or file name (decide/rules.ts), a quoted string or error message, or a short description. It picks symbol, path or text search itself. Use this FIRST to find where something lives, then get_symbol or read_file on the row you need.',
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Symbol name, path fragment, quoted text, error message or short description",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "update_plan",
					description: UPDATE_PLAN_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							plan: {
								type: "array",
								description: "Every step, in order",
								items: {
									type: "object",
									properties: {
										step: { type: "string" },
										status: { type: "string", enum: [...PLAN_STATUSES] },
									},
									required: ["step", "status"],
								},
							},
						},
						required: ["plan"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "get_project_outline",
					description:
						"[CODE] Returns a compact map of every indexed file in the project with symbol counts and names. Use this FIRST when starting work on an unfamiliar codebase to understand its structure. Much faster than listing directories and reading files individually. Follow up with get_outline on specific files of interest.",
					parameters: {
						type: "object",
						properties: {},
					},
				},
			},
			// File operations
			{
				type: "function",
				function: {
					name: "read_file",
					description:
						"[FILE] Returns the text of a file at the given path, one line per row, each row starting with its line number and a tab (like `cat -n`). The number and tab are not part of the file: cite them as line numbers, but never copy them into edit_file oldText or newText. Use offset and limit to read part of a file; the numbers stay the file's real line numbers. For large files (>500 lines), prefer get_outline first to find the specific function, then get_symbol for just that code. For config files (package.json, tsconfig.json, etc.) this is the right choice directly.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the file to read" },
							offset: {
								type: "number",
								description: "Line number to start reading from (1-based). Optional.",
							},
							limit: {
								type: "number",
								description: "How many lines to read from offset. Optional.",
							},
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "write_file",
					description:
						"[FILE] Writes content to the file at path (relative), creating it or overwriting the whole file; for small changes use edit_file. Use when creating new files or rewriting an entire file. Prefer edit_file for surgical changes to existing files. ALWAYS use relative paths (e.g. 'server.ts', 'src/index.ts'). NEVER use absolute paths. If the parent directory does not exist, this will fail - use run_command to mkdir first.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description:
									"Relative path to the file (e.g. 'server.ts', NOT '/project/server.ts')",
							},
							content: { type: "string", description: "Content to write" },
						},
						required: ["path", "content"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "edit_file",
					description:
						"[FILE] Replaces oldText (exact existing line or block) in file path with newText in place; to update a line, oldText is that whole line. Returns confirmation. Use this for surgical edits to existing files - prefer over write_file when changing a specific function or block. The oldText must match exactly (whitespace-sensitive). If the match fails, read_file first to get the exact current content, then retry.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the file" },
							oldText: {
								type: "string",
								description:
									"The exact existing text being changed, a whole line or block; after the edit the file contains newText and not oldText",
							},
							newText: {
								type: "string",
								description: "Replacement for oldText, in place",
							},
							startLine: {
								type: "number",
								description:
									"Optional 1-based line. If oldText appears more than once, the copy at or after this line is edited. Without it, a duplicate oldText is refused.",
							},
						},
						required: ["path", "oldText", "newText"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "list_files",
					description:
						"[FILE] Returns a list of filenames and directories at the given path, optionally filtered by glob pattern. Use this to explore project structure or find files by name pattern. For finding files by content, use search_symbols or run_command with grep instead.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "Directory path (default: current directory)",
							},
							pattern: {
								type: "string",
								description: "Glob pattern to filter files",
							},
						},
					},
				},
			},
			// Git operations
			{
				type: "function",
				function: {
					name: "git_status",
					description:
						"[GIT] Returns the working tree status: modified, staged, untracked, and deleted files. Use this before git_add or git_commit to see what has changed. Also useful after edits to verify your changes landed in the right files.",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function",
				function: {
					name: "git_diff",
					description:
						"[GIT] Returns the line-by-line diff of changes. Use without 'staged' to see unstaged working tree changes; use with staged=true to review what will be included in the next commit. Typically used after git_status to inspect specific changes before committing.",
					parameters: {
						type: "object",
						properties: {
							staged: {
								type: "boolean",
								description: "Show staged changes only",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "git_log",
					description:
						"[GIT] Returns recent commit hashes, messages, authors, and dates. Use this to understand project history, find when a change was introduced, or check commit message conventions before writing your own. Defaults to 10 commits.",
					parameters: {
						type: "object",
						properties: {
							count: {
								type: "number",
								description: "Number of commits to show (default: 10)",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "git_add",
					description:
						"[GIT] Stages files for the next commit. Use after making edits and before git_commit. Pass specific file paths to stage selectively, or omit to stage all changes. Typically used after git_status confirms the right files were modified.",
					parameters: {
						type: "object",
						properties: {
							files: {
								type: "string",
								description: "Files to add (default: all)",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "git_commit",
					description:
						"[GIT] Commits the staged changes with message and returns the commit hash; run git_add first. Use after git_add. If nothing is staged, this will fail - run git_status first to verify staged files. Follow the project's commit message conventions (check git_log for examples).",
					parameters: {
						type: "object",
						properties: {
							message: { type: "string", description: "Commit message" },
						},
						required: ["message"],
					},
				},
			},
			// Shell
			{
				type: "function",
				function: {
					name: "run_command",
					description:
						"[SHELL] Executes a shell command and returns stdout/stderr. Use for: running tests, installing packages, checking versions, building projects, file operations (mkdir, mv, cp). Pipes (|) and redirects (>) are allowed. Command chaining (;, &&, ||) and background execution (&) are blocked for safety - use separate calls instead. If a command is blocked by permissions, simplify it or split into multiple calls. Commands run with a minimal environment (PATH, HOME, locale, toolchain paths); credentials are not inherited. If one is needed, tell the user to export EIGHT_SHELL_ENV_PASS=NAME in the shell that launches 8gent (a keys file cannot set it). For git push over SSH typed here, that is EIGHT_SHELL_ENV_PASS=SSH_AUTH_SOCK; the git tools keep SSH working without it.",
					parameters: {
						type: "object",
						properties: {
							command: { type: "string", description: "Command to run" },
						},
						required: ["command"],
					},
				},
			},
			// Multi-agent orchestration
			{
				type: "function",
				function: {
					name: "spawn_agent",
					description: SPAWN_AGENT_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description: "Task description for the background agent to execute",
							},
							runtime: {
								type: "string",
								enum: ["8gent", "claude", "shell"],
								description: SPAWN_RUNTIME_DESCRIPTION,
							},
							model: {
								type: "string",
								description: SPAWN_MODEL_DESCRIPTION,
							},
							timeout: {
								type: "number",
								description: "Timeout in ms (default: 5 min, only for claude/shell)",
							},
							allowedPaths: {
								type: "array",
								items: { type: "string" },
								description: ALLOWED_PATHS_DESCRIPTION,
							},
							permissionMode: {
								type: "string",
								enum: ["plan", "ask", "guarded", "infinite"],
								description: PERMISSION_MODE_DESCRIPTION,
							},
						},
						required: ["task"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "check_agent",
					description: CHECK_AGENT_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							agentId: {
								type: "string",
								description: "Agent ID returned from spawn_agent",
							},
						},
						required: ["agentId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "list_agents",
					description: LIST_AGENTS_DESCRIPTION,
					parameters: { type: "object", properties: {} },
				},
			},
			// Web tools
			{
				type: "function",
				function: {
					name: "web_search",
					description:
						"[WEB] Pass query; returns a list of search results (titles, URLs, snippets) from DuckDuckGo. Use when you need to find documentation, look up error messages, or research a topic. Follow up with web_fetch on a specific result URL to get full page content. If results are poor, try rephrasing with more specific technical terms.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Search query" },
							maxResults: {
								type: "number",
								description: "Max results (default: 5)",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "web_fetch",
					description:
						"[WEB] Pass url; returns the readable text of that web page (HTML stripped). Use after web_search to read a specific page, or directly when you have a known URL (docs, GitHub, npm). Results are cached to disk. If the page is too large, only the first portion is returned.",
					parameters: {
						type: "object",
						properties: {
							url: { type: "string", description: "URL to fetch" },
						},
						required: ["url"],
					},
				},
			},
			// PDF tools
			{
				type: "function",
				function: {
					name: "speak",
					description:
						"[MEDIA] Speak text with a local neural voice (Supertonic, KittenTTS fallback) and write a wav inside the working directory. Returns path and durationSec. Use for video narration instead of espeak or say. Voices: Daniel (default), Rishi, Samantha, Moira, Karen, Tessa, Zara, Reed, Solomon, AIJames, Luis, Ralph, Albert, Alex, Victoria, Kathy, Allison, Ava.",
					parameters: {
						type: "object",
						properties: {
							text: { type: "string", description: "Words to speak (max 2000 characters)" },
							voice: { type: "string", description: "Voice name; defaults to Daniel" },
							out: { type: "string", description: "Output .wav path inside the working directory" },
						},
						required: ["text"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "compare_layout",
					description:
						"[FILE] Diffs page html with mock-up image reference and names each off band's element: fix it with edit_file, never rewrite the page. Returns each band's pixel offset and a similarity number. Use it after writing a page from a mock-up, fix the largest offsets, and run it again until the bands are within 2px. Local and offline; the page cannot reach the network.",
					parameters: {
						type: "object",
						properties: {
							html: { type: "string", description: "Path to the HTML file you wrote" },
							reference: { type: "string", description: "Path to the mock-up image (png, jpg)" },
						},
						required: ["html", "reference"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "use_skill",
					description: USE_SKILL_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description:
									"Skill name exactly as listed, for example brief-to-film (never a path)",
							},
							query: { type: "string", description: "Word to filter the skill list by" },
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "render_video_deck",
					description:
						`[MEDIA] ${RENDER_VIDEO_DECK_DESCRIPTION}`,
					parameters: {
						type: "object",
						properties: {
							spec: DECK_SPEC_PARAMETER,
							out: {
								type: "string",
								description: "Output .mp4 path inside the working directory (default deck.mp4)",
							},
						},
						required: ["spec"],
					},
				},
			},
			...(Object.keys(OFFICE_TOOLS) as OfficeToolName[]).map((name) => ({
				type: "function",
				function: {
					name,
					description: `[FILE] ${OFFICE_TOOL_DESCRIPTIONS[name]}`,
					parameters: {
						type: "object",
						properties: {
							spec: OFFICE_SPEC_PARAMETERS[name],
							out: {
								type: "string",
								description: `Output .${OFFICE_TOOLS[name]} path inside the working directory`,
							},
						},
						required: ["spec"],
					},
				},
			})),
			{
				type: "function",
				function: {
					name: "screen_locate",
					description:
						"[FILE] Returns the point to click for target (a thing named in words) in the screenshot at image.",
					parameters: {
						type: "object",
						properties: {
							image: { type: "string", description: "Screenshot path" },
							target: { type: "string", description: "e.g. the Sign in button" },
							viewport: { type: "string", description: 'Optional "WxH" for cssX/cssY' },
						},
						required: ["image", "target"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "read_image",
					description:
						"[FILE] Reads the image file at path (png, jpg, gif, webp). If you can see images, the picture is attached to the next message for you to look at; otherwise you get its size and format, and describe_image can tell you what is in it. Use for screenshots, UI mockups, charts and diagrams the task refers to.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the image file" },
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "describe_image",
					description:
						"[FILE] Describes the image file at path in words using a local vision model; pass prompt to ask something specific. Use when you cannot see images yourself, or need a second reading of a screenshot, chart or diagram. Pass a prompt to ask something specific about the image.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the image file" },
							prompt: {
								type: "string",
								description: "What to look for or ask about the image (optional)",
							},
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "read_pdf",
					description:
						"[FILE] Reads the PDF file at path and returns its extracted text, page count and metadata (title, author, dates). Use for analyzing PDF documents, contracts, reports, or papers. For large PDFs, use read_pdf_page to read specific pages. Follow up with search_pdf to find specific content within a PDF.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the PDF file" },
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "read_pdf_page",
					description:
						"[FILE] Reads page pageNum (1-based) of the PDF file at path and returns its text. Use when you only need content from certain pages of a large PDF, or when the full PDF text was truncated. Page numbers start at 1.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the PDF file" },
							pageNum: {
								type: "number",
								description: "Page number to read (1-based)",
							},
						},
						required: ["path", "pageNum"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "search_pdf",
					description:
						"[FILE] Searches the PDF file at path for query and returns matching positions with surrounding context. Use when you need to find specific content, keywords, or phrases in a PDF without reading the entire document.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the PDF file" },
							query: { type: "string", description: "Text to search for" },
							caseSensitive: {
								type: "boolean",
								description: "Case-sensitive search (default: false)",
							},
						},
						required: ["path", "query"],
					},
				},
			},
			// Video ingestion tool (VIDEO-INGESTION spec §6).
			// Always advertised so the model can discover it; the capability is
			// OFF BY DEFAULT (spec §11) and the handler returns a structured
			// "install required" error rather than silently no-opping.
			{
				type: "function",
				function: {
					name: "extract_video",
					description:
						"[VIDEO] Extracts from the video file at path a scene summary, timestamped visual events and a speech transcript. Use to understand screen recordings, demos, meetings, or clips, or to ingest a video into the knowledge graph. Runs fully local on-device. Requires the video-understanding capability to be installed (8gent vision install).",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the video file" },
							mode: {
								type: "string",
								enum: ["full", "visual", "audio"],
								description:
									"full = events + transcript (default); visual = events only; audio = transcript only",
							},
							query: {
								type: "string",
								description:
									"Optional natural-language event to locate; returns the matching time span",
							},
							ingest: {
								type: "boolean",
								description: "If true, write the result into the knowledge graph (default false)",
							},
						},
						required: ["path"],
					},
				},
			},
			// Vercel deployment tools
			{
				type: "function",
				function: {
					name: "vercel_list_projects",
					description:
						"[DEPLOY] Returns all Vercel projects with IDs, names, frameworks, and last update times. Use this to discover project IDs needed by other vercel_ tools. Requires VERCEL_TOKEN env var.",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_get_deployments",
					description:
						"[DEPLOY] Returns recent deployments for the Vercel project projectId, including state, URL and commit message. Use after vercel_list_projects to check deployment status.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
							limit: {
								type: "number",
								description: "Number of deployments to return (default: 5)",
							},
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_deploy",
					description:
						"[DEPLOY] Triggers a redeployment of the latest deployment for the Vercel project projectId. Returns the new deployment ID and URL.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_set_env",
					description:
						"[DEPLOY] Sets environment variable key to value on the Vercel project projectId, creating or updating it. Value is stored encrypted. Targets production, preview, and development by default.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
							key: { type: "string", description: "Environment variable name" },
							value: {
								type: "string",
								description: "Environment variable value",
							},
							target: {
								type: "array",
								items: { type: "string" },
								description: "Targets: production, preview, development (default: all)",
							},
						},
						required: ["projectId", "key", "value"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_get_env",
					description:
						"[DEPLOY] Returns all environment variables for the Vercel project projectId (keys and targets only, values are encrypted).",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_list_domains",
					description:
						"[DEPLOY] Returns all custom domains for the Vercel project projectId with verification status.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_get_deployment_logs",
					description:
						"[DEPLOY] Returns build/runtime logs for the deployment deploymentId (the uid from vercel_get_deployments). Use the deployment ID from vercel_get_deployments.",
					parameters: {
						type: "object",
						properties: {
							deploymentId: {
								type: "string",
								description: "Deployment ID (uid from vercel_get_deployments)",
							},
						},
						required: ["deploymentId"],
					},
				},
			},
			// Film craft (#3599): the 8GI film look as presets, applied to slide videos
			{
				type: "function",
				function: {
					name: "film_craft",
					description:
						"[VIDEO] Makes slide videos look designed, not like a default slideshow: action is list, plan, bed or mix. action=list shows the film presets (palette, type, title card, lower third, grade, camera move, transition, pacing, music bed). action=plan takes slides [{title, kicker?, sub?, lower?, seconds}] and writes out_dir/film.sh: magick draws each slide (no drawtext needed), ffmpeg adds the camera move, text blur-in, transitions and grade, and muxes narration and/or bed; run it with bash. Picture length equals the sum of slide seconds. action=bed writes an original music bed wav (seconds, hits = cut times). action=mix returns the grade of grade_from with the titles of preset.",
					parameters: {
						type: "object",
						properties: {
							action: { type: "string", description: "list | plan | bed | mix" },
							preset: {
								type: "string",
								description: "Film preset name from action=list (default lotus-night)",
							},
							grade_from: {
								type: "string",
								description:
									"Optional: take grade, camera and cuts from this preset, titles from preset",
							},
							slides: {
								type: "array",
								description: "plan: [{title, kicker?, sub?, lower?, seconds}] in order",
								items: { type: "object" },
							},
							out_dir: {
								type: "string",
								description: "plan: folder for film.sh, frames and the mp4 (default video)",
							},
							out: {
								type: "string",
								description:
									"plan: output mp4 file name in out_dir (default film.mp4); bed: wav path",
							},
							width: { type: "number", description: "plan: width (default 1280)" },
							height: { type: "number", description: "plan: height (default 720)" },
							narration: {
								type: "string",
								description: "plan: narration audio file; the bed ducks under it",
							},
							bed: { type: "string", description: "plan: music bed wav from action=bed" },
							seconds: { type: "number", description: "bed: length in seconds" },
							hits: {
								type: "array",
								items: { type: "number" },
								description: "bed: cut times in seconds (risers and booms land on them)",
							},
						},
						required: ["action"],
					},
				},
			},
			// Design tools
			{
				type: "function",
				function: {
					name: "deck_theme",
					description:
						"[DESIGN] Import-ready Marp deck themes, one per design system: action is list, apply (to deck) or mix (palette plus type). USE THIS when a deck (Marp markdown) has no theme: `list` shows name, mood and 3 swatches; `apply` sets `theme: <name>` in the deck's front matter and copies the CSS next to it (overwrites <name>.css); `mix` (palette=<a>, type=<b>) writes a derived theme. Title slide: `<!-- _class: lead -->`, section break: `<!-- _class: invert -->`. Render with the marp command the result returns.",
					parameters: {
						type: "object",
						properties: {
							action: { type: "string", description: "list | apply | mix" },
							deck: { type: "string", description: "Path to the deck .md (apply, mix)" },
							name: { type: "string", description: "Theme name from list (apply)" },
							palette: { type: "string", description: "Theme name to take colours from (mix)" },
							type: { type: "string", description: "Theme name to take fonts from (mix)" },
						},
						required: ["action"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "suggest_design",
					description:
						"[DESIGN] Returns design system recommendations including color palettes, typography, and component libraries matched to your task. Use this BEFORE writing any UI code to get curated design guidance. Typically the first design tool to call - follow up with query_design_system for specific palette/component details. Prefer this over guessing colors or fonts.",
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description:
									"Description of the UI task or project (e.g., 'build a landing page', 'create a dashboard')",
							},
							projectType: {
								type: "string",
								description:
									"Optional project type hint: ai, saas, portfolio, ecommerce, dashboard, landing-page, etc.",
							},
						},
						required: ["task"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "query_design_system",
					description:
						"[DESIGN] Returns design system data from a curated SQLite database - palettes, typography, components, and patterns. Use when you need specific design tokens (hex colors, font stacks, spacing scales). Can output as summary, CSS variables, Tailwind config, or hex palette. Typically used after suggest_design to get implementation-ready values for a recommended system.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "Search query (e.g., 'minimal dark', 'claude', 'cyberpunk')",
							},
							style: {
								type: "string",
								description:
									"Filter by style: minimal, bold, playful, elegant, tech, retro, nature, corporate",
							},
							mood: {
								type: "string",
								description:
									"Filter by mood: professional, creative, tech, warm, cool, dramatic, calm, energetic",
							},
							output: {
								type: "string",
								description:
									"Output format: 'summary' (default), 'css' (CSS variables), 'tailwind' (Tailwind config), 'hex' (hex palette)",
							},
						},
					},
				},
			},
			// Infinite mode
			{
				type: "function",
				function: {
					name: "enable_infinite_mode",
					description:
						"[SHELL] Activates autonomous looping execution for a task and returns a runner handle. The agent will iterate until the task is complete, recovering from errors automatically. Use this when a task is too large for a single pass - e.g., refactoring across many files, running repeated test-fix cycles, or multi-step research. Set maxIterations and maxTimeMs to bound execution. If the task can be done in one shot, prefer direct tool calls instead.",
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description: "The task to execute in infinite mode",
							},
							maxIterations: {
								type: "number",
								description: "Maximum iterations before stopping (default: 100)",
							},
							maxTimeMs: {
								type: "number",
								description: "Maximum time in ms before stopping (default: 30 minutes)",
							},
						},
						required: ["task"],
					},
				},
			},
			// Memory tools
			{
				type: "function",
				function: {
					name: "remember",
					description:
						"[MEMORY] Persists a fact to the specified memory layer and returns confirmation. Use 'session' for temporary context that disappears when the session ends. Use 'project' for facts about this codebase (persisted in .8gent/ - e.g., architecture decisions, user preferences for this repo). Use 'global' for cross-project knowledge (persisted in ~/.8gent/ - e.g., user's coding style, tool preferences). Keep facts concise and searchable. Pair with recall to retrieve later.",
					parameters: {
						type: "object",
						properties: {
							fact: { type: "string", description: "The fact to remember" },
							layer: {
								type: "string",
								enum: ["session", "project", "global"],
								description:
									"Memory layer: session (ephemeral), project (per-repo), global (cross-project)",
							},
						},
						required: ["fact", "layer"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "recall",
					description:
						"[MEMORY] Pass query (keywords); returns matching facts from all memory layers (session, project, global) ranked by relevance. Use this when you need context about the user, project conventions, past decisions, or previously learned information. Search with broad keywords first, then narrow down. If no results, try synonyms or related terms. Useful at the start of a task to check for prior context.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "Search query - keywords to match against stored memories",
							},
							limit: {
								type: "number",
								description: "Max results to return (default: 10)",
							},
						},
						required: ["query"],
					},
				},
			},
			// Desktop Computer Use tools (Power #10)
			...getComputerToolDefs(),
			DESKTOP_ACT_TOOL_DEF,
			{
				type: "function",
				function: {
					name: "run_computer_task",
					description:
						"[DESKTOP] Runs an autonomous multi-step computer-use task until goal (plain words) is done on the desktop. The agent perceives the screen (accessibility tree first, screenshot as fallback) and uses mouse/keyboard tools to complete the goal. Use for tasks that span multiple apps or require navigating a GUI. The vision model is configured via ~/.8gent/config.json vision.computerUseModel.",
					parameters: {
						type: "object",
						properties: {
							goal: {
								type: "string",
								description: "Plain-English description of what to accomplish on the desktop.",
							},
							maxSteps: {
								type: "number",
								description: "Maximum number of agent steps (default: 20, max: 50).",
							},
						},
						required: ["goal"],
					},
				},
			},
			// Browser Use tools
			{
				type: "function",
				function: {
					name: "browser_open",
					description:
						"Opens url in a new 8gent Browser tab and returns its tab id, title, numbered elements and page text.",
					parameters: {
						type: "object",
						properties: {
							url: { type: "string", description: "URL to navigate to" },
							browser: {
								type: "string",
								description: "Browser to use (default: chromium). Use 'remote' for cloud browsers.",
							},
							session: {
								type: "string",
								description:
									"Unused by 8gent Browser (each open is a new tab); browser-use fallback session id",
							},
						},
						required: ["url"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "browser_state",
					description:
						'Re-read the current tab: URL, title and the numbered elements ([n] role "name") that browser_task acts on.',
					parameters: {
						type: "object",
						properties: {
							session: {
								type: "string",
								description: "Tab id from browser_open (default: the last tab opened)",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "browser_task",
					description:
						"Tab steps: type{index|selector,text}, left_click{index}, wait_for{selector}, open{url}, scroll{dy}; login text {{file:TASK.txt:Password}}. " +
						"Each step is verified. left_click also takes a selector. {{file:PATH:Field}} in type text types the value of the 'Field:' line of that workspace file at act time, only on a local address written in the same file, so the value never enters the conversation or the shell.",
					parameters: {
						type: "object",
						properties: {
							actions: {
								type: "array",
								items: { type: "object" },
								description:
									'Ordered steps, e.g. [{"action":"type","index":3,"text":"{{file:TASK.txt:Password}}"},{"action":"left_click","index":4}]',
							},
							task: {
								type: "string",
								description:
									"Natural language task; only runs on the opt-in browser-use fallback (EIGHT_BROWSER_BACKEND=browser-use)",
							},
							browser: {
								type: "string",
								description: "Browser to use (default: chromium). Use 'remote' for cloud browsers.",
							},
							session: {
								type: "string",
								description: "Tab id from browser_open (default: the last tab opened)",
							},
						},
						required: [],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "browser_screenshot",
					description: "Screenshot the current tab to a .png and return '<path> <W>x<H>'.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "File path to save screenshot (default: auto-generated)",
							},
							session: {
								type: "string",
								description: "Tab id from browser_open (default: the last tab opened)",
							},
						},
					},
				},
			},
			// Windowed-session orchestration (term_*) — see packages/eight/term-tools.ts
			...getTermToolDefs(),
			// Lean MCP access (#3474): advertised only with EIGHT_MCP_LEAN=1 exactly.
			...(process.env.EIGHT_MCP_LEAN === "1" ? MCP_LEAN_TOOL_DEFS : []),
			// Posting (#3595): advertised only where the tg-group helper is installed.
			...(postMessageAvailable() ? [POST_MESSAGE_TOOL_DEF] : []),
			// Mid-task note to the boardroom (#4344): local file only; EIGHT_MESSAGE_BOARDROOM=0 withholds it.
			...(messageBoardroomOn() ? [MESSAGE_BOARDROOM_TOOL_DEF] : []),
			// Windows only, off by default (settings.shell.powershellTool).
			...(powershellToolShell() ? [POWERSHELL_TOOL_DEF] : []),
		]);
	}

	private rateLimiter = new RateLimiter();

	/** Is a person at the keyboard? Decides the extension_call default policy (G1). */
	private readonly attended: boolean;

	/** One-file extension tools (G1), set by the agent that owns this executor. */
	private extensionRunner: {
		has(name: string): boolean;
		run(name: string, args: Record<string, unknown>): Promise<string>;
	} | null = null;

	/**
	 * Route extension tools through this executor (G1), so they pass the same
	 * maker-checker, edit-scope, rate-limit and plan-mode checks as built-in
	 * tools, and their output is scrubbed, filtered and chipped the same way.
	 */
	setExtensionRunner(runner: ToolExecutor["extensionRunner"]): void {
		this.extensionRunner = runner;
	}

	/**
	 * Map tool names to policy action types for ToolG8 gate evaluation.
	 * Extension tools (G1) are not listed: their names are dynamic, so
	 * executeRaw maps any tool the extension runner has to EXTENSION_POLICY_ACTION.
	 */
	private static TOOL_ACTION_MAP: Record<string, PolicyActionType> = {
		read_file: "read_file",
		// Image tools read a file the model names, so they take the read gate too.
		read_image: "read_file",
		describe_image: "read_file",
		// READ-ONLY class: reads the html and the reference inside the workspace and writes
		// nothing there (Chrome profile and screenshot go to an OS temp dir, removed after).
		// Own class so policy can target it, but allowed in plan, architect and review.
		compare_layout: "render_page",
		screen_locate: "read_file",
		write_file: "write_file",
		speak: "write_file",
		render_video_deck: "write_file",
		make_docx: "write_file",
		make_xlsx: "write_file",
		make_pptx: "write_file",
		edit_file: "write_file",
		// Notebook cell edits write text into a file too (#3011).
		notebook_edit_cell: "write_file",
		notebook_insert_cell: "write_file",
		delete_file: "delete_file",
		run_command: "run_command",
		powershell: "run_command",
		git_push: "git_push",
		git_commit: "git_commit",
		web_search: "network_request",
		web_fetch: "network_request",
		// browser_open loads a URL in 8gent Browser, in the person's own session partition (#3592).
		browser_open: "network_request",
		vercel_list_projects: "network_request",
		vercel_get_deployments: "network_request",
		vercel_deploy: "network_request",
		vercel_set_env: "network_request",
		vercel_get_env: "network_request",
		vercel_list_domains: "network_request",
		vercel_get_deployment_logs: "network_request",
		// A call to any tool on an MCP server (#3230). It had no entry, so the
		// gate below never ran and every MCP call went straight to the server
		// in every mode. mcp_list_tools only reads the local list and stays
		// ungated.
		mcp_call_tool: MCP_POLICY_ACTION,
		// plan and bed write files; list and mix write nothing and skip the gate (#3599).
		film_craft: "write_file",
	};

	async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
		// A no-tool scope (classroom, #3939) runs nothing, whatever reached here:
		// the model is offered zero tools; this is the backstop at the executor.
		if (isNoToolScope(this.agentId)) {
			return `Error: tool "${toolName}" is not available in this session (no tools are permitted).`;
		}
		// Every call runs in this agent's permission mode (#3170), so the
		// permission layer below answers for this agent and no other.
		if (this.permission && currentPermissionHolder() !== this.permission) {
			return runWithPermissionHolder(this.permission, () => this.execute(toolName, args));
		}
		if (currentPermissionMode() === "plan") {
			const refusal = await planModeRefusal(toolName, args);
			if (refusal) return refusal;
		}
		const raw = await this.executeRaw(toolName, args);
		// Scratch stays out of git status, but only once .tmp/ exists (#4241).
		ensureScratchExcludedIfPresent(this.workingDirectory);
		// Post-tool-execution scrubbing boundary (issue #2464).
		// Order is contract: SecretScanner -> [Cache lookup, #2462] -> execute
		// -> ArtifactStore persist (#2463). Scrub MUST run before persist so
		// no secret value ever lands on disk.
		// read_image alone may end in a harness-emitted image attachment line, held out of
		// the scan so a large image is not cut at the input cap (#4295).
		const result =
			toolName === IMAGE_ATTACHMENT_TOOL && this.harnessAttachmentResults.delete(raw)
				? scrubKeepingAttachment(raw, IMAGE_ATTACHMENT_MARKER)
				: scrubSecrets(raw);
		if (result.redactedCount > 0) {
			// Log redaction event to telemetry (no secret values, just metadata).
			console.warn(
				`[secret-scanner] tool=${toolName} redacted=${result.redactedCount} rules=${result.rules.join(",")}`,
			);
		}
		// ArtifactStore (#2463): swap large successful results for a chip
		// reference. Failed results bypass via the `isError` flag - here the
		// scrubbed string is the model-visible payload and we have no error
		// signal at this boundary, so we treat all returns as successful.
		// The cache (#2462) sits BEFORE executeRaw and is independent of this
		// step; both can co-exist without touching each other.
		// Tool-output injection filter (#3551), off unless EIGHT_OUTPUT_FILTER=1.
		// Runs on the scrubbed text so no secret reaches the judge.
		const filtered = await filterToolOutput(toolName, result.scrubbed);
		// A read_image result that carries an image is never chipped: the chip keeps a 1KB
		// preview, which cuts the base64 mid-stream, and the model endpoint then
		// rejects the image with a 400 (pilot 2026-10-09_115409). The attachment
		// is already downscaled, and the loop strips the pixels from the text it
		// keeps, so nothing large reaches the context.
		if (toolName === IMAGE_ATTACHMENT_TOOL && hasImageAttachmentLine(filtered)) return filtered;
		return this.artifactStore.persistAndReplace(filtered, toolName);
	}

	private async executeRaw(toolName: string, args: Record<string, unknown>): Promise<string> {
		// Maker-checker gate (safety-critical). This is the single chokepoint every
		// tool call passes through, so it runs BEFORE the term-tool early return,
		// the ToolG8 gate, and the switch. In an unattended/autonomous context a
		// destructive tool (rm, git_push, vercel_deploy, vercel_set_env,
		// enable_infinite_mode) cannot run without an approved CheckerDecision.
		// Note: this deliberately sits outside the infinite-mode permission bypass.
		try {
			assertMakerCheckerApproved(toolName, args, {
				unattended: this.unattended,
				makerId: this.agentId,
			});
		} catch (err) {
			if (err instanceof MakerCheckerBlockedError) {
				// Return a blocked marker string (matches the [..BLOCKED] contract in
				// agent.ts) so the autonomous loop records a failed tool call and
				// continues gracefully rather than crashing.
				return `[MAKER-CHECKER BLOCKED] ${err.message}`;
			}
			throw err;
		}

		// Edit scope (#3101): an agent spawned with allowedPaths writes and edits
		// only those files. Checked before anything else can touch the disk.
		const outOfScope = editScopeViolation(toolName, args, this.workingDirectory, this.allowedPaths);
		if (outOfScope) return outOfScope;

		// Rate limit check - prevents LLM loops from exhausting resources
		const rateLimitError = this.rateLimiter.check(toolName);
		if (rateLimitError) return rateLimitError;

		// ToolG8 gate - evaluate policy BEFORE any execution or delegation.
		//
		// This used to sit BELOW the term_* delegation, which returns early. So
		// every term_* tool skipped the policy check entirely and a `__table__`
		// agent - deny-by-default, read-only by design - could spawn a real tmux
		// session. Verified on clean main 2026-08-07: F3's end-to-end case asked
		// for term_spawn and got a live pane back instead of a refusal.
		//
		// The policy layer was correct the whole time; evaluatePolicy already
		// denies term_orchestration for __table__. It was simply never consulted
		// on that path. An ordering bug with the blast radius of a sandbox
		// escape.
		//
		// term_* also has no TOOL_ACTION_MAP entry, so reordering alone would
		// have left policyAction undefined and skipped the gate a SECOND way.
		// Both holes are closed here: the family maps to the capability the
		// policy engine already knows how to deny.
		// Whole FAMILIES of tools reach the switch without ever appearing in
		// TOOL_ACTION_MAP, and an unmapped tool is an ungated tool. term_* and
		// desktop_* are both control surfaces far outside what a Table officer
		// may touch, so each maps to the capability the policy engine already
		// knows how to deny rather than relying on someone remembering to add
		// every new member of the family to the map by hand.
		//
		// desktop_* is gated as `desktop_use`, the name its rules in
		// default-policies.yaml are written under, with the `action` descriptor
		// those rules match on (#3213). It was gated as `computer_use`, which
		// has no rules, so every desktop call - quitting apps included - fell
		// through to the engine's default allow and no card appeared.
		const isDesktop = toolName.startsWith("desktop_") || BROWSER_ASK_FIRST.has(toolName);
		const isMcpCall = toolName === "mcp_call_tool";
		const filmWrites = toolName === "film_craft" ? filmCraftWriteTargets(args) : [];
		// speak names its file in `out`, film_craft its first write target, everything else in `path`.
		const writeTarget = (
			toolName === "film_craft"
				? filmWrites[0]
				: toolName === "speak" || toolName === "render_video_deck" || isOfficeTool(toolName)
					? args.out
					: toolName === "compare_layout"
						? args.html
						: args.path
		) as string | undefined;
		// A one-file extension tool (G1) has a dynamic name, so it maps by
		// membership, not by TOOL_ACTION_MAP, to the extension_call class.
		const isExtension = this.extensionRunner?.has(toolName) === true;
		const mappedAction =
			ToolExecutor.TOOL_ACTION_MAP[toolName] ??
			(isTermTool(toolName)
				? "term_orchestration"
				: isDesktop
					? (DESKTOP_POLICY_ACTION as PolicyActionType)
					: isExtension
						? (EXTENSION_POLICY_ACTION as PolicyActionType)
						: undefined);
		const policyAction =
			toolName === "film_craft" && filmWrites.length === 0 ? undefined : mappedAction;
		if (policyAction) {
			const gateResult = this.toolG8.gate(this.agentId, policyAction, {
				...(isDesktop ? desktopPolicyContext(toolName, args) : {}),
				...(isMcpCall ? mcpPolicyContext(String(args.server), String(args.tool)) : {}),
				// Unattended sessions ask before an extension tool runs (default policy).
				...(isExtension ? { tool: toolName, attended: this.attended } : {}),
				path: writeTarget as string,
				// What a relative path resolves against, for `resolved_path` rules (#3474).
				cwd: this.workingDirectory,
				// Every write tool is checked on what it actually writes, not
				// only write_file's `content` (#3011: edit_file's newText was
				// never seen by no-secrets-in-files).
				content: WRITE_CONTENT_TOOLS.has(toolName)
					? writtenContentFor(toolName, args, this.workingDirectory)
					: (args.content as string),
				command: args.command as string,
				branch: args.branch as string,
				url: args.url as string,
				key: args.key as string,
			});
			const askFirst = !gateResult.allowed && gateResult.requiresApproval;
			if (askFirst && isDesktop) {
				const ownBrowser = BROWSER_ASK_FIRST.has(toolName) && isolatedBrowser();
				if (!ownBrowser) {
					const refusal = await this.askDesktopApproval(toolName, args, gateResult.reason);
					if (refusal) return refusal;
				}
			} else if (askFirst && isMcpCall) {
				// Ask in Ask and Guarded; Infinite runs; no card means no call.
				const refusal = await askMcpApproval(
					String(args.server),
					String(args.tool),
					args.args as Record<string, unknown> | undefined,
					gateResult.reason,
				);
				if (refusal) return refusal;
			} else if (!gateResult.allowed) {
				// Say plainly that nothing happened (see blockedToolMessage).
				return blockedToolMessage(
					toolName,
					policyAction === "write_file",
					typeof writeTarget === "string" && writeTarget ? writeTarget : undefined,
					gateResult.reason,
					gateResult.alternative,
				);
			}
		}

		// One-file extension tools (G1): after every gate above, never in a Table
		// session. execute() then scrubs, filters and chips the result.
		if (this.extensionRunner?.has(toolName)) {
			if (this.agentId === "__table__") {
				return `Error: extension tool "${toolName}" is not available in this session; nothing was run.`;
			}
			return this.extensionRunner.run(toolName, args);
		}

		// Delegate windowed-session orchestration tools to their own module so the
		// giant switch below stays focused on "operate on this repo" rather than
		// "operate on a fleet of CLIs in tmux".
		//
		// Deliberately AFTER the gate. It sat above it, and that single line of
		// ordering was a sandbox escape.
		if (isTermTool(toolName)) {
			return executeTermTool(toolName, args);
		}

		switch (toolName) {
			// Code exploration
			case "get_outline":
				return this.getOutline(args.filePath as string);
			case "get_symbol":
				return this.getSymbol(args.symbolId as string);
			case "search_symbols":
				return this.searchSymbols(args.query as string, args.kinds as string[]);
			case "locate":
				return this.locate(args.query as string);
			case "update_plan":
				// Executes nothing: the plan event is the onToolStart the agent
				// fires with these args; the TUI PLAN column reads it (#3035).
				return updatePlan(args as { plan?: unknown }, this.workingDirectory);
			case "get_project_outline":
				return this.getProjectOutline();

			// LSP tools
			case "lsp_goto_definition":
				return lspGoToDefinition(
					args.filePath as string,
					args.line as number,
					args.character as number,
					this.workingDirectory,
				);
			case "lsp_find_references":
				return lspFindReferences(
					args.filePath as string,
					args.line as number,
					args.character as number,
					this.workingDirectory,
				);
			case "lsp_hover":
				return lspHover(
					args.filePath as string,
					args.line as number,
					args.character as number,
					this.workingDirectory,
				);
			case "lsp_document_symbols":
				return lspDocumentSymbols(args.filePath as string, this.workingDirectory);
			case "lsp_diagnostics":
				return lspDiagnostics(args.filePath as string, this.workingDirectory);

			// File operations (with path traversal protection)
			case "read_file": {
				const safe = safePath(args.path as string, this.workingDirectory, "read");
				return this.readFile(safe, args.offset, args.limit);
			}
			case "write_file": {
				const safe = safePath(args.path as string, this.workingDirectory, "write");
				return this.writeFile(safe, args.content as string);
			}
			case "edit_file": {
				const safe = safePath(args.path as string, this.workingDirectory, "write");
				// Anchored edit (#3472): only with the flag on and an anchor sent.
				if (hashlineEnabled() && args.anchor !== undefined && args.anchor !== "") {
					return this.editFileAnchored(safe, args.anchor, String(args.newText ?? ""));
				}
				return this.editFile(
					safe,
					args.oldText as string,
					args.newText as string,
					typeof args.startLine === "number" ? args.startLine : undefined,
				);
			}
			case "list_files": {
				const dir = (args.path as string) || ".";
				const safeDir = safePath(dir, this.workingDirectory, "read");
				return this.listFiles(safeDir, args.pattern as string);
			}

			// Git operations
			case "git_status":
				return this.runCommand("git status");
			case "git_diff":
				return this.runCommand(args.staged ? "git diff --staged" : "git diff");
			case "git_log": {
				const count = Math.floor(Math.abs(Number(args.count) || 10));
				return spawnGit(["log", "--oneline", `-${count}`], this.workingDirectory);
			}
			case "git_branch":
				return spawnGit(["branch", "-a"], this.workingDirectory);
			case "git_checkout":
				return spawnGit(["checkout", String(args.branch)], this.workingDirectory);
			case "git_create_branch":
				return spawnGit(["checkout", "-b", String(args.branch)], this.workingDirectory);
			case "git_add": {
				const files = String(args.files || ".")
					.split(/\s+/)
					.filter(Boolean);
				return spawnGit(["add", ...files], this.workingDirectory);
			}
			case "git_commit":
				return this.gatedCommit(() =>
					spawnGit(["commit", "-m", String(args.message)], this.workingDirectory),
				);
			case "git_push": {
				const pushArgs = ["push"];
				if (args.setUpstream) pushArgs.push("-u", "origin", "HEAD");
				return spawnGit(pushArgs, this.workingDirectory);
			}

			// GitHub CLI (spawn with arg arrays, no shell interpolation)
			case "gh_pr_list":
				return this.runCommand("gh pr list");
			case "gh_pr_create":
				return this.runSpawn("gh", [
					"pr",
					"create",
					"--title",
					String(args.title),
					"--body",
					String(args.body || ""),
				]);
			case "gh_pr_view":
				return this.runSpawn("gh", ["pr", "view", String(args.number || "")]);
			case "gh_issue_list":
				return this.runCommand("gh issue list");
			case "post_message": {
				// Policy gate, then the person, inside postMessage; never a shell string.
				let text = typeof args.text === "string" ? args.text : "";
				// text_file (#3838): a drafted message in the project, read here so no
				// shell substitution is needed. safePath keeps it inside the workspace.
				if (text === "" && typeof args.text_file === "string" && args.text_file !== "") {
					const file = safePath(args.text_file, this.workingDirectory, "read");
					if (!fs.existsSync(file)) return `[ERROR] text_file not found: ${args.text_file}`;
					if (fs.statSync(file).size > 64 * 1024)
						return "[ERROR] text_file is over 64 KB; a message is at most 4096 characters.";
					text = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
				}
				// attachment (#4265): a file inside the project, resolved with the same
				// workspace guard as every file tool (traversal, symlink escape, credential files).
				let attachment: Attachment | undefined;
				if (args.attachment != null && args.attachment !== "") {
					const r = resolveAttachment(args.attachment, (p) =>
						safePath(p, this.workingDirectory, "read"),
					);
					if (!r.attachment) return r.error as string;
					attachment = r.attachment;
				}
				// Pre-send check (#4191): the task's countable rules, counted in the draft with code
				// (after text_file is read, so a drafted file is counted too). A bare file has no draft.
				if (text !== "" || !attachment) {
					const presend = this.presendCheck(text);
					if (presend) return presend;
				}
				return postMessage(
					{
						chat: String(args.chat ?? ""),
						text,
						voice: typeof args.voice === "string" && args.voice ? args.voice : undefined,
						attachment,
					},
					postMessageDeps(this.agentId, this.postSession),
				);
			}
			case "message_boardroom":
				// A fixed local file, no path from the model, no network: not routed through a policy action.
				if (!messageBoardroomOn()) return "Error: message_boardroom is switched off here.";
				return messageBoardroom(args, { session: this.postSession, task: this.presendTask });
			case "gh_issue_create": {
				const held = this.issueBlameGate.check(String(args.body || ""));
				if (held) return held;
				return this.runSpawn("gh", [
					"issue",
					"create",
					"--title",
					String(args.title),
					"--body",
					String(args.body || ""),
				]);
			}

			// Shell
			case "run_command": {
				const command = args.command as string;
				// #4320: a ticket blames one file; a body naming two is held once for a trim.
				const issueBody = issueBodyOf(command, this.workingDirectory);
				const held = issueBody === null ? null : this.issueBlameGate.check(issueBody);
				if (held) return held;
				const run = () => this.runCommand(command, args.timeout as number | undefined);
				// A command the sanitizer refuses never commits, so it never runs the suite.
				const target = parseGitCommit(command);
				// Judged on the text that will run: a `cd <folder> &&` commit meets the gate too (#3199).
				const runs = commandAfterCdPrefix(command, this.workingDirectory, activeShellKind());
				const result = await (target && sanitizeShellCommand(runs).safe
					? this.gatedCommit(run, target)
					: run());
				if (/^\[(BLOCKED|PERMISSION DENIED)\]/.test(result.trimStart())) {
					this.blockedCommands.push(command);
				}
				return result;
			}

			case "powershell": {
				const shell = powershellToolShell();
				if (!shell) return "Error: the powershell tool is off. Use run_command.";
				return withForcedShell(shell, () =>
					this.runCommand(
						args.command as string,
						args.timeout as number | undefined,
						undefined,
						shell,
					),
				);
			}

			// Multi-agent orchestration
			case "spawn_agent":
				return this.handleSpawnAgent(
					args.task as string,
					args.runtime as "8gent" | "claude" | "shell" | undefined,
					args.model as string | undefined,
					args.timeout as number | undefined,
					normaliseAllowedPaths(args.allowedPaths),
					args.permissionMode,
				);
			case "check_agent":
				return this.handleCheckAgent(args.agentId as string);
			case "list_agents":
				return this.handleListAgents();

			// Image tools
			case "read_image":
				return this.handleReadImage(args.path as string);
			case "compare_layout": {
				const html = safePath(String(args.html ?? ""), this.workingDirectory, "read");
				const reference = safePath(String(args.reference ?? ""), this.workingDirectory, "read");
				const { compareLayout } = await import("../tools/layout-compare");
				return compareLayout(html, reference, this.workingDirectory);
			}
			case "screen_locate": {
				const image = safePath(String(args.image ?? ""), this.workingDirectory, "read");
				const { screenLocate } = await import("../eyes/ground/screen-locate.js");
				return screenLocate({
					image,
					target: String(args.target ?? ""),
					viewport: args.viewport as string | undefined,
				});
			}
			case "describe_image":
				return this.handleDescribeImage(args.path as string, args.prompt as string | undefined);

			case "speak": {
				try {
					const out = resolveSpeakOut(args.out, this.workingDirectory);
					const { speak } = await import("../tools/speak");
					return JSON.stringify(
						await speak({
							text: args.text as string,
							voice: (args.voice as string | undefined) ?? this.tabVoice,
							out,
						}),
					);
				} catch (err) {
					return `Error: speak failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			case "render_video_deck": {
				try {
					const out = resolveDeckOut(args.out, this.workingDirectory);
					// An edit-scoped sub-agent renders only into its scope (same check as write_file).
					const scoped = editScopeViolation(
						"render_video_deck",
						{ out: args.out ?? "deck.mp4" },
						this.workingDirectory,
						this.allowedPaths,
					);
					if (scoped) return scoped;
					const chapters = resolveDeckChapters(out, this.workingDirectory);
					const scopedChapters = editScopeViolation(
						"render_video_deck",
						{ out: chapters },
						this.workingDirectory,
						this.allowedPaths,
					);
					if (scopedChapters) return scopedChapters;
					const { renderVideoDeck } = await import("../tools/video-deck");
					return JSON.stringify(
						await renderVideoDeck({ spec: args.spec, out, cwd: this.workingDirectory }),
					);
				} catch (err) {
					return `Error: render_video_deck failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			case "make_docx":
			case "make_xlsx":
			case "make_pptx": {
				try {
					const tool = toolName as OfficeToolName;
					const out = resolveOfficeOut(tool, args.out, this.workingDirectory);
					// An edit-scoped child session writes only into its scope (same check as write_file).
					const scoped = editScopeViolation(
						toolName,
						{ out: args.out ?? path.basename(out) },
						this.workingDirectory,
						this.allowedPaths,
					);
					if (scoped) return scoped;
					const { makeOffice } = await import("../tools/office/index");
					return JSON.stringify(
						makeOffice(OFFICE_TOOLS[tool], args.spec, out, this.workingDirectory),
					);
				} catch (err) {
					return `Error: ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}

			// PDF tools
			case "read_pdf":
				return this.handleReadPdf(args.path as string);
			case "read_pdf_page":
				return this.handleReadPdfPage(args.path as string, args.pageNum as number);
			case "search_pdf":
				return this.handleSearchPdf(
					args.path as string,
					args.query as string,
					args.caseSensitive as boolean | undefined,
				);

			// Video tool (VIDEO-INGESTION spec §6)
			case "extract_video":
				return this.handleExtractVideo(
					args.path as string,
					args.mode as ExtractVideoMode | undefined,
					args.query as string | undefined,
					args.ingest as boolean | undefined,
				);

			// Notebook tools
			case "read_notebook":
				return this.handleReadNotebook(args.path as string);
			case "notebook_edit_cell":
				return this.handleNotebookEditCell(
					args.path as string,
					args.cellIndex as number,
					args.newSource as string,
				);
			case "notebook_insert_cell":
				return this.handleNotebookInsertCell(
					args.path as string,
					args.afterIndex as number,
					args.cellType as "code" | "markdown",
					args.source as string,
				);
			case "notebook_delete_cell":
				return this.handleNotebookDeleteCell(args.path as string, args.cellIndex as number);

			// Web tools
			case "web_search":
				return this.handleWebSearch(args.query as string, args.maxResults as number);
			case "web_fetch":
				return this.handleWebFetch(args.url as string);

			// Vercel deployment tools
			case "vercel_list_projects":
				return vercelListProjects();
			case "vercel_get_deployments":
				return vercelGetDeployments(args.projectId as string, args.limit as number);
			case "vercel_deploy":
				return vercelDeploy(args.projectId as string);
			case "vercel_set_env":
				return vercelSetEnv(
					args.projectId as string,
					args.key as string,
					args.value as string,
					args.target as string[],
				);
			case "vercel_get_env":
				return vercelGetEnv(args.projectId as string);
			case "vercel_list_domains":
				return vercelListDomains(args.projectId as string);
			case "vercel_get_deployment_logs":
				return vercelGetDeploymentLogs(args.deploymentId as string);

			// MCP tools
			case "mcp_list_tools":
				if (process.env.EIGHT_MCP_LEAN === "1")
					return (await import("../mcp/lean")).leanListToolsConnected(
						getMCPClient(),
						args,
						currentPermissionMode() !== "plan",
						askMcpStartApproval,
					);
				return this.handleMCPListTools();
			case "mcp_call_tool":
				if (process.env.EIGHT_MCP_LEAN === "1")
					return (await import("../mcp/lean")).leanCallTool(
						getMCPClient(),
						args,
						(text) => {
							// Scrub before the lean path can spill to disk (#2464 order).
							const r = scrubSecrets(text);
							if (r.redactedCount > 0)
								console.warn(
									`[secret-scanner] tool=mcp_call_tool redacted=${r.redactedCount} rules=${r.rules.join(",")}`,
								);
							return r.scrubbed;
						},
						// Starting servers is its own card, whatever this call's card said (#3474).
						askMcpStartApproval,
					);
				return this.handleMCPCallTool(
					args.server as string,
					args.tool as string,
					args.args as Record<string, unknown>,
				);

			// Background task tools
			case "background_start":
				return this.handleBackgroundStart(args.command as string, args.timeout as number);
			case "background_status":
				return this.handleBackgroundStatus(args.taskId as string);
			case "background_output":
				return this.handleBackgroundOutput(args.taskId as string, args.tail as number);

			case "use_skill":
				// Name lookup only (#3593): the model never passes a path, so nothing outside the skill folders is read.
				return useSkill(args, { projectDir: this.workingDirectory });

			case "film_craft":
				// Every path is confined to the workspace (no traversal, no symlink out) and made
				// absolute, so film.sh writes only inside it and runs the same from any folder.
				return filmCraft(args, {
					write: (p) => confineWrite(p, this.workingDirectory),
					read: (p) => confineRead(p, this.workingDirectory),
				});

			// Design tools
			case "suggest_design":
				return this.handleSuggestDesign(
					args.task as string,
					args.projectType as string | undefined,
				);
			case "deck_theme":
				return this.handleDeckTheme(args);
			case "query_design_system":
				return this.handleQueryDesignSystem(args);

			// Infinite mode
			case "enable_infinite_mode":
				return this.handleEnableInfiniteMode(
					args.task as string,
					args.maxIterations as number | undefined,
					args.maxTimeMs as number | undefined,
				);

			// Memory tools
			case "remember":
				return await this.handleRemember(
					args.fact as string,
					args.layer as "session" | "project" | "global",
				);
			case "recall":
				return await this.handleRecall(args.query as string, args.limit as number | undefined);

			// Desktop Computer Use tools (Power #10)
			case "desktop_screenshot":
				return this.handleDesktopScreenshot(
					args.path as string | undefined,
					args.displayId as number | undefined,
				);
			case "desktop_click":
				return this.handleDesktopClick(
					args.x as number,
					args.y as number,
					args.button as string | undefined,
					args.count as number | undefined,
					args.coordMap as string | undefined,
				);
			case "desktop_type":
				return this.handleDesktopType(args.text as string, args.delay as number | undefined);
			case "desktop_press":
				return this.handleDesktopPress(
					args.keys as string,
					args.count as number | undefined,
					args.delay as number | undefined,
				);
			case "desktop_scroll":
				return this.handleDesktopScroll(
					args.direction as string,
					args.amount as number | undefined,
					args.x as number | undefined,
					args.y as number | undefined,
				);
			case "desktop_drag":
				return this.handleDesktopDrag(
					args.fromX as number,
					args.fromY as number,
					args.toX as number,
					args.toY as number,
					args.button as string | undefined,
					args.duration as number | undefined,
				);
			case "desktop_hover":
				return this.handleDesktopHover(
					args.x as number,
					args.y as number,
					args.coordMap as string | undefined,
				);
			case "desktop_windows":
				return this.handleDesktopWindows();
			case "desktop_clipboard":
				return this.handleDesktopClipboard(args.action as string, args.text as string | undefined);
			case "desktop_processes":
				return this.handleDesktopProcesses(args.sort as string | undefined);
			case "desktop_quit_app":
				return this.handleDesktopQuitApp(
					args.name as string | undefined,
					args.pid as number | undefined,
					args.strategy as string | undefined,
				);
			case "desktop_suggest_quit":
				return this.handleDesktopSuggestQuit();
			case "desktop_safe_list":
				return this.handleDesktopSafeList(args.action as string, args.app as string | undefined);
			case "run_computer_task":
				return this.handleRunComputerTask(args.goal as string, args.maxSteps as number | undefined);
			case "desktop_act":
				return this.handleDesktopAct(args);

			// Browser Use tools
			case "browser_open":
				return this.handleBrowserOpen(
					args.url as string,
					args.browser as string | undefined,
					args.session as string | undefined,
				);
			case "browser_state":
				return this.handleBrowserState(args.session as string | undefined);
			case "browser_task":
				return this.handleBrowserTask(
					args.actions,
					args.task as string | undefined,
					args.browser as string | undefined,
					args.session as string | undefined,
				);
			case "browser_screenshot":
				return this.handleBrowserScreenshot(
					args.path as string | undefined,
					args.session as string | undefined,
				);

			default:
				return `Unknown tool: ${toolName}`;
		}
	}

	// ============================================
	// Code Exploration
	// ============================================

	private async getOutline(filePath: string): Promise<string> {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		if (!fs.existsSync(absolutePath)) {
			return `File not found: ${absolutePath}`;
		}

		try {
			const outline = this.readOutline(absolutePath);
			const symbols = outline.symbols.map((s) => ({
				name: s.name,
				kind: s.kind,
				lines: `${s.startLine}-${s.endLine}`,
				signature: s.signature?.slice(0, 80),
			}));

			return JSON.stringify(
				{
					filePath: absolutePath,
					language: outline.language,
					symbolCount: symbols.length,
					symbols,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error parsing file: ${err}`;
		}
	}

	private async getSymbol(symbolId: string): Promise<string> {
		const separatorIndex = symbolId.lastIndexOf("::");
		if (separatorIndex === -1) {
			return `Invalid symbol ID format. Expected 'path/to/file.ts::symbolName'`;
		}

		const filePath = symbolId.slice(0, separatorIndex);
		const symbolName = symbolId.slice(separatorIndex + 2);

		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		if (!fs.existsSync(absolutePath)) {
			return `File not found: ${absolutePath}`;
		}

		try {
			const outline = this.readOutline(absolutePath);
			const symbol = outline.symbols.find((s) => s.name === symbolName);

			if (!symbol) {
				return `Symbol '${symbolName}' not found. Available: ${outline.symbols.map((s) => s.name).join(", ")}`;
			}

			const source = getSymbolSource(absolutePath, symbol.startLine, symbol.endLine);
			return `// ${symbol.kind}: ${symbol.name}\n// Lines ${symbol.startLine}-${symbol.endLine}\n\n${source}`;
		} catch (err) {
			return `Error: ${err}`;
		}
	}

	/**
	 * Outline for one file: the shared index when it holds the file (re-parsed
	 * in place if the file changed on disk), otherwise a direct parse.
	 */
	private readOutline(absolutePath: string): FileOutline {
		if (this.astIndexReady && this.astRepoId) {
			const rel = path.relative(this.workingDirectory, absolutePath);
			if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
				const indexed = astGetFreshFileOutline(this.astRepoId, rel);
				if (indexed) return indexed;
			}
		}
		return parseTypeScriptFile(absolutePath);
	}

	private async searchSymbols(query: string, kinds?: string[]): Promise<string> {
		if (!this.astIndexReady && this.astIndexPromise) {
			await this.astIndexPromise;
		}
		if (!this.astRepoId) {
			return JSON.stringify(
				{ query, matches: [], error: "AST index not available. Use run_command with rg instead." },
				null,
				2,
			);
		}

		const repoId = this.astRepoId;
		// Pick up files created, edited or deleted since the build (by any
		// tool, shell or editor) before ranking: one stat per file, no re-parse
		// unless the mtime moved.
		astRefreshIndex(repoId);
		const hits = astSearchSymbols(repoId, query, {
			kinds: kinds?.length ? kinds : undefined,
			limit: 20,
		});

		const matches = hits.map((symbol) => ({
			name: symbol.name,
			kind: symbol.kind,
			file: path.relative(this.workingDirectory, symbol.filePath),
			line: symbol.startLine,
		}));
		return JSON.stringify({ query, matches }, null, 2);
	}

	/**
	 * Read-only "where is X?": rules route the query to the ranked symbol
	 * index, a fuzzy path match or a literal rg search under the working
	 * directory (see ast-index/locate.ts). No model is called unless
	 * EIGHT_SYSTEM_ONE_LOCATE=1, and then only for prose the rules cannot route.
	 */
	private async locate(query: string): Promise<string> {
		// Wait for the index build only briefly: path and text search do not
		// need it, and a first call on a large repo would otherwise stall for
		// the whole build. The answer says when symbol search was skipped.
		let repoId = this.astRepoId;
		let indexPending = false;
		if (!this.astIndexReady && this.astIndexPromise) {
			const waited = await awaitIndex(
				this.astIndexPromise.then((index) => index?.id ?? null),
				LOCATE_INDEX_WAIT_MS,
			);
			repoId = waited.repoId;
			indexPending = waited.pending;
		}
		const result = await astLocate(typeof query === "string" ? query : "", {
			root: this.workingDirectory,
			repoId,
			indexPending,
		});
		return formatLocate(result);
	}

	private async getProjectOutline(): Promise<string> {
		// Ensure index is ready
		if (!this.astIndexReady && this.astIndexPromise) {
			try {
				await this.astIndexPromise;
			} catch {
				return "AST index not available. Use get_outline on individual files instead.";
			}
		}

		if (!this.astRepoId) {
			return "Project not indexed. Use get_outline on individual files instead.";
		}

		const fileTree = astGetFileTree(this.astRepoId);
		if (fileTree.length === 0) {
			return "No indexed files found in project.";
		}

		const fileEntries: string[] = [];
		let totalSymbols = 0;

		for (const filePath of fileTree) {
			const outline = astGetFileOutline(this.astRepoId, filePath);
			if (outline) {
				const symbolNames = outline.symbols.map((s) => `${s.kind[0]}:${s.name}`).join(", ");
				const count = outline.symbols.length;
				totalSymbols += count;
				fileEntries.push(`  ${filePath} (${count}) → ${symbolNames}`);
			}
		}

		return [
			`[PROJECT MAP] ${fileTree.length} files, ${totalSymbols} symbols indexed`,
			`Root: ${this.workingDirectory}`,
			"",
			"Files (symbol count) → symbols:",
			...fileEntries,
			"",
			"TIP: Use get_symbol('path/to/file.ts::symbolName') to fetch specific code.",
		].join("\n");
	}

	// ============================================
	// File Operations
	// ============================================

	private async readFile(
		filePath: string,
		offsetArg?: unknown,
		limitArg?: unknown,
	): Promise<string> {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		if (!fs.existsSync(absolutePath)) {
			return `File not found: ${absolutePath}`;
		}

		// A Word, Excel or PowerPoint file is a zip: return its text, not its bytes (#4274).
		if (isOfficeFile(absolutePath)) {
			this.seenPaths.add(absolutePath);
			return readOfficeFile(absolutePath, fs.readFileSync(absolutePath));
		}

		const content = fs.readFileSync(absolutePath, "utf-8");
		this.retiredFacts.noteRead(absolutePath, content);
		this.seenPaths.add(absolutePath);
		const lines = content.split("\n");
		// A trailing newline ends the last line; it does not start another one.
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		if (content === "") return "";

		const isCodeFile = /\.(ts|tsx|js|jsx)$/.test(absolutePath);
		const withLinks = (body: string): string => {
			const footer = isCodeFile
				? linksFooter(absolutePath, content, this.seenPaths, this.workingDirectory, (abs) => {
						try {
							safePath(abs, this.workingDirectory, "read");
							return true;
						} catch {
							return false;
						}
					})
				: "";
			return footer ? `${body}\n\n${footer}` : body;
		};
		// Anchors per row with EIGHT_EDIT_FORMAT=hashline (#3472), else `cat -n`.
		const numberRows = hashlineEnabled() ? hashLines : numberLines;
		const offset = positiveInt(offsetArg);
		const limit = positiveInt(limitArg);

		// A slice (#3375): the numbers stay the file's real line numbers.
		if (offset !== undefined || limit !== undefined) {
			const start = offset ?? 1;
			if (start > lines.length) {
				return `File has ${lines.length} lines; offset ${start} is past the end.`;
			}
			const count = limit ?? (isCodeFile ? 200 : lines.length);
			const end = Math.min(lines.length, start - 1 + count);
			const body = numberRows(lines.slice(start - 1, end), start);
			return withLinks(
				end < lines.length
					? `${body}\n\n[Lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]`
					: body,
			);
		}

		// AST-first interception: for code files > 200 lines, prepend outline
		if (isCodeFile && lines.length > 200) {
			let outlineHeader = "";

			// Ensure index is ready (wait briefly if still indexing)
			if (!this.astIndexReady && this.astIndexPromise) {
				try {
					await Promise.race([
						this.astIndexPromise,
						new Promise((_, reject) => setTimeout(() => reject("timeout"), 500)),
					]);
				} catch {
					// Index not ready yet, proceed without outline
				}
			}

			if (this.astIndexReady && this.astRepoId) {
				const relativePath = path.relative(this.workingDirectory, absolutePath);
				const outline = astGetFileOutline(this.astRepoId, relativePath);
				if (outline && outline.symbols.length > 0) {
					const symbolList = outline.symbols
						.map((s) => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
						.join("\n");
					outlineHeader = `[AST: This file has ${outline.symbols.length} symbols. Use get_symbol to fetch specific ones instead of reading the full file.]\n\nSymbols:\n${symbolList}\n\n---\n\n`;
				}
			} else {
				// Fallback: parse directly if index isn't ready
				try {
					const directOutline = parseTypeScriptFile(absolutePath);
					if (directOutline.symbols.length > 0) {
						const symbolList = directOutline.symbols
							.map((s) => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
							.join("\n");
						outlineHeader = `[AST: This file has ${directOutline.symbols.length} symbols. Use get_symbol to fetch specific ones instead of reading the full file.]\n\nSymbols:\n${symbolList}\n\n---\n\n`;
					}
				} catch {
					// Can't parse, just return truncated content
				}
			}

			return withLinks(
				`${outlineHeader}// File has ${lines.length} lines. Showing first 200:\n\n${numberRows(lines.slice(0, 200), 1)}\n\n// ... truncated. Use offset=201 to read on, or get_outline + get_symbol for specific sections.`,
			);
		}

		if (DIFF_FILE.test(absolutePath)) {
			const diff = numberDiffLines(lines);
			if (diff !== null) return diff;
		}
		return withLinks(numberRows(lines, 1));
	}

	private async writeFile(filePath: string, content: string): Promise<string> {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		// Design-agent gate: if writing a UI file, check if a design system should be suggested
		const uiExtensions = [".tsx", ".jsx", ".css", ".html", ".svelte", ".vue"];
		const ext = path.extname(absolutePath).toLowerCase();
		let designHint = "";
		if (uiExtensions.includes(ext)) {
			try {
				const isNewFile = !fs.existsSync(absolutePath);
				if (isNewFile && needsDesignDecision(`create UI file ${path.basename(absolutePath)}`)) {
					const detection = await detectDesignNeed(
						`create UI component: ${path.basename(absolutePath)}`,
					);
					if (detection.needsDesign) {
						designHint = `\n[Design Agent] This is a new UI file. Consider using suggest_design or query_design_system to ensure consistent design. Detected: ${detection.reason}`;
					}
				}
			} catch {
				// Design check is advisory, never block writes
			}
		}

		// Overwrite guard (#4238): a file the model never read is not its to replace once a
		// refused command named it. A blocked probe ("ls x; echo $?") once read as "missing" and it wrote over the real
		// count-todos.ts. Same bytes, or a path read/written this session, passes.
		const base = path.basename(absolutePath);
		if (
			process.env.EIGHT_OVERWRITE_GUARD !== "0" &&
			fs.existsSync(absolutePath) &&
			!this.seenPaths.has(absolutePath) &&
			this.blockedCommands.some((c) => c.includes(base))
		) {
			let current: string | null = null;
			try {
				if (fs.statSync(absolutePath).isFile()) current = fs.readFileSync(absolutePath, "utf-8");
			} catch {
				current = null;
			}
			if (current !== null && current !== content) {
				return `Error: ${absolutePath} already exists and you have not read it this session, so write_file will not replace it. A command that was blocked or errored tells you nothing about whether a file exists. Run read_file on it first; to change part of it use edit_file; to run it, leave it alone.`;
			}
		}
		this.seenPaths.add(absolutePath);

		const dir = path.dirname(absolutePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const wasNew = pathAbsent(absolutePath);
		const recordWrite = watchWrite(absolutePath, this.createdFiles);
		fs.writeFileSync(absolutePath, content);
		recordWrite();

		// Report what is on disk so a requested count can be checked (#3580).
		const shape = writeShapeLine(absolutePath, content);
		if (shape) designHint += `\n${shape}`;
		// A new top-folder file while the work lives in one subfolder (#3580).
		const scope = writeScopeLine(this.createdFiles, this.workingDirectory, absolutePath, wasNew);
		if (scope) designHint += `\n${scope}`;

		// A date or number a file read this turn marks retired (#3811): warn, never block.
		const retiredLine = this.retiredFacts.warn(absolutePath, content);
		if (retiredLine) designHint += `\n${retiredLine}`;

		// Marp decks always get a narrated deck.mp4 beside them (EIGHT_DECK_VIDEO=0 opts out).
		const deckLine = await deckVideoAfterWrite(absolutePath, content, this.workingDirectory);
		if (deckLine) designHint += `\n${deckLine}`;

		// Put a finished deliverable in front of the user (#3107): only viewable
		// files, only interactively, never from a spawned sub-agent, once per
		// path per turn. Source and config files are never opened.
		const decision = decideOpenOnWrite({
			absolutePath,
			content,
			platform: process.platform,
			openOnWrite: this.openOnWrite,
			isTTY: Boolean(process.stdout.isTTY),
			env: process.env,
			openedThisTurn: this.openedThisTurn,
		});
		const opened = decision.open && openWrittenFile(absolutePath);
		if (opened) this.openedThisTurn.add(absolutePath);

		// Say "opened" only when it was.
		return `${opened ? "File written and opened" : "File written"}: ${absolutePath}${designHint}`;
	}

	/** edit_file by read_file anchors (#3472); the hash is checked against the file now. */
	private editFileAnchored(filePath: string, anchor: unknown, newText: string): string {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);
		if (!fs.existsSync(absolutePath)) return `File not found: ${absolutePath}`;
		const edit = applyAnchoredEdit(
			fs.readFileSync(absolutePath, "utf-8"),
			anchor,
			newText,
			filePath,
		);
		if (!edit.ok) return edit.error;
		const recordEdit = watchWrite(absolutePath, this.createdFiles);
		fs.writeFileSync(absolutePath, edit.content);
		recordEdit();
		return anchoredEditMessage(absolutePath, edit);
	}

	private async editFile(
		filePath: string,
		oldText: string,
		newText: string,
		startLine?: number,
	): Promise<string> {
		// No anchor, no edit (#3101): indexOf("") is 0, so an empty oldText
		// used to prepend newText to the file.
		const noAnchor = emptyOldTextError(oldText, filePath);
		if (noAnchor) return noAnchor;
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		if (!fs.existsSync(absolutePath)) {
			return `File not found: ${absolutePath}`;
		}

		const content = fs.readFileSync(absolutePath, "utf-8");

		// A gutter copied into newText would be written to disk as file text
		// (#3375). Refuse it, never strip it: the bytes written must be the
		// bytes the policy gate checked. Files that already hold gutter-shaped
		// lines (oldText carries one, or the file has one) are left editable.
		if (
			hasLineNumberGutter(newText) &&
			!hasLineNumberGutter(oldText) &&
			!content.split("\n").some((l) => GUTTER.test(l))
		) {
			return `Error: newText starts each line with a read_file line-number prefix (number + tab). That prefix would be written into ${filePath} as file text. Nothing was written: send newText without the prefix.`;
		}

		// Literal replacement, so the bytes written are the bytes the policy
		// gate checked (String.replace would expand `$&` etc. in newText).
		// A duplicate oldText is refused, never silently applied to the first
		// copy (#3898); the refusal is logged so it can be counted.
		const resolved = resolveEdit(content, oldText, newText, startLine, filePath);
		const refusal = editRefusal(resolved, filePath);
		if (refusal) {
			logEditRefusal(resolved, filePath, oldText.length);
			return refusal;
		}
		if (resolved.kind !== "ok") {
			// read_file numbers its rows (#3375). A model that copies the gutter
			// into oldText gets told so. It is never stripped silently: the
			// bytes written must be the bytes the policy gate checked.
			if (hasLineNumberGutter(oldText)) {
				return `Error: Could not find the text to replace in ${filePath}. oldText starts each line with a read_file line-number prefix (number + tab). That prefix is not in the file: send the line text only.`;
			}
			return formatEditNotFound(filePath, content, oldText);
		}
		const newContent = applyAt(content, resolved.idx, resolved.oldLength, resolved.newText);

		const recordEdit = watchWrite(absolutePath, this.createdFiles);
		fs.writeFileSync(absolutePath, newContent);
		recordEdit();

		if (resolved.matchedLine !== undefined) {
			return `File edited (matched ignoring whitespace at line ${resolved.matchedLine}): ${absolutePath}\nReplaced ${resolved.oldLength} chars with ${resolved.newText.length} chars.`;
		}
		return `File edited: ${absolutePath}\nReplaced ${oldText.length} chars with ${newText.length} chars.`;
	}

	private async listFiles(dirPath = ".", pattern?: string): Promise<string> {
		const { glob } = await import("glob");

		const absolutePath = path.isAbsolute(dirPath)
			? dirPath
			: path.join(this.workingDirectory, dirPath);

		const files = await glob(pattern || "**/*", {
			cwd: absolutePath,
			ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
			nodir: true,
		});

		return files.slice(0, 100).join("\n");
	}

	// ============================================
	// Shell Command Execution
	// ============================================

	/** Commit only past the test-suite gate (#3402); its note, if any, leads the result. */
	private async gatedCommit(commit: () => Promise<string>, target?: CommitTarget): Promise<string> {
		const gate = await this.commitGate.check(target);
		if (!gate.commit) return gate.message;
		const out = await commit();
		return gate.note ? `${gate.note}\n${out}` : out;
	}

	/**
	 * `env` replaces process.env for the child (the done gate passes a scrubbed one).
	 * `cwd` is set only by the one leading `cd <folder> &&` this accepts (#3199).
	 */
	async runCommand(
		command: string,
		timeoutSec?: number,
		env?: Record<string, string | undefined>,
		windowsShell?: ResolvedShell,
		cwd?: string,
	): Promise<string> {
		// One leading `cd <folder> &&` inside the project: the folder is the working
		// directory and only the rest runs, through every check below (#3199).
		if (cwd === undefined) {
			// The backstops judge the whole line first, so a cd into protected files keeps their words.
			const lineBackstop = preSpawnRefusal(command, this.workingDirectory);
			if (lineBackstop) return refusalLead(lineBackstop);
			const cd = cdPrefix(command, this.workingDirectory, activeShellKind(windowsShell));
			if (cd.kind === "refused") return refusalLead(cd.message);
			if (cd.kind === "cd") return this.runCommand(cd.rest, timeoutSec, env, windowsShell, cd.dir);
		}
		const dir = cwd ?? this.workingDirectory;
		if (this.permission && currentPermissionHolder() !== this.permission) {
			return runWithPermissionHolder(this.permission, () =>
				this.runCommand(command, timeoutSec, env, windowsShell, dir),
			);
		}
		// Judge git state against the directory this command runs in (#3748).
		if (commandDir() !== dir) {
			return withCommandDir(dir, () =>
				this.runCommand(command, timeoutSec, env, windowsShell, dir),
			);
		}
		// The four pre-spawn backstops, shared with the native path (#3993).
		const backstop = preSpawnRefusal(command, dir);
		if (backstop) return refusalLead(backstop);
		const mode = currentPermissionMode();
		// The folder a cd prefix chose: the cards name it, and answers are kept per folder.
		const where = folderLabel(dir, this.workingDirectory);
		const permissionCheck = this.permissionManager.checkPermission(
			command,
			activeShellKind(windowsShell),
			where,
		);

		if (permissionCheck === "denied") {
			return `[PERMISSION DENIED] Command blocked by security policy: ${command}`;
		}

		// Validate command for shell injection before asking anyone: a command
		// the sanitizer will refuse must not raise an approval card, or the
		// person approves it and then sees it blocked anyway (#3055).
		const validation = sanitizeShellCommand(
			command,
			process.platform,
			activeShellKind(windowsShell),
		);
		if (!validation.safe) {
			// A piece of the chain System One would refuse on its own is named now,
			// so the pieces are not resent as they are and blocked again (#4072).
			const piece = await chainedPieceRefusal(command, dir, systemOneEnvFor(mode));
			const also = piece ? ` One part would be refused on its own too. ${piece}` : "";
			// After a cd prefix the refusal keeps the folder, or the pieces run at the root (#4260).
			const inFolder = where ? chainInFolderNote(where) : "";
			return refusalLead(
				`[BLOCKED] ${validation.reason}.${also}${inFolder} Command: ${commandInFolder(command, where)}`,
			);
		}

		// System One (on by default, EIGHT_SYSTEM_ONE=0 turns it off): it can only stop a
		// command, never allow one. It runs BEFORE the approval card (#3124): a
		// System One block is final and must not follow a Y the person gave,
		// and when it escalates it asks the person itself, so that answer is
		// the card. One command, at most one card.
		// Guarded mode (#3170) turns System One on for this call whatever the
		// env says; the env flag stays on in every mode.
		// canRunInstead: this executor runs systemOne.runInstead when set (the checked bytes, #4102),
		// only with process.env: a caller-passed env is not the env the gate checked (8SO).
		const systemOne = await systemOneGate(
			command,
			systemOneEnvFor(mode),
			dir,
			this.createdFiles,
			where,
			{ canRunInstead: env === undefined, project: this.workingDirectory },
		);
		if (!systemOne.run) return refusalLead(systemOne.message as string);

		if (
			permissionCheck === "ask" &&
			systemOne.humanApproved !== true &&
			!guardedSkipsCard(mode, systemOne, isCommandDangerous(command))
		) {
			const allowed = await this.permissionManager.requestPermission(
				"Execute Shell Command",
				isCommandDangerous(command)
					? "This command may modify system files or cause data loss."
					: "The agent wants to run a shell command.",
				command,
				{ where },
			);

			if (!allowed) {
				return (
					channelDenialMessage(command) ??
					`[PERMISSION DENIED] User declined to execute: ${command}`
				);
			}
		}

		const startTime = Date.now();
		await this.hookManager.executeHooks("beforeCommand", {
			command,
			workingDirectory: dir,
		});

		let finalCommand = command;
		if (command.includes("create-next-app") && !command.includes("--yes")) {
			finalCommand = command.replace("create-next-app", "create-next-app --yes");
		}
		if (command.includes("npm init") && !command.includes("-y")) {
			finalCommand = `${command} -y`;
		}
		// System One checked these bytes, not the file the command names: run them (8SO, #4102).
		if (systemOne.runInstead !== undefined) finalCommand = systemOne.runInstead;

		const timeoutMs = Math.min(timeoutSec || 120, 300) * 1000;

		const sandboxRefusal = runCommandSandboxRefusal();
		if (sandboxRefusal) return refusalLead(sandboxRefusal);

		return new Promise((resolve) => {
			// Redirect targets this command creates are this agent's own files (#3177).
			const recordRedirects = watchRedirects(finalCommand, dir, this.createdFiles);
			let resolved = false;
			const safeResolve = (value: string) => {
				if (resolved) return;
				resolved = true;
				recordRedirects();
				resolve(value);
			};

			// The kernel boundary (#4009, #3612): no write to ~/.8gent startup code, secrets or records.
			const proc = spawnShell(wrapRunCommand(finalCommand), {
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
				processGroup: true,
				windowsShell,
				env: {
					// The done gate hands in an already scrubbed env; everything else gets the minimal one.
					...((env as NodeJS.ProcessEnv | undefined) ?? (buildChildEnv() as NodeJS.ProcessEnv)),
					...SPAWN_NON_INTERACTIVE_ENV,
				},
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			const timeout = setTimeout(() => {
				killProcessTree(proc.pid, "SIGTERM");
				setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 3000);

				this.hookManager.executeHooks("afterCommand", {
					command: finalCommand,
					exitCode: -1,
					stdout,
					stderr: `${stderr}\nTIMEOUT`,
					duration: Date.now() - startTime,
					workingDirectory: dir,
				});

				safeResolve(
					`TIMEOUT after ${timeoutMs / 1000}s. Partial output:\n${stdout}\n${stderr}\nTIP: Try bun instead of npx, or add --yes flag.`,
				);
			}, timeoutMs);

			proc.unref();

			proc.on("close", (code) => {
				clearTimeout(timeout);

				this.hookManager.executeHooks("afterCommand", {
					command: finalCommand,
					exitCode: code ?? 0,
					stdout,
					stderr,
					duration: Date.now() - startTime,
					workingDirectory: dir,
				});

				let output = formatCommandOutput(
					code,
					stdout,
					stderr,
					finalCommand,
					dir,
					this.workingDirectory,
				);
				// Once per session, on a failure, say the environment is minimal (no names or values).
				if (code !== 0 && !this.envHintShown && withheldAny()) {
					this.envHintShown = true;
					output = `${output}\n${ENV_PASS_HINT}`;
				}
				// Report images the command drew, and any cut off at an edge (#3580).
				withImagesWritten(output, dir, startTime).then(safeResolve, () => safeResolve(output));
			});

			proc.on("error", (err) => {
				clearTimeout(timeout);

				this.hookManager.executeHooks("onError", {
					command: finalCommand,
					error: err.message,
					workingDirectory: dir,
				});

				safeResolve(`Error: ${err.message}`);
			});
		});
	}

	/**
	 * Run a command with explicit argument array (no shell interpolation).
	 * Use for commands with LLM-provided arguments to prevent injection.
	 */
	private async runSpawn(cmd: string, args: string[]): Promise<string> {
		const { spawn } = await import("node:child_process");
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			const proc = spawn(cmd, args, {
				cwd: this.workingDirectory,
				env: buildChildEnv(process.env, GH_ENV_NAMES) as NodeJS.ProcessEnv,
			});
			proc.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			proc.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
			proc.on("close", (code: number | null) => {
				resolve(code === 0 ? stdout.trim() : `Error (exit ${code}): ${stderr.trim()}`);
			});
			proc.on("error", (err: Error) => resolve(`Error: ${err.message}`));
		});
	}

	// ============================================
	// Image Tool Handlers
	// ============================================

	private async handleReadImage(imagePath: string): Promise<string> {
		// The same path guard as read_file: workspace containment, credential
		// and device paths, symlink escapes. It runs before any existence check,
		// so a refused path reads the same whether or not the file is there.
		let absolutePath: string;
		try {
			absolutePath = safePath(imagePath, this.workingDirectory, "read");
		} catch (err) {
			return `Error reading image: ${err instanceof Error ? err.message : String(err)}`;
		}

		try {
			// A model that can see gets the pixels (#3641): downscaled to fit
			// imageMaxSide (2560 local and hosted; #4293) so a Retina screenshot does not swamp its context, and
			// attached to the next message by the text-tool loop. The text part
			// is the metadata the model always had.
			if (await this.visionCapable()) {
				const side = imageMaxSide(this.localRuntime());
				const shown = await resizeImage(absolutePath, side, side);
				const mimeType = `image/${shown.format === "jpg" ? "jpeg" : shown.format}`;
				// #4293: when the copy is smaller than the original, the fields that map
				// its coordinates back ride inside the JSON so the text stays parseable.
				const original = {
					width: shown.originalWidth ?? shown.width,
					height: shown.originalHeight ?? shown.height,
				};
				const note = downscaleNote(original, shown);
				const meta = JSON.stringify(
					{
						path: shown.path,
						width: shown.width,
						height: shown.height,
						format: shown.format,
						attached: "The image is attached to this message for you to look at.",
						...(note
							? {
									original_width: original.width,
									original_height: original.height,
									scale: Number((original.width / shown.width).toFixed(3)),
									note,
								}
							: {}),
					},
					null,
					2,
				);
				// #3770: the copy above is downscaled, so give the real pixel geometry.
				const measured = await this.layoutForRead(absolutePath);
				const text = measured ? `${meta}\n${measured}` : meta;
				const withImage = imageAttachmentResult(text, mimeType, shown.base64);
				this.harnessAttachmentResults.add(withImage);
				return withImage;
			}
			const imageInfo = await readImage(absolutePath);
			const measured = await this.layoutForRead(absolutePath);
			const info = JSON.stringify(
				{
					path: imageInfo.path,
					width: imageInfo.width,
					height: imageInfo.height,
					format: imageInfo.format,
					size: imageInfo.size,
					channels: imageInfo.channels,
					hasAlpha: imageInfo.hasAlpha,
					base64Length: imageInfo.base64.length,
					base64Preview: `${imageInfo.base64.slice(0, 100)}...`,
				},
				null,
				2,
			);
			return measured ? `${info}\n${measured}` : info;
		} catch (err) {
			return `Error reading image: ${err}`;
		}
	}

	private async handleDescribeImage(imagePath: string, prompt?: string): Promise<string> {
		// Same guard as read_image, and before the vision router is consulted.
		let absolutePath: string;
		try {
			absolutePath = safePath(imagePath, this.workingDirectory, "read");
		} catch (err) {
			return `Error describing image: ${err instanceof Error ? err.message : String(err)}`;
		}

		try {
			// The vision router picks the model (#3642): whatever vision model is
			// installed locally, never a fixed "llava". describeImage speaks to
			// Ollama only, so a cloud-only result is reported as nothing local,
			// with the router's own install hint.
			const found = await this.resolveVisionModel();
			const local = found.found && found.model?.provider === "ollama" ? found.model : null;
			if (!local) {
				const hint =
					found.error ??
					"No local vision model found. Pull one: `ollama pull qwen2.5vl` or `ollama pull llava`.";
				return `Error describing image: no local vision model is available. ${hint}`;
			}
			const description = await describeImage(
				absolutePath,
				prompt || "Describe this image in detail.",
				local.model,
			);
			return JSON.stringify(
				{
					path: description.path,
					description: description.description,
					width: description.width,
					height: description.height,
					format: description.format,
					model: description.model,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error describing image: ${err}`;
		}
	}

	// ============================================
	// PDF Tool Handlers
	// ============================================

	private async handleReadPdf(pdfPath: string): Promise<string> {
		const absolutePath = path.isAbsolute(pdfPath)
			? pdfPath
			: path.join(this.workingDirectory, pdfPath);

		try {
			const pdfInfo = await readPdf(absolutePath);
			const maxTextLength = 10000;
			const truncatedText =
				pdfInfo.text.length > maxTextLength
					? `${pdfInfo.text.slice(0, maxTextLength)}\n\n... [truncated, ${pdfInfo.text.length - maxTextLength} more chars]`
					: pdfInfo.text;

			return JSON.stringify(
				{
					path: pdfInfo.path,
					pageCount: pdfInfo.pageCount,
					metadata: pdfInfo.metadata,
					textLength: pdfInfo.text.length,
					text: truncatedText,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error reading PDF: ${err}`;
		}
	}

	private async handleReadPdfPage(pdfPath: string, pageNum: number): Promise<string> {
		const absolutePath = path.isAbsolute(pdfPath)
			? pdfPath
			: path.join(this.workingDirectory, pdfPath);

		try {
			const pageContent = await readPdfPage(absolutePath, pageNum);
			return JSON.stringify(
				{
					path: pageContent.path,
					pageNumber: pageContent.pageNumber,
					totalPages: pageContent.totalPages,
					text: pageContent.text,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error reading PDF page: ${err}`;
		}
	}

	private async handleSearchPdf(
		pdfPath: string,
		query: string,
		caseSensitive?: boolean,
	): Promise<string> {
		const absolutePath = path.isAbsolute(pdfPath)
			? pdfPath
			: path.join(this.workingDirectory, pdfPath);

		try {
			const results = await searchPdf(absolutePath, query, caseSensitive ?? false);
			return JSON.stringify(
				{
					path: results.path,
					query: results.query,
					totalMatches: results.totalMatches,
					matches: results.matches.slice(0, 20),
				},
				null,
				2,
			);
		} catch (err) {
			return `Error searching PDF: ${err}`;
		}
	}

	// ============================================
	// Video Tool Handler (VIDEO-INGESTION spec §6)
	// ============================================

	/**
	 * Run the `extract_video` tool. The capability is off by default; the
	 * handler in @8gent/eyes/marlin returns a structured install-required
	 * error when the Marlin sidecar is not provisioned (spec §11).
	 */
	private async handleExtractVideo(
		videoPath: string,
		mode: ExtractVideoMode | undefined,
		query: string | undefined,
		ingest: boolean | undefined,
	): Promise<string> {
		try {
			const result = await extractVideo(
				{ path: videoPath, mode, query, ingest },
				{ cwd: this.workingDirectory },
			);
			return formatExtractVideoResult(result);
		} catch (err) {
			return `Error extracting video: ${err}`;
		}
	}

	// ============================================
	// Notebook Tool Handlers
	// ============================================

	/** Notebook paths: absolute or workspace-relative, but refused by the path guard for this access. */
	private guardedNotebookPath(notebookPath: string, access: PathAccess): string {
		const guard = guardPath(notebookPath, this.workingDirectory, {}, access);
		if (!guard.ok)
			throw new Error(`Path blocked by path-guard: ${guard.reason} ("${notebookPath}")`);
		return path.isAbsolute(notebookPath)
			? notebookPath
			: path.join(this.workingDirectory, notebookPath);
	}

	private async handleReadNotebook(notebookPath: string): Promise<string> {
		try {
			const absolutePath = this.guardedNotebookPath(notebookPath, "read");
			const notebook = await readNotebook(absolutePath);
			const formattedCells = notebook.cells.map((cell) => ({
				index: cell.index,
				type: cell.type,
				executionCount: cell.executionCount,
				source:
					cell.source.length > 500 ? `${cell.source.slice(0, 500)}... [truncated]` : cell.source,
				outputCount: cell.outputs.length,
				outputs: cell.outputs.slice(0, 3).map((o) => ({
					type: o.type,
					text: o.text?.slice(0, 200),
					hasError: !!o.error,
				})),
			}));

			return JSON.stringify(
				{
					path: notebook.path,
					kernel: notebook.kernel,
					language: notebook.language,
					cellCount: notebook.cellCount,
					cells: formattedCells,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error reading notebook: ${err}`;
		}
	}

	private async handleNotebookEditCell(
		notebookPath: string,
		cellIndex: number,
		newSource: string,
	): Promise<string> {
		try {
			const absolutePath = this.guardedNotebookPath(notebookPath, "write");
			const result = await editCell(absolutePath, cellIndex, newSource);
			return JSON.stringify(result, null, 2);
		} catch (err) {
			return `Error editing notebook cell: ${err}`;
		}
	}

	private async handleNotebookInsertCell(
		notebookPath: string,
		afterIndex: number,
		cellType: "code" | "markdown",
		source: string,
	): Promise<string> {
		try {
			const absolutePath = this.guardedNotebookPath(notebookPath, "write");
			const result = await insertCell(absolutePath, afterIndex, cellType, source);
			return JSON.stringify(result, null, 2);
		} catch (err) {
			return `Error inserting notebook cell: ${err}`;
		}
	}

	private async handleNotebookDeleteCell(notebookPath: string, cellIndex: number): Promise<string> {
		try {
			const absolutePath = this.guardedNotebookPath(notebookPath, "write");
			const result = await deleteCell(absolutePath, cellIndex);
			return JSON.stringify(result, null, 2);
		} catch (err) {
			return `Error deleting notebook cell: ${err}`;
		}
	}

	// ============================================
	// Multi-Agent Orchestration
	// ============================================

	// One implementation for both tool paths: packages/orchestration/delegation-tools.ts.
	private handleSpawnAgent(
		task: string,
		runtime?: "8gent" | "claude" | "shell",
		model?: string,
		timeout?: number,
		allowedPaths?: string[],
		permissionMode?: unknown,
	): Promise<string> {
		return spawnAgentTool(
			this.workingDirectory,
			task,
			runtime,
			model,
			timeout,
			allowedPaths,
			permissionMode,
		);
	}

	private handleCheckAgent(agentId: string): Promise<string> {
		return checkAgentTool(agentId);
	}

	private handleListAgents(): Promise<string> {
		return listAgentsTool();
	}

	// ============================================
	// Web Tools
	// ============================================

	private async handleWebSearch(query: string, maxResults?: number): Promise<string> {
		try {
			const results = await webSearch(query, { maxResults: maxResults || 10 });
			return formatSearchResults(results);
		} catch (err) {
			return `Web search failed: ${err}`;
		}
	}

	private async handleWebFetch(url: string): Promise<string> {
		try {
			const result = await webFetch(url);
			return formatFetchResult(result);
		} catch (err) {
			return `Web fetch failed: ${err}`;
		}
	}

	// ============================================
	// MCP Tools
	// ============================================

	private async handleMCPListTools(): Promise<string> {
		try {
			const mcpClient = getMCPClient();
			const tools = mcpClient.listTools();

			if (tools.length === 0) {
				return "No MCP tools available. Configure servers in ~/.8gent/mcp.json";
			}

			const grouped: Record<string, string[]> = {};
			for (const { server, tool } of tools) {
				if (!grouped[server]) grouped[server] = [];
				grouped[server].push(`  - ${tool.name}: ${tool.description || "No description"}`);
			}

			let output = "Available MCP Tools:\n\n";
			for (const [server, toolList] of Object.entries(grouped)) {
				output += `**${server}**\n${toolList.join("\n")}\n\n`;
			}

			return output;
		} catch (err) {
			return `MCP list tools failed: ${err}`;
		}
	}

	private async handleMCPCallTool(
		serverName: string,
		toolName: string,
		args?: Record<string, unknown>,
	): Promise<string> {
		try {
			const mcpClient = getMCPClient();
			const result = await mcpClient.callTool(serverName, toolName, args);
			return formatToolResult(result);
		} catch (err) {
			return `MCP call tool failed: ${err}`;
		}
	}

	// ============================================
	// Background Task Tools
	// ============================================

	private async handleBackgroundStart(command: string, timeout?: number): Promise<string> {
		const systemOne = await systemOneGate(command, systemOneEnvFor(currentPermissionMode()));
		if (!systemOne.run) return systemOne.message as string;
		try {
			const taskManager = getBackgroundTaskManager(this.workingDirectory);
			const taskId = taskManager.startTask(command, { timeout });
			return `Background task started: ${taskId}\nCommand: ${command}\nUse background_status or background_output to check progress.`;
		} catch (err) {
			return `Failed to start background task: ${err}`;
		}
	}

	private async handleBackgroundStatus(taskId: string): Promise<string> {
		try {
			const taskManager = getBackgroundTaskManager();
			const status = taskManager.getTaskStatus(taskId);

			if (!status) {
				return `Task not found: ${taskId}`;
			}

			return formatTaskStatus(status);
		} catch (err) {
			return `Failed to get task status: ${err}`;
		}
	}

	private async handleBackgroundOutput(taskId: string, tail?: number): Promise<string> {
		try {
			const taskManager = getBackgroundTaskManager();
			const status = taskManager.getTaskStatus(taskId);
			const output = taskManager.getTaskOutput(taskId, { tail });

			if (!status || !output) {
				return `Task not found: ${taskId}`;
			}

			return formatTaskOutput(output, status);
		} catch (err) {
			return `Failed to get task output: ${err}`;
		}
	}

	// ============================================
	// Design Tools
	// ============================================

	private async handleSuggestDesign(task: string, projectType?: string): Promise<string> {
		try {
			// Step 1: Detect design needs from the task description
			const detection = await detectDesignNeed(task);

			if (!detection.needsDesign) {
				return JSON.stringify(
					{
						needsDesign: false,
						reason: detection.reason,
						message: "This task doesn't appear to require design decisions.",
					},
					null,
					2,
				);
			}

			// Step 2: Get design system suggestions from the design-agent
			const suggestions = await suggestDesignSystems(detection);

			// Step 3: If a project type is provided, also query the design-systems DB
			let dbSuggestions: any[] = [];
			if (projectType) {
				try {
					initDesignDb();
					dbSuggestions = suggestDesignForProject(projectType, {
						maxResults: 3,
					}).map((s) => ({
						name: s.system.system.name,
						style: s.system.system.style,
						mood: s.system.system.mood,
						score: s.score,
						reasoning: s.reasoning,
						colors: s.system.parsedColors
							? {
									primary: s.system.parsedColors.primary,
									background: s.system.parsedColors.background,
									accent: s.system.parsedColors.accent,
								}
							: null,
						tags: s.system.tags,
					}));
				} catch {
					// DB not seeded yet, skip
				}
			}

			return JSON.stringify(
				{
					needsDesign: true,
					confidence: detection.confidence,
					projectType: detection.projectType,
					categories: detection.suggestedCategories,
					frameworkSuggestions: suggestions.suggestions.map((s) => ({
						id: s.id,
						name: s.name,
						description: s.description,
						reasoning: s.reasoning,
						score: s.score,
						stack: s.stack,
						installCommands: s.installCommands,
						setupSteps: s.setupSteps,
					})),
					designSystemSuggestions: dbSuggestions,
					availableSystems: getAvailableDesignSystems().map((s) => s.name),
				},
				null,
				2,
			);
		} catch (err) {
			return `Design suggestion failed: ${err}`;
		}
	}

	private async handleDeckTheme(args: Record<string, unknown>): Promise<string> {
		try {
			const action = String(args.action);
			const dt = await import("../design-systems/deck-themes.js");
			if (action === "list") return JSON.stringify({ themes: dt.listThemes() }, null, 2);
			if (action !== "apply" && action !== "mix") return `deck_theme: unknown action "${action}"`;
			if (!args.deck) return `deck_theme ${action} needs deck (path to the deck .md)`;
			if (action === "apply" && !args.name) return "deck_theme apply needs name";
			if (action === "mix" && (!args.palette || !args.type)) {
				return "deck_theme mix needs palette and type";
			}
			const deck = dt.resolveDeckPath(
				safePath(String(args.deck), this.workingDirectory, "write"),
				this.workingDirectory,
			);
			const themeName =
				action === "mix" ? `${String(args.palette)}-x-${String(args.type)}` : String(args.name);
			for (const target of [deck, dt.cssPathFor(deck, themeName)]) {
				const blocked = gateWriteTool(
					"primary",
					"write_file",
					{ path: target, content: "" },
					this.workingDirectory,
				);
				if (blocked) return blocked;
			}
			if (action === "apply") {
				return JSON.stringify(dt.applyTheme(deck, String(args.name)), null, 2);
			}
			return JSON.stringify(dt.mixTheme(deck, String(args.palette), String(args.type)), null, 2);
		} catch (err) {
			return `deck_theme failed: ${err instanceof Error ? err.message : err}`;
		}
	}

	private async handleQueryDesignSystem(args: Record<string, unknown>): Promise<string> {
		try {
			initDesignDb();

			const query = args.query as string | undefined;
			const style = args.style as string | undefined;
			const mood = args.mood as string | undefined;
			const output = (args.output as string) || "summary";

			// If a specific query, search for it
			if (query) {
				// Try to get a complete design system by name first
				const complete = getCompleteDesignSystem(query);
				if (complete) {
					if (output === "css") {
						const css = generateCssVariables(complete.system.id);
						return css || "No color palette available for CSS generation.";
					}
					if (output === "tailwind") {
						const config = generateTailwindConfig(complete.system.id);
						return config
							? JSON.stringify(config, null, 2)
							: "No color palette available for Tailwind config.";
					}
					if (output === "hex") {
						const hex = getHexPalette(complete.system.id);
						return hex ? JSON.stringify(hex, null, 2) : "No color palette available.";
					}
					// Default: full summary
					return JSON.stringify(
						{
							name: complete.system.name,
							style: complete.system.style,
							mood: complete.system.mood,
							description: complete.system.description,
							colors: complete.parsedColors,
							typography: complete.parsedTypography,
							components: complete.components.map((c) => ({
								type: c.component_type,
								variant: c.variant,
								description: c.description,
							})),
							tags: complete.tags,
						},
						null,
						2,
					);
				}

				// Fall back to text search
				const results = searchDesignSystems_db(query);
				return JSON.stringify(
					{
						query,
						results: results.map((s) => ({
							id: s.id,
							name: s.name,
							style: s.style,
							mood: s.mood,
							description: s.description,
						})),
					},
					null,
					2,
				);
			}

			// Filter by style
			if (style) {
				const results = findDesignByStyle(style as any);
				return JSON.stringify(
					{
						style,
						results: results.map((s) => ({
							id: s.id,
							name: s.name,
							mood: s.mood,
							description: s.description,
						})),
					},
					null,
					2,
				);
			}

			// Filter by mood
			if (mood) {
				const results = findDesignByMood(mood as any);
				return JSON.stringify(
					{
						mood,
						results: results.map((s) => ({
							id: s.id,
							name: s.name,
							style: s.style,
							description: s.description,
						})),
					},
					null,
					2,
				);
			}

			// No filters — list all with available styles/moods
			const all = listAllDesignSystems();
			return JSON.stringify(
				{
					totalSystems: all.length,
					availableStyles: listDesignStyles(),
					availableMoods: listDesignMoods(),
					systems: all.map((s) => ({
						id: s.id,
						name: s.name,
						style: s.style,
						mood: s.mood,
					})),
				},
				null,
				2,
			);
		} catch (err) {
			return `Design system query failed: ${err}`;
		}
	}

	// ============================================
	// Infinite Mode
	// ============================================

	private async handleEnableInfiniteMode(
		task: string,
		maxIterations?: number,
		maxTimeMs?: number,
	): Promise<string> {
		try {
			const runner = createInfiniteRunner(task, {
				maxIterations: maxIterations ?? 100,
				maxTimeMs: maxTimeMs ?? 30 * 60 * 1000,
				workingDirectory: this.workingDirectory,
				onIteration: (state) => {
					console.log(`[infinite] ${formatInfiniteState(state)}`);
				},
				onErrorRecovered: (error, state) => {
					console.log(`[infinite] Recovered from: ${error.message.slice(0, 80)}`);
				},
			});

			// Run in background — don't block the tool call
			runner
				.run()
				.then((finalState) => {
					console.log(
						`[infinite] Completed: ${finalState.phase} after ${finalState.iteration} iterations`,
					);
				})
				.catch((err) => {
					console.log(`[infinite] Fatal error: ${err}`);
				});

			return `Infinite mode ENABLED for task: "${task}"\nMax iterations: ${maxIterations ?? 100}\nMax time: ${((maxTimeMs ?? 30 * 60 * 1000) / 1000 / 60).toFixed(0)} minutes\nThe agent will now loop autonomously until the task is complete or limits are reached.`;
		} catch (err) {
			return `Failed to enable infinite mode: ${err}`;
		}
	}

	// ============================================
	// Memory Tools
	// ============================================

	private async handleRemember(
		fact: string,
		layer: "session" | "project" | "global",
	): Promise<string> {
		try {
			const memory = getMemoryManager(this.workingDirectory);
			const id = await memory.remember(fact, layer, { source: "user:remember" });
			const stats = await memory.getStats();
			return `Remembered (${layer}): "${fact.slice(0, 80)}${fact.length > 80 ? "..." : ""}"\nID: ${id}\nMemory stats: session: ${stats.session}, project: ${stats.project}, global: ${stats.global}`;
		} catch (err) {
			return `Failed to remember: ${err}`;
		}
	}

	private async handleRecall(query: string, limit?: number): Promise<string> {
		try {
			const memory = getMemoryManager(this.workingDirectory);
			const results = await memory.recall(query, limit ?? 10);

			if (results.length === 0) {
				return `No memories found matching "${query}".`;
			}

			const lines = results.map((r, i) => {
				const age = timeSince(new Date(r.entry.createdAt));
				return `${i + 1}. [${r.entry.layer}] (score: ${r.score.toFixed(2)}, ${age} ago) ${r.entry.fact}`;
			});

			return `Found ${results.length} memor${results.length === 1 ? "y" : "ies"} matching "${query}":\n${lines.join("\n")}`;
		} catch (err) {
			return `Failed to recall: ${err}`;
		}
	}

	// ============================================
	// Desktop Computer Use Tools (Power #10)
	// ============================================

	private async handleDesktopScreenshot(savePath?: string, displayId?: number): Promise<string> {
		try {
			const result = computerScreenshot({ path: savePath, displayId });
			if (!result.ok) return `desktop_screenshot failed: ${result.error}`;
			return JSON.stringify({
				path: result.path,
				coordMap: `${result.coordMap.captureX},${result.coordMap.captureY},${result.coordMap.captureWidth},${result.coordMap.captureHeight},${result.coordMap.imageWidth},${result.coordMap.imageHeight}`,
				hint: "Use the coordMap value with desktop_click/desktop_hover to translate image coordinates to screen coordinates.",
			});
		} catch (err) {
			return `desktop_screenshot failed: ${err}`;
		}
	}

	private async handleDesktopClick(
		x: number,
		y: number,
		button?: string,
		count?: number,
		coordMap?: string,
	): Promise<string> {
		try {
			let point = { x, y };
			if (coordMap) {
				point = imageToDesktop(point, decodeCoordMap(coordMap));
			}
			const result = computerClick({
				point,
				button: (button as "left" | "right" | "middle") || "left",
				count,
			});
			if (!result.ok) return `desktop_click failed: ${result.error}`;
			return `Clicked at (${point.x}, ${point.y})${button ? ` with ${button} button` : ""}${count && count > 1 ? ` x${count}` : ""}`;
		} catch (err) {
			return `desktop_click failed: ${err}`;
		}
	}

	private async handleDesktopType(text: string, delay?: number): Promise<string> {
		try {
			const result = computerType({ text, delay });
			if (!result.ok) return `desktop_type failed: ${result.error}`;
			return `Typed ${text.length} characters`;
		} catch (err) {
			return `desktop_type failed: ${err}`;
		}
	}

	private async handleDesktopPress(keys: string, count?: number, delay?: number): Promise<string> {
		try {
			const result = computerPress({ keys, count, delay });
			if (!result.ok) return `desktop_press failed: ${result.error}`;
			const warning = result.error ? ` (${result.error})` : "";
			return `Pressed ${keys}${count && count > 1 ? ` x${count}` : ""}${warning}`;
		} catch (err) {
			return `desktop_press failed: ${err}`;
		}
	}

	private async handleDesktopScroll(
		direction: string,
		amount?: number,
		x?: number,
		y?: number,
	): Promise<string> {
		try {
			const result = computerScroll({
				direction: direction as "up" | "down" | "left" | "right",
				amount,
				point: x !== undefined && y !== undefined ? { x, y } : undefined,
			});
			if (!result.ok) return `desktop_scroll failed: ${result.error}`;
			return `Scrolled ${direction}${amount ? ` x${amount}` : ""}`;
		} catch (err) {
			return `desktop_scroll failed: ${err}`;
		}
	}

	private async handleDesktopDrag(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		button?: string,
		duration?: number,
	): Promise<string> {
		try {
			const result = computerDrag({
				from: { x: fromX, y: fromY },
				to: { x: toX, y: toY },
				button: (button as "left" | "right" | "middle") || "left",
				duration,
			});
			if (!result.ok) return `desktop_drag failed: ${result.error}`;
			return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
		} catch (err) {
			return `desktop_drag failed: ${err}`;
		}
	}

	private async handleDesktopHover(x: number, y: number, coordMap?: string): Promise<string> {
		try {
			let point = { x, y };
			if (coordMap) {
				point = imageToDesktop(point, decodeCoordMap(coordMap));
			}
			const result = computerHover(point);
			if (!result.ok) return `desktop_hover failed: ${result.error}`;
			return `Moved cursor to (${point.x}, ${point.y})`;
		} catch (err) {
			return `desktop_hover failed: ${err}`;
		}
	}

	private async handleDesktopWindows(): Promise<string> {
		try {
			const result = computerWindowList();
			if (!result.ok) return `desktop_windows failed: ${result.error}`;
			if (!result.windows || result.windows.length === 0) return "No windows found";
			const lines = result.windows.map(
				(w, i) => `${i + 1}. [${w.app}] "${w.title}" at (${w.x},${w.y}) ${w.width}x${w.height}`,
			);
			return `Open windows (${result.windows.length}):\n${lines.join("\n")}`;
		} catch (err) {
			return `desktop_windows failed: ${err}`;
		}
	}

	private async handleDesktopClipboard(action: string, text?: string): Promise<string> {
		try {
			if (action === "set") {
				if (!text) return "desktop_clipboard set requires text parameter";
				const result = computerClipboardSet(text);
				if (!result.ok) return `desktop_clipboard failed: ${result.error}`;
				return `Clipboard set (${text.length} chars)`;
			}
			const result = computerClipboardGet();
			if (!result.ok) return `desktop_clipboard failed: ${result.error}`;
			return `Clipboard contents:\n${result.text || "(empty)"}`;
		} catch (err) {
			return `desktop_clipboard failed: ${err}`;
		}
	}

	// ============================================
	// Process Management Tools
	// ============================================

	private async handleDesktopProcesses(sort?: string): Promise<string> {
		try {
			const processes = computerListProcesses((sort as "memory" | "cpu" | "name") || "memory");
			if (processes.length === 0) return "No processes found";
			const lines = processes.map(
				(p, i) =>
					`${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} ${String(p.memoryMB).padStart(6)} MB  ${String(p.cpu ?? 0).padStart(5)}% CPU  (PID ${p.pid})`,
			);
			return `Running processes (top ${processes.length}, sorted by ${sort || "memory"}):\n${lines.join("\n")}`;
		} catch (err) {
			return `desktop_processes failed: ${err}`;
		}
	}

	/**
	 * desktop_act: ground the target with the local grounder, ask, act, verify.
	 * The outer gate admitted only the read half (act_resolve); the act is
	 * gated here as click / type / press, so a block stays a block and a
	 * require_approval rule reaches the person with the point on the card.
	 * EIGHT_DESKTOP_ACT_DRY=<png> runs the whole flow against a saved frame
	 * and records the act instead of executing it.
	 */
	private async handleDesktopAct(args: Record<string, unknown>): Promise<string> {
		const parsed = validateDesktopActArgs(args);
		if (typeof parsed === "string") return parsed;
		const dry = process.env.EIGHT_DESKTOP_ACT_DRY;
		const { ground } = await import("../eyes/ground");
		const result = await desktopAct(
			parsed,
			{
				dryRun: !!dry,
				preflight: () => desktopPreflight(),
				screenshot: () => {
					if (dry) {
						return {
							ok: true,
							path: dry,
							coordMap: {
								captureX: 0,
								captureY: 0,
								captureWidth: 0,
								captureHeight: 0,
								imageWidth: 0,
								imageHeight: 0,
							},
						};
					}
					return computerScreenshot({});
				},
				ground: (image, instruction) => ground({ image, instruction }),
				policy: (ctx) =>
					this.toolG8.gate(this.agentId, DESKTOP_POLICY_ACTION as PolicyActionType, ctx),
				// Every act reaches the person; the card carries the exact text and
				// the crop, the log carries neither (desktop-approval.ts).
				approve: (req, reason) =>
					this.askDesktopApproval("desktop_act", {}, reason, {
						card: desktopApprovalCard(req, reason),
						details: desktopApprovalDetails(req, reason),
					}),
				click: (point, button, count) => computerClick({ point, button, count }),
				type: (text) => computerType({ text }),
				press: (keys) => computerPress({ keys }),
				screenScale: () => (dry ? 1 : detectScreenScale()),
			},
			this.desktopActSession,
		);
		return JSON.stringify(result);
	}

	/**
	 * A desktop action the policy says needs the person (#3213). Returns null
	 * when they approved, or the refusal to hand back to the model. With no
	 * person to ask (headless, no approval card) it refuses: desktop control
	 * never runs unattended on a require_approval rule.
	 */
	private async askDesktopApproval(
		toolName: string,
		args: Record<string, unknown>,
		reason: string | undefined,
		card?: { card: string; details: string },
	): Promise<string | null> {
		const browser = toolName.startsWith("browser_");
		// Infinite lifts the browser card only. Desktop control reaches every
		// app the person has open, so it asks in every mode, Infinite included.
		if (browser && this.permissionManager.isInfiniteMode()) return null;
		const why = reason ?? "This desktop action needs your approval.";
		// What may be logged: never typed text (8SO). The card is separate.
		const details =
			card?.details ??
			`${why} Tool: ${toolName} ${JSON.stringify(browser ? redactBrowserArgs(args) : redactDesktopArgs(args))}`;
		const shown = card?.card ?? `${toolName}: ${details}`;
		let approved: boolean;
		if (hasTuiApprovalHandler()) {
			// `full`: the card is laid out whole or answered "unfit", never cut.
			approved =
				(await requestTuiApproval(
					browser
						? { action: "Browser control", details }
						: { action: "Desktop control", details, command: shown, full: true },
				)) === true;
		} else if (process.stdin.isTTY && !process.env.EIGHT_HEADLESS) {
			approved = browser
				? await this.permissionManager.requestPermission("Browser control", details)
				: await askOnTerminal(shown);
		} else {
			return `[BLOCKED] ${toolName} needs the person's approval and there is no one to ask in this session. Nothing was done. Do not retry this call.`;
		}
		if (!approved) {
			return `[PERMISSION DENIED] The person declined ${toolName}. Nothing was done. Do not retry this call.`;
		}
		return null;
	}

	private async handleDesktopQuitApp(
		name?: string,
		pid?: number,
		strategy?: string,
	): Promise<string> {
		try {
			if (!name && !pid) return "desktop_quit_app requires either 'name' or 'pid' parameter";
			const strat = (strategy as "graceful" | "force") || "graceful";

			if (pid) {
				const result = computerQuitProcess(pid, strat);
				if (!result.ok) return `desktop_quit_app failed: ${result.error}`;
				return `Quit PID ${pid} (${strat})`;
			}
			const result = computerQuitByName(name!, strat);
			if (!result.ok) return `desktop_quit_app failed: ${result.error}`;
			return `Quit "${name}" (${strat})`;
		} catch (err) {
			return `desktop_quit_app failed: ${err}`;
		}
	}

	private async handleDesktopSuggestQuit(): Promise<string> {
		try {
			const { apps, safeList, memSummary } = computerSuggestQuittable();
			const memLine = `Memory: ${memSummary.usedMB}/${memSummary.totalMB} MB (${memSummary.usedPercent}% used, ${memSummary.freeMB} MB free)`;

			if (apps.length === 0) {
				return `${memLine}\nNo quittable apps found - everything is either system-critical or on the safe list.`;
			}

			const lines = apps
				.slice(0, 15)
				.map(
					(p, i) =>
						`${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} ${String(p.memoryMB).padStart(6)} MB  (PID ${p.pid})`,
				);

			const totalFreeable = apps.slice(0, 15).reduce((sum, p) => sum + p.memoryMB, 0);
			const safeNote = safeList.length > 0 ? `\nSafe list (protected): ${safeList.join(", ")}` : "";

			return `${memLine}\n\nApps that could be quit to free resources:\n${lines.join("\n")}\n\nPotential savings: ~${totalFreeable} MB${safeNote}\n\nUse desktop_quit_app to quit specific apps (requires confirmation).`;
		} catch (err) {
			return `desktop_suggest_quit failed: ${err}`;
		}
	}

	private async handleDesktopSafeList(action: string, app?: string): Promise<string> {
		try {
			if (action === "list") {
				const list = computerLoadSafeList();
				if (list.length === 0)
					return "Safe list is empty. Add apps with action='add' to protect them from being quit.";
				return `Safe list (${list.length} apps protected):\n${list.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
			}
			if (action === "add") {
				if (!app) return "desktop_safe_list add requires 'app' parameter";
				return computerAddToSafeList(app);
			}
			if (action === "remove") {
				if (!app) return "desktop_safe_list remove requires 'app' parameter";
				return computerRemoveFromSafeList(app);
			}
			return `Unknown safe list action: ${action}. Use 'list', 'add', or 'remove'.`;
		} catch (err) {
			return `desktop_safe_list failed: ${err}`;
		}
	}

	// ============================================
	// Browser Use Tools
	// ============================================

	private async handleBrowserOpen(
		url: string,
		browser?: string,
		session?: string,
	): Promise<string> {
		try {
			if (!useBrowserUse()) return await getEightBrowser(this.workingDirectory).open(url);
			return browserOpen(url, { browser, session });
		} catch (err) {
			return `browser_open failed: ${err}`;
		}
	}

	private async handleBrowserState(session?: string): Promise<string> {
		try {
			if (!useBrowserUse()) return await getEightBrowser(this.workingDirectory).state(session);
			return browserState(session);
		} catch (err) {
			return `browser_state failed: ${err}`;
		}
	}

	private async handleBrowserTask(
		actions: unknown,
		task: string | undefined,
		browser?: string,
		session?: string,
	): Promise<string> {
		try {
			if (!useBrowserUse()) {
				if (typeof actions === "string") actions = JSON.parse(actions); // small models send the list as a string
				if (!Array.isArray(actions))
					return "browser_task failed: 8gent Browser needs an actions list (natural-language tasks run only on the opt-in browser-use fallback)";
				// A sensitive click (sign in, buy, delete, send...) gets its own card, even inside an approved task.
				const where = isolatedBrowser()
					? "the bot's own browser profile"
					: "your logged-in browser";
				const approve = async (what: string) =>
					(await this.askDesktopApproval(
						"browser_task",
						{ click: what },
						`This click looks sensitive in ${where}.`,
					)) === null;
				return await getEightBrowser(this.workingDirectory).run(actions, session, approve);
			}
			return browserTask(task ?? "", { browser, session });
		} catch (err) {
			return `browser_task failed: ${err}`;
		}
	}

	private async handleBrowserScreenshot(filePath?: string, session?: string): Promise<string> {
		try {
			if (!useBrowserUse()) {
				let out: string | undefined;
				if (filePath) {
					if (!filePath.toLowerCase().endsWith(".png"))
						return "browser_screenshot failed: path must end in .png";
					const shots = path.join(os.homedir(), ".8gent", "browser-shots");
					const abs = path.resolve(this.workingDirectory, filePath);
					// A named profile's dir is protected from the agent (#3622), so its shots go to the workspace.
					out =
						abs.startsWith(shots + path.sep) && !isolatedBrowser()
							? abs
							: safePath(filePath, this.workingDirectory, "write");
				} else if (isolatedBrowser()) {
					out = safePath(`browser-shot-${Date.now()}.png`, this.workingDirectory, "write");
				}
				return await getEightBrowser(this.workingDirectory).screenshot(out, session);
			}
			return browserScreenshot(filePath, session);
		} catch (err) {
			return `browser_screenshot failed: ${err}`;
		}
	}

	private async handleRunComputerTask(goal: string, maxSteps?: number): Promise<string> {
		if (!goal?.trim()) return "run_computer_task: goal is required";
		const steps = Math.min(50, Math.max(1, maxSteps ?? 20));
		try {
			const { runComputerUseLoop } = await import("./loops/computer-use");
			const { ModelFailover } = await import("../providers/failover");
			const { loadVisionConfig } = await import("./vision-router");
			const { existsSync } = await import("node:fs");
			const { homedir } = await import("node:os");
			const { join } = await import("node:path");
			const { executeHandsTool } = await import("../daemon/tools/hands");

			const visionCfg = loadVisionConfig();
			const { resolveComputerUseModel } = await import("./vision-router");
			const { model: pinnedModel, autoSelected } = await resolveComputerUseModel(
				visionCfg.computerUseModel,
				{ openRouterApiKey: process.env.OPENROUTER_API_KEY },
			);
			if (autoSelected) {
				console.log(
					`[cua] auto-selected vision model: ${pinnedModel} (${visionCfg.computerUseModel} is not vision-capable)`,
				);
			}
			const failover = new ModelFailover();

			// Skip providers that lack credentials or aren't installed.
			if (!process.env.DEEPSEEK_API_KEY) failover.markDown("deepseek-flash", "deepseek");
			if (!process.env.OPENROUTER_API_KEY)
				failover.markDown("meta-llama/llama-3-8b-instruct:free", "openrouter");
			if (!existsSync(join(homedir(), ".8gent", "bin", "apple-foundation-bridge"))) {
				failover.markDown("apple-foundationmodel", "apfel");
			}

			// Instant AX tree placeholder — lets the model ask for desktop_windows itself.
			const handsAdapter: import("./loops/computer-use").HandsAdapter = async (
				toolName,
				args,
				ctx,
			) => {
				if (toolName === "desktop_accessibility_tree") {
					return {
						ok: true as const,
						result: {
							pid: 0,
							appName: "desktop",
							windowTitle: "AX tree unavailable - call desktop_windows to list open windows",
							root: {
								role: "AXDesktop",
								title: "Call desktop_windows to enumerate open windows.",
								children: [],
							},
						},
					};
				}
				const r = await executeHandsTool(toolName, args, ctx);
				if (r.ok) return { ok: true as const, result: r.result };
				return { ok: false as const, reason: (r as any).error ?? "hands error" };
			};

			// Agent callers can't answer interactive y/N prompts.
			// Auto-approve all desktop actions except quitting apps.
			const agentApprove: import("../daemon/tools/hands").HandsToolCtx["approve"] = async ({
				tool,
			}) => tool !== "desktop_quit_app";

			const result = await runComputerUseLoop({
				goal: goal.trim(),
				maxSteps: steps,
				sessionId: `tools-cua-${Date.now()}`,
				pinnedModel,
				failover,
				handsAdapter,
				approve: agentApprove,
			});

			const summary = [
				`outcome: ${result.reason}`,
				`steps: ${result.steps.length}/${steps}`,
				result.finalMessage ?? "",
			]
				.filter(Boolean)
				.join("\n");
			return result.ok
				? `Computer task complete.\n${summary}`
				: `Computer task failed.\n${summary}`;
		} catch (err) {
			return `run_computer_task error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
}

function timeSince(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
