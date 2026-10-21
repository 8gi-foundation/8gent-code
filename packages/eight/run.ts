/**
 * 8gent Code - `run` Subcommand (one-shot agent runner)
 *
 * Entry point for Orchestra, cmux, and other terminal hosts that want to
 * spawn 8gent as a headless agent via:
 *
 *   8gent run --yes --output-format stream-json "<prompt>"
 *
 * Emits NDJSON events to stdout (one JSON object per line) when
 * `--output-format stream-json` is set. Otherwise, falls back to plain
 * text output of the final assistant message.
 *
 * Event shape is a best-effort match for the Claude Code stream-json
 * format: a `{type, subtype, ...}` discriminated union with `session_start`,
 * `assistant`, `tool_use`, `tool_result`, and `result` types. The terminator
 * uses `type: "result"` (plus a `session_id` field on both `session_start`
 * and `result`) so PTY-mode host parsers like Orchestra's
 * `apps/backend/internal/agents/command_runner.go` detectBlockingEvent
 * (lines 537-606) recognise completion. If an external harness disagrees
 * with this shape, the chosen shape is logged to stderr so the downstream
 * parser can be adjusted without a round-trip to the agent loop.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { isEmptyReplyNote } from "../ai/text-tool-loop";
import { readableModelName } from "../providers/model-reroute";
import type { TurnStop } from "./agent";
import type { RunEvent, RunStopInfo } from "./run-events";
import { type RunSessionStore, defaultRunSessionStore } from "./run-session";
import { scrub } from "./secret-scanner";
import type { AgentEventCallbacks } from "./types";

export type { RunEvent } from "./run-events";

export interface RunOptions {
	prompt: string;
	yes: boolean;
	outputFormat: "text" | "stream-json";
	provider?: string;
	model?: string;
	cwd?: string;
	maxTurns?: number;
	/** An image file to attach to the prompt (#3641); one per run. */
	image?: string;
	/**
	 * Set EIGHT_WORKSPACE_ROOT to the run's working directory (#3747). On by
	 * default; `--no-workspace-boundary` stops run mode setting it.
	 */
	workspaceBoundary: boolean;
	/** `-p` / `--print`: the one-shot front door; also reads piped stdin. */
	print: boolean;
	/** `--tools a,b`: only these tools for the run (F5). */
	tools?: string[];
	/** `--continue`: resume the latest session of this folder (F4). */
	continueLatest: boolean;
	/** `--session <id>`: resume that session. */
	session?: string;
	/** `--no-session`: save nothing. */
	noSession: boolean;
	/** `--session-dir <dir>`: where sessions are read and written. */
	sessionDir?: string;
}

/**
 * Parse argv for the `run` subcommand. `argv` here is everything after
 * the `run` token itself.
 *
 * Supported:
 *   --yes
 *   --output-format <fmt>        or --output-format=<fmt>
 *   --provider <name>            or --provider=<name>
 *   --model <name>               or --model=<name>
 *   --cwd <dir>                  or --cwd=<dir>
 *   --max-turns <n>              or --max-turns=<n>
 *   --image <path>               or --image=<path>   (png, jpg, gif, webp; max 20 MB;
 *                                downscaled to fit 2560x2560; inside the working directory)
 *   --no-workspace-boundary      do not set the workspace root (EIGHT_WORKSPACE_ROOT) for this run
 *                                (by default run mode sets it to the working directory; native
 *                                write_file and edit_file stay confined to the working directory either way)
 *   <prompt tokens...>           everything positional, joined with spaces
 *
 * --image limits (v1, #3641): one image per run; it reaches the model only
 * on the local text-tool path (ollama, lmstudio, llama-server) when the
 * model can see, otherwise a side vision model describes it (local first;
 * with OPENROUTER_API_KEY set, the VisionInterpreter may use a hosted vision
 * model for that description, as in the TUI); the native AI SDK path (cloud
 * providers) is unchanged; Ollama's raw ChatML recovery path sends text
 * only; files over 20 MB are refused and the image is downscaled to fit
 * 2560x2560 before it leaves the process.
 */
export function parseRunArgs(argv: string[]): RunOptions {
	let yes = false;
	let outputFormat: "text" | "stream-json" = "text";
	let provider: string | undefined;
	let model: string | undefined;
	let cwd: string | undefined;
	let maxTurns: number | undefined;
	let image: string | undefined;
	let workspaceBoundary = true;
	let print = false;
	let tools: string[] | undefined;
	let continueLatest = false;
	let session: string | undefined;
	let noSession = false;
	let sessionDir: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--yes" || a === "-y") {
			yes = true;
			continue;
		}
		// --output-format <fmt> or --output-format=<fmt>
		if (a === "--output-format") {
			const next = argv[i + 1];
			if (next) {
				outputFormat = next === "stream-json" ? "stream-json" : "text";
				i++;
			}
			continue;
		}
		if (a.startsWith("--output-format=")) {
			const v = a.slice("--output-format=".length);
			outputFormat = v === "stream-json" ? "stream-json" : "text";
			continue;
		}
		if (a === "--provider") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				provider = next;
				i++;
			}
			continue;
		}
		if (a.startsWith("--provider=")) {
			provider = a.slice("--provider=".length);
			continue;
		}
		if (a === "--model") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				model = next;
				i++;
			}
			continue;
		}
		if (a.startsWith("--model=")) {
			model = a.slice("--model=".length);
			continue;
		}
		if (a === "--cwd") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				cwd = next;
				i++;
			}
			continue;
		}
		if (a.startsWith("--cwd=")) {
			cwd = a.slice("--cwd=".length);
			continue;
		}
		if (a === "--max-turns") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				maxTurns = Number.parseInt(next, 10);
				i++;
			}
			continue;
		}
		if (a.startsWith("--max-turns=")) {
			maxTurns = Number.parseInt(a.slice("--max-turns=".length), 10);
			continue;
		}
		if (a === "--image") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				image = next;
				i++;
			}
			continue;
		}
		if (a.startsWith("--image=")) {
			image = a.slice("--image=".length);
			continue;
		}
		if (a === "--no-workspace-boundary") {
			workspaceBoundary = false;
			continue;
		}
		if (a === "-p" || a === "--print") {
			print = true;
			continue;
		}
		// --mode json|text (rpc is routed before this parser, in bin/8gent.ts)
		if (a === "--mode" || a.startsWith("--mode=")) {
			const v = a === "--mode" ? argv[++i] : a.slice("--mode=".length);
			if (v === "json") outputFormat = "stream-json";
			else if (v === "text") outputFormat = "text";
			continue;
		}
		if (a === "--tools" || a.startsWith("--tools=")) {
			const v = a === "--tools" ? argv[++i] : a.slice("--tools=".length);
			tools = (v ?? "")
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			continue;
		}
		if (a === "--continue" || a === "-c") {
			continueLatest = true;
			continue;
		}
		if (a === "--no-session") {
			noSession = true;
			continue;
		}
		if (a === "--session" || a.startsWith("--session=")) {
			const v = a === "--session" ? argv[++i] : a.slice("--session=".length);
			if (v) session = v;
			continue;
		}
		if (a === "--session-dir" || a.startsWith("--session-dir=")) {
			const v = a === "--session-dir" ? argv[++i] : a.slice("--session-dir=".length);
			if (v) sessionDir = v;
			continue;
		}
		// Any other flag is ignored silently so Orchestra can pass extras
		if (a.startsWith("-")) continue;
		positional.push(a);
	}

	return {
		prompt: positional.join(" ").trim(),
		yes,
		outputFormat,
		provider,
		model,
		cwd,
		maxTurns,
		image,
		workspaceBoundary,
		print,
		tools,
		continueLatest,
		session,
		noSession,
		sessionDir,
	};
}

/**
 * Which headless surface a command line asks for, when it leads with flags
 * (not a subcommand): `-p`/`--print` (anywhere on the line) and `--mode json|text` run one prompt,
 * `--mode rpc` (like `--rpc`) is the JSON-RPC server (F1).
 */
const SUBCOMMANDS = new Set([
	"init",
	"outline",
	"symbol",
	"search",
	"benchmark",
	"demo",
	"tui",
	"run",
	"pipeline",
	"pet",
	"infinite",
	"chat",
	"agent",
	"session",
	"export",
	"preferences",
	"memory",
	"airdrop",
	"drop",
	"onboard",
	"auth",
	"cron",
	"blueprint",
	"daemon",
	"rpc",
	"mcp-server",
	"review",
	"doctor",
	"update",
	"upgrade",
	"permissions",
	"perms",
	"keys",
	"env",
	"install",
	"publish",
	"start",
	"open",
	"stop",
	"kill",
	"restart",
	"build",
	"log",
	"logs",
	"login",
	"logout",
	"whoami",
	"status",
]);

export function headlessRoute(args: string[]): "run" | "rpc" | null {
	if (args.length === 0) return null;
	// -p / --print is the front door wherever it sits (`8gent "review" -p` too).
	if (args.includes("-p") || args.includes("--print")) return "run";
	if (!args[0].startsWith("-") && SUBCOMMANDS.has(args[0])) return null;
	const modeIdx = args.findIndex((a) => a === "--mode" || a.startsWith("--mode="));
	if (modeIdx !== -1) {
		const v =
			args[modeIdx] === "--mode" ? args[modeIdx + 1] : args[modeIdx].slice("--mode=".length);
		if (v === "rpc") return "rpc";
		if (v === "json" || v === "text") return "run";
	}
	return null;
}

/**
 * `--continue` with no session id means "the latest session of this folder".
 * With an id (a following token that is not a flag) it is the old form and
 * names a session. Returns null when `--continue` is absent.
 */
export function continueTarget(args: string[]): { id?: string; rest: string[] } | null {
	const i = args.findIndex((a) => a === "--continue" || a === "-c");
	if (i === -1) return null;
	const next = args[i + 1];
	if (next && !next.startsWith("-")) {
		return { id: next, rest: args.filter((_, j) => j !== i && j !== i + 1) };
	}
	return { rest: args.filter((_, j) => j !== i) };
}

/**
 * Read piped stdin when there is one and put it ahead of the prompt, so
 * `git diff | 8gent -p "review"` sends the diff plus the instruction (F2).
 * Only `-p` runs, and runs with no prompt, read stdin: a plain `run` from a
 * host that leaves an open pipe on stdin must not hang.
 */
export function combinePromptAndStdin(prompt: string, piped: string): string {
	const body = piped.trim();
	if (!body) return prompt;
	return prompt ? `${body}\n\n${prompt}` : body;
}

/** Names in `tools` that no tool answers to. */
export async function unknownToolNames(tools: string[]): Promise<string[]> {
	const known = new Set<string>();
	try {
		const { agentTools } = await import("../ai/tools");
		for (const k of Object.keys(agentTools)) known.add(k);
		const { ToolExecutor } = await import("./tools");
		const os = await import("node:os");
		for (const d of new ToolExecutor(os.tmpdir()).getToolDefinitions() as Array<{
			function?: { name?: unknown };
		}>)
			if (typeof d.function?.name === "string") known.add(d.function.name);
	} catch {
		return [];
	}
	return tools.filter((t) => !known.has(t));
}

/** Largest piped stdin read (8 MB). */
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

export class StdinTooLargeError extends Error {
	constructor(readonly bytes: number) {
		super(
			`Error: piped input is larger than ${MAX_STDIN_BYTES / (1024 * 1024)} MB (read ${(bytes / (1024 * 1024)).toFixed(1)} MB so far). Trim it, for example git diff -- <path>.`,
		);
	}
}

/**
 * Piped stdin, capped at 8 MB. With a prompt on the command line the read is
 * skipped unless stdin is a pipe or a file, so a host that leaves an open
 * socket or terminal on stdin cannot hang the run. Without a prompt, or with
 * a pipe, it reads to the end: `8gent -p "x" < /dev/null` is fine, but a
 * pipe whose writer never closes will wait.
 */
export async function readPipedStdin(hasPrompt = false): Promise<string> {
	if (process.stdin.isTTY) return "";
	if (hasPrompt) {
		try {
			const st = (await import("node:fs")).fstatSync(0);
			if (!st.isFIFO() && !st.isFile()) return "";
		} catch {
			return "";
		}
	}
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const c of process.stdin) {
			const b = Buffer.from(c);
			total += b.length;
			if (total > MAX_STDIN_BYTES) throw new StdinTooLargeError(total);
			chunks.push(b);
		}
	} catch (err) {
		if (err instanceof StdinTooLargeError) throw err;
		return "";
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/**
 * The workspace root a run sets (#3747): its working directory, as
 * EIGHT_WORKSPACE_ROOT, which the policy engine's workspace boundary reads
 * for the actions it evaluates. It does not by itself confine every tool:
 * native read_file (#3759) is not covered by this change. Native run_command
 * and the notebook write tools take the same policy decision and safePath
 * confinement as the text-tool path (#3760). A root already in the environment is kept.
 * Undefined means set nothing: the root is already set, or the run opted out.
 */
export function runWorkspaceRoot(
	opts: Pick<RunOptions, "cwd" | "workspaceBoundary">,
	env: Record<string, string | undefined> = process.env,
	cwd: string = process.cwd(),
): string | undefined {
	if (!opts.workspaceBoundary) return undefined;
	if (env.EIGHT_WORKSPACE_ROOT) return undefined;
	return resolvePath(cwd, opts.cwd || ".");
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Largest --image file accepted, before decoding (#3641). */
export const MAX_RUN_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * The `--image` file as the agent takes it: base64 plus its media type (#3641).
 * A missing file, an unsupported extension or a file over MAX_RUN_IMAGE_BYTES
 * is a usage error, reported the way a missing prompt is, before any model is
 * contacted. The image is downscaled to fit 2560x2560 exactly as read_image
 * does (imageMaxSide: 2560 local and hosted), so what reaches the model is
 * bounded the same way on both paths; sharp's own pixel limit bounds the decode.
 * `original` is the file's own size, so a downscaled copy can be explained (#4293).
 */
export type RunImage = {
	base64: string;
	mimeType: string;
	original?: { width: number; height: number };
};

export async function loadRunImage(
	file: string,
	cwd: string,
	provider?: string,
): Promise<RunImage | { error: string }> {
	const path = await import("node:path");
	const fs = await import("node:fs");
	// Same containment as every file tool: inside the working directory, no
	// credential or device paths, no symlink escape. Refused before any read.
	let absolute: string;
	try {
		const { safePath } = await import("./tools");
		absolute = safePath(file, cwd, "read");
	} catch (err) {
		return {
			error: `Error: --image must be inside the working directory: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!IMAGE_MIME_TYPES[path.extname(absolute).toLowerCase()]) {
		return {
			error: `Error: --image must be a png, jpg, gif or webp file, got "${file}".`,
		};
	}
	if (!fs.existsSync(absolute)) {
		return { error: `Error: --image file not found: ${absolute}` };
	}
	const size = fs.statSync(absolute).size;
	if (size > MAX_RUN_IMAGE_BYTES) {
		return {
			error: `Error: --image file is too large (${(size / (1024 * 1024)).toFixed(1)} MB, limit ${MAX_RUN_IMAGE_BYTES / (1024 * 1024)} MB): ${absolute}`,
		};
	}
	try {
		const { resizeImage } = await import("../tools/image");
		const { isLocalProvider } = await import("./registry");
		const { imageMaxSide } = await import("./image-fit");
		const side = imageMaxSide(provider ? isLocalProvider(provider) : true);
		const shown = await resizeImage(absolute, side, side);
		const format = shown.format === "jpg" ? "jpeg" : shown.format;
		return {
			base64: shown.base64,
			mimeType: `image/${format}`,
			original: {
				width: shown.originalWidth ?? shown.width,
				height: shown.originalHeight ?? shown.height,
			},
		};
	} catch (err) {
		return {
			error: `Error: --image could not be decoded as an image: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Emit a single NDJSON event to stdout. Keep stdout exclusively for events
 * so external parsers never have to disambiguate. All log / diagnostic
 * output goes to stderr.
 */
function emit(obj: RunEvent): void {
	try {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	} catch {
		// If stdout is closed (parent died), nothing we can do.
	}
}

/** The `stop` field of a result event: which guard stopped the run, and its limit. */
export function stopInfo(stop: TurnStop): RunStopInfo {
	if (stop.kind === "watchdog")
		return { kind: "watchdog", reason: stop.reason, limit_ms: stop.limitMs };
	if (stop.kind === "formatting_rule_violation")
		return { kind: stop.kind, reason: stop.reason, constraint: stop.constraint, draft: stop.draft };
	return { kind: "circuit_breaker", reason: stop.reason };
}

/**
 * Pick a sensible default model for the active provider when the caller did
 * not specify one. Unknown providers fall through to `auto:free` — the
 * OpenRouter free-tier alias — instead of assuming an ollama model is
 * installed.
 */
export function defaultModelFor(provider: string): string {
	switch (provider) {
		case "ollama":
			return "qwen3:14b";
		case "lmstudio":
			return "local-model";
		case "8gent":
			return "eight-1.0-q3:14b";
		case "openrouter":
			return "auto:free";
		default:
			return "auto:free";
	}
}

/**
 * The model a one-shot run uses when none was chosen. Providers with a built-in
 * name keep it; every other provider is asked for its own live list (bounded by
 * the discovery timeout) and never gets another provider's alias. "" means none.
 */
const BUILTIN_DEFAULT_PROVIDERS = new Set(["ollama", "lmstudio", "8gent", "openrouter"]);
export async function modelForOneShot(
	provider: string,
	chosen: string | undefined,
	discover?: (p: string) => Promise<string[]>,
): Promise<string> {
	return (await modelForOneShotWithReason(provider, chosen, discover)).model;
}

/** Same pick, but keeps why the list failed so the caller can say it in words. */
export async function modelForOneShotWithReason(
	provider: string,
	chosen: string | undefined,
	discover?: (p: string) => Promise<string[]>,
): Promise<{ model: string; error?: unknown }> {
	if (chosen?.trim()) return { model: chosen.trim() };
	if (BUILTIN_DEFAULT_PROVIDERS.has(provider)) return { model: defaultModelFor(provider) };
	try {
		const ask =
			discover ??
			(async (p: string) => (await import("../providers")).getProviderManager().discoverModels(p));
		const first = (await ask(provider)).map((m) => String(m).trim()).find((m) => m.length > 0);
		return { model: first ?? "" };
	} catch (error) {
		return { model: "", error };
	}
}

/** The plain sentence for "no model could be chosen" (key missing, key rejected, or list down). */
export async function noModelNotice(provider: string, error?: unknown): Promise<string> {
	const { noModelMessage } = await import("../providers/no-model-message");
	let displayName = provider;
	let keyEnv = "";
	let key: string | null = null;
	try {
		const pm = (await import("../providers")).getProviderManager();
		const cfg = pm.getProvider(provider);
		displayName = cfg.displayName || provider;
		keyEnv = cfg.apiKeyEnv || cfg.apiKeyRef || "";
		key = pm.getApiKey(provider);
	} catch {
		/* unknown provider: fall through to the list wording */
	}
	return noModelMessage({
		displayName,
		provider,
		keyEnv,
		key,
		err: error,
		pickHint: "Pass --model <name>.",
	});
}

/** Probe localhost:11434 once to see if ollama is actually running. */
async function isOllamaUp(): Promise<boolean> {
	try {
		const res = await fetch("http://localhost:11434/api/tags", {
			signal: AbortSignal.timeout(1500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Dynamically auto-detect an available Ollama model if none was specified.
 * Returns null if Ollama is unreachable or has no models.
 */
async function autoDetectOllamaModel(): Promise<string | null> {
	try {
		const res = await fetch("http://localhost:11434/api/tags", {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { models?: Array<{ name: string }> };
		const names = (data.models || []).map((m) => m.name);
		return (
			names.find((n) => n.startsWith("eight")) || names.find((n) => !n.includes("embed")) || null
		);
	} catch {
		return null;
	}
}

// ── Provider choice (#4362, #4363) ───────────────────────────────────
// Order: --provider flag > the choice saved by onboarding/settings > the
// adaptive router. A saved choice is skipped only when its endpoint cannot
// be reached, and then the caller is told in words.

export interface SavedProviderChoice {
	provider: string;
	model?: string;
}

/**
 * The provider (and model) the user saved in providers.json, or undefined when
 * the file has no explicit `activeProvider`. Read straight from the file: the
 * provider manager fills a default in, which would make "nothing chosen" look
 * like a choice.
 */
export function readSavedProviderChoice(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): SavedProviderChoice | undefined {
	const file =
		env.EIGHT_PROVIDERS_SETTINGS_PATH ||
		joinPath(env.EIGHT_DATA_DIR || joinPath(home, ".8gent"), "providers.json");
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as {
			activeProvider?: unknown;
			activeModel?: unknown;
		};
		if (typeof raw.activeProvider !== "string" || !raw.activeProvider.trim()) return undefined;
		const model =
			typeof raw.activeModel === "string" && raw.activeModel.trim() ? raw.activeModel : undefined;
		return { provider: raw.activeProvider.trim(), model };
	} catch {
		return undefined;
	}
}

const PROVIDER_LABELS: Record<string, string> = {
	lmstudio: "LM Studio",
	ollama: "Ollama",
	openrouter: "OpenRouter",
	"8gent": "8gent",
};

export function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * What a user reads when a turn ran on a different model than the one asked
 * for: what was asked, what is answering (provider and a readable name, never a
 * bare hash), and why.
 */
export function providerRouteNotice(
	asked: string,
	usedProvider: string,
	usedModel: string,
	reason?: "capability" | "missing",
): string {
	const used = `${providerLabel(usedProvider)} ${readableModelName(usedModel)}`;
	const why =
		reason === "capability"
			? "it cannot call tools"
			: reason === "missing"
				? "it is not installed locally"
				: "it did not answer";
	return `Asked for ${readableModelName(asked)}; ${used} is answering instead, because ${why}.`;
}

/** True the first time a route (asked -> used + reason) is seen in a tab: A, B, A prints twice. */
export function shouldShowRouteNotice(shown: Set<string>, key: string): boolean {
	if (shown.has(key)) return false;
	shown.add(key);
	return true;
}

export interface ProviderChoice {
	provider: string;
	model?: string;
	source: "flag" | "saved" | "router";
	/** Set when a saved choice was unreachable and another provider was used. */
	notice?: string;
}

export interface ProviderChoiceDeps {
	saved?: SavedProviderChoice;
	/** Whether the provider's own endpoint answers (cloud providers: true). */
	reachable: (provider: string) => Promise<boolean>;
	ollamaUp: () => Promise<boolean>;
	ollamaModel: () => Promise<string | null>;
}

export async function resolveProviderChoice(
	req: { provider?: string; model?: string; routerFallback?: "openrouter" | "ollama" },
	deps: ProviderChoiceDeps,
): Promise<ProviderChoice> {
	const modelFor = async (provider: string, saved?: string) =>
		req.model ??
		saved ??
		(provider === "ollama" ? ((await deps.ollamaModel()) ?? undefined) : undefined);
	if (req.provider) {
		const saved = deps.saved?.provider === req.provider ? deps.saved.model : undefined;
		return { provider: req.provider, model: await modelFor(req.provider, saved), source: "flag" };
	}
	const saved = deps.saved;
	if (saved && (await deps.reachable(saved.provider))) {
		return {
			provider: saved.provider,
			model: await modelFor(saved.provider, saved.model),
			source: "saved",
		};
	}
	const provider = (await deps.ollamaUp()) ? "ollama" : (req.routerFallback ?? "openrouter");
	const model = await modelFor(provider);
	const notice = saved
		? `${providerLabel(saved.provider)} not reachable, using ${providerLabel(provider)} ${
				model ?? defaultModelFor(provider)
			}`
		: undefined;
	return { provider, model, source: "router", notice };
}

export const CHAT_RUNTIMES: ReadonlySet<string> = new Set([
	"ollama",
	"lmstudio",
	"openrouter",
	"apple-foundation",
	"apfel",
	"deepseek",
]);

/**
 * A saved provider chat cannot run as a runtime (e.g. "groq") is set aside for
 * the router, with a stated reason. Flag choices are left as typed.
 */
export async function resolveChatChoice(
	req: { provider?: string; model?: string },
	deps: ProviderChoiceDeps,
): Promise<ProviderChoice> {
	const choice = await resolveProviderChoice({ ...req, routerFallback: "ollama" }, deps);
	// A hosted, keyed provider in the registry (minimax, groq, ...) is a chat
	// runtime too: the native path resolves its endpoint and key from the
	// registry entry (#4622), so it is not set aside for Ollama.
	if (choice.source !== "saved" || CHAT_RUNTIMES.has(choice.provider)) return choice;
	const { isHostedChatProvider } = await import("../providers/key-resolver");
	if (isHostedChatProvider(choice.provider)) return choice;
	const next = await resolveProviderChoice(
		{ model: req.model, routerFallback: "ollama" },
		{ ...deps, saved: undefined },
	);
	next.notice = `${choice.provider} is not a chat provider, using ${providerLabel(next.provider)} ${
		next.model ?? defaultModelFor(next.provider)
	}`;
	return next;
}

/** Any HTTP answer counts: only a refused or timed-out connection is "not reachable". */
export async function providerReachable(provider: string): Promise<boolean> {
	try {
		const { getProviderManager } = await import("../providers");
		const { isLocalProvider } = await import("./registry");
		if (!isLocalProvider(provider)) return true;
		const base = getProviderManager().getProvider(provider).baseUrl;
		if (!base) return true;
		await fetch(base, { signal: AbortSignal.timeout(1500) });
		return true;
	} catch {
		return false;
	}
}

/** The production wiring of the dependencies above. */
export function liveProviderChoiceDeps(): ProviderChoiceDeps {
	return {
		saved: readSavedProviderChoice(),
		reachable: providerReachable,
		ollamaUp: isOllamaUp,
		ollamaModel: autoDetectOllamaModel,
	};
}

export async function runRunCommand(
	argv: string[],
	deps: { sessions?: RunSessionStore; stdin?: () => Promise<string> } = {},
): Promise<number> {
	const opts = parseRunArgs(argv);
	if (opts.print || !opts.prompt) {
		try {
			const piped = await (deps.stdin ?? (() => readPipedStdin(Boolean(opts.prompt))))();
			if (Buffer.byteLength(piped) > MAX_STDIN_BYTES)
				throw new StdinTooLargeError(Buffer.byteLength(piped));
			opts.prompt = combinePromptAndStdin(opts.prompt, piped);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (opts.outputFormat === "stream-json")
				emit({ type: "error", subtype: "usage", message: msg });
			else process.stderr.write(`${msg}\n`);
			return 1;
		}
	}

	if (!opts.prompt) {
		const err =
			'Error: `8gent run` requires a prompt. Usage: 8gent -p [--mode json] "<prompt>" (or: git diff | 8gent -p "review")';
		if (opts.outputFormat === "stream-json") {
			emit({ type: "error", subtype: "usage", message: err });
		} else {
			process.stderr.write(`${err}\n`);
		}
		return 1;
	}

	// --yes: auto-approve tool calls for the duration of this run.
	// NemoClaw's PermissionManager.setAutoApprove(true) bypasses prompts for
	// non-dangerous commands. Catastrophic commands (rm -rf /, push to main
	// via its own guard, etc.) remain blocked.
	if (opts.yes) {
		try {
			const perms = await import("../permissions");
			perms.getPermissionManager().setAutoApprove(true);
		} catch (err) {
			process.stderr.write(`[run] warn: could not enable auto-approve: ${String(err)}\n`);
		}
	}

	// --tools: only these tools for the run (F5). Applies to the whole process.
	if (opts.tools) {
		const unknown = await unknownToolNames(opts.tools);
		if (unknown.length) {
			const msg = `Warning: --tools names no such tool: ${unknown.join(", ")}.`;
			if (opts.outputFormat === "stream-json")
				emit({ type: "error", subtype: "usage", message: msg });
			else process.stderr.write(`${msg}\n`);
		}
		const { getModeManager } = await import("./modes");
		getModeManager().applyToolAllowlist(opts.tools);
	}

	// Resolve provider + model.
	// If the caller didn't pick a provider, probe ollama once and only
	// route to it when it actually answers. Otherwise drop to the free
	// cloud tier so the run doesn't fail with `ECONNREFUSED 127.0.0.1:11434`
	// on a fresh Windows install that has never had ollama.
	const choice = await resolveProviderChoice(
		{ provider: opts.provider, model: opts.model },
		liveProviderChoiceDeps(),
	);
	const provider = choice.provider;
	if (choice.notice) process.stderr.write(`[run] ${choice.notice}\n`);
	// --provider naming a local provider pins it: every network command asks
	// before it runs, and is refused with no terminal (#3748).
	if (opts.provider) {
		try {
			const [perms, policy] = await Promise.all([
				import("../permissions"),
				import("../permissions/command-policy"),
			]);
			perms.getPermissionManager().setPinnedLocalProvider(policy.LOCAL_PROVIDERS.has(provider));
		} catch (err) {
			process.stderr.write(
				`[run] warn: could not apply the pinned provider to permissions: ${String(err)}\n`,
			);
		}
	}
	const { model, error: modelError } = await modelForOneShotWithReason(provider, choice.model);
	if (!model) {
		const msg = await noModelNotice(provider, modelError);
		if (opts.outputFormat === "stream-json")
			emit({ type: "error", subtype: "usage", message: msg });
		else process.stderr.write(`${msg}\n`);
		return 1;
	}

	// Note to downstream harnesses: which stream-json shape we picked.
	// Goes to stderr so stdout stays clean NDJSON.
	if (opts.outputFormat === "stream-json") {
		process.stderr.write(
			"[run] stream-json shape: {type, subtype?, session_id, ...fields}. " +
				"Types: session_start, assistant, tool_use, tool_result, result, error.\n",
		);
	}

	const sessionStartedAt = new Date().toISOString();
	// Stable run id emitted on session_start and on the terminating `result`
	// event. Orchestra's PTY completion detector trips on either a `result`
	// type or the presence of a `session_id` field, so we include both.
	// Resume (F4): --session <id>, or --continue for this folder's latest session.
	// --no-session keeps the run out of the store, so nothing is read or written.
	const workDirForSession = resolvePath(opts.cwd || process.cwd());
	const persist = !opts.noSession && (opts.print || Boolean(opts.session) || opts.continueLatest);
	const store: RunSessionStore | null = !persist
		? null
		: (deps.sessions ?? defaultRunSessionStore(opts.sessionDir));
	let resumeFrom: { id: string; messages: Array<{ role: string; content: string }> } | null = null;
	if (store && (opts.session || opts.continueLatest)) {
		const found = opts.session
			? store.load(opts.session)
			: (() => {
					const latest = store.latestForCwd(workDirForSession);
					return latest ? store.load(latest.id) : null;
				})();
		if (found) {
			resumeFrom = { id: found.id, messages: found.messages };
		} else if (opts.session) {
			const err = `Error: no session "${opts.session}" to continue.`;
			if (opts.outputFormat === "stream-json")
				emit({ type: "error", subtype: "usage", message: err });
			else process.stderr.write(`${err}\n`);
			return 1;
		} else {
			process.stderr.write("[run] no earlier session in this folder; starting a new one.\n");
		}
	}
	const sessionId = resumeFrom?.id ?? `run-${Date.now()}`;

	const isStreamJson = opts.outputFormat === "stream-json";
	const events: AgentEventCallbacks = isStreamJson
		? {
				onToolStart: (e) => {
					emit({
						type: "tool_use",
						subtype: "start",
						tool_call_id: e.toolCallId,
						tool_name: e.toolName,
						step: e.stepNumber ?? null,
						input: e.args,
					});
				},
				onToolEnd: (e) => {
					emit({
						type: "tool_result",
						subtype: e.success ? "ok" : "error",
						tool_call_id: e.toolCallId,
						tool_name: e.toolName,
						step: e.stepNumber ?? null,
						success: e.success,
						duration_ms: e.durationMs,
						result_preview: e.resultPreview ?? "",
					});
				},
				onStepFinish: (e) => {
					if (e.text) {
						emit({
							type: "assistant",
							subtype: "text",
							step: e.stepNumber,
							finish_reason: e.finishReason,
							text: e.text,
							usage: e.usage,
						});
					}
					if (e.toolCalls && e.toolCalls.length > 0) {
						emit({
							type: "assistant",
							subtype: "tool_calls",
							step: e.stepNumber,
							finish_reason: e.finishReason,
							tool_calls: e.toolCalls,
							usage: e.usage,
						});
					}
				},
			}
		: {};

	if (isStreamJson) {
		emit({
			type: "session_start",
			session_id: sessionId,
			started_at: sessionStartedAt,
			provider,
			model,
			cwd: opts.cwd || process.cwd(),
			resumed: resumeFrom !== null,
			persisted: store !== null,
		});
	}

	// When emitting NDJSON, stdout must be reserved exclusively for events so
	// the external parser never has to disambiguate. Agent internals log via
	// `console.log` (AST indexer, loop detector, privacy gate, etc.); redirect
	// those to stderr for the duration of the run. Restored in `finally`.
	const originalConsoleLog = console.log;
	const originalConsoleInfo = console.info;
	if (isStreamJson) {
		console.log = (...args: unknown[]) => {
			process.stderr.write(`${args.map(String).join(" ")}\n`);
		};
		console.info = console.log;
	}

	// The run's working directory is its workspace root (#3747), for the run
	// only: an in-process caller gets its environment back afterwards.
	const workspaceRoot = runWorkspaceRoot(opts);
	const priorWorkspaceRoot = process.env.EIGHT_WORKSPACE_ROOT;
	if (workspaceRoot) process.env.EIGHT_WORKSPACE_ROOT = workspaceRoot;

	let exitCode = 0;
	// Read in the catch below: a native turn the watchdog aborts throws, and the
	// result must still name the watchdog, not the bare abort error (#4172).
	let stopOf: () => TurnStop | null = () => null;
	try {
		// --image: the file is read before the agent exists, so a bad path is a
		// usage error and never a model turn (#3641).
		let image: RunImage | undefined;
		if (opts.image) {
			const loaded = await loadRunImage(opts.image, opts.cwd || process.cwd(), provider);
			if ("error" in loaded) {
				if (isStreamJson) {
					emit({ type: "error", subtype: "usage", message: loaded.error });
					emit({
						type: "result",
						subtype: "error",
						session_id: sessionId,
						ended_at: new Date().toISOString(),
						error: loaded.error,
					});
				} else {
					process.stderr.write(`${loaded.error}\n`);
				}
				return 1;
			}
			image = loaded;
		}

		const { Agent } = await import("./agent");
		// A provider declared in providers.json is reachable only at its own
		// baseUrl; without it the native path has no base and fails "Invalid
		// URL" before any request (#4283). Built-ins keep their own resolution.
		const { getProviderManager } = await import("../providers");
		const declared = getProviderManager().getProvider(provider);
		const agent = new Agent({
			model,
			runtime: provider as "ollama" | "lmstudio" | "openrouter" | "apple-foundation",
			baseUrl: declared?.declared ? declared.baseUrl : undefined,
			workingDirectory: opts.cwd || process.cwd(),
			maxTurns: opts.maxTurns ?? 30,
			events,
			// --provider names the provider: a provider error ends the run
			// instead of moving to another one (#3746).
			providerPinned: Boolean(opts.provider),
			// The final text is read by programs, so a completion check answered
			// with "DONE:" keeps the model's answer first (#3638).
			keepAnswerFirst: true,
			// A lean prompt on the local text-tool path: every call pays its prefill.
			headless: true,
		});

		stopOf = () => agent.getTurnStop();

		if (resumeFrom) {
			// restoreFromCheckpoint logs to stdout; keep stdout for the answer.
			const log = console.log;
			console.log = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
			try {
				agent.restoreFromCheckpoint(resumeFrom.messages);
			} finally {
				console.log = log;
			}
		}

		const workDir = opts.cwd || process.cwd();
		const { baselineCheck, finishWithProjectCheck, projectFingerprint, verdictNotice } =
			await import("./done-gate");
		const run = (command: string, timeoutSec: number, env: Record<string, string | undefined>) =>
			agent.runGatedCommand(command, timeoutSec, env);
		// Done gate: the project's check before and after the run. A run that made
		// it worse goes back to the model, then fails loud (packages/eight/done-gate.ts).
		// The check runs repo code, so it needs --yes until run_command is sandboxed (#3612).
		const baseline = await baselineCheck({ cwd: workDir, run, consent: opts.yes });
		const before = projectFingerprint(workDir);
		const answer = await agent.chat(opts.prompt, image?.base64, image?.mimeType, image?.original);
		// A turn the breaker or the watchdog cut off is not finished (#4172).
		const firstStop = agent.getTurnStop();
		const check = await finishWithProjectCheck({
			baseline,
			changed: projectFingerprint(workDir) !== before,
			finalText: answer,
			run,
			chat: (message) => agent.chat(message),
		});
		if (store) {
			try {
				store.save(
					sessionId,
					agent
						.getMessageHistory()
						.filter((m) => m.role !== "system")
						.map((m) => ({
							...m,
							// A secret in piped input or tool output is not written to disk.
							content: typeof m.content === "string" ? scrub(m.content).scrubbed : m.content,
						})),
					{ model, provider, cwd: workDirForSession },
				);
			} catch (err) {
				process.stderr.write(`[run] warn: could not save the session: ${String(err)}\n`);
			}
		}
		const notice = verdictNotice(check, agent.getRanCommands(), workDir);
		const finalText = notice ? `${check.finalText}\n\n${notice}` : check.finalText;
		const projectCheck = {
			status: check.status,
			command: check.command ?? null,
			fix_rounds: check.fixRounds,
			detail: check.detail ?? null,
			notice,
		};
		if (check.status === "fail") exitCode = 1;
		// Once per run: the plain-text paths already print finalText, which carries the notice.
		if (notice && isStreamJson) process.stderr.write(`${notice}\n`);

		// The harness sets this flag; model text cannot (#3899).
		const turnFailure = agent.getLastTurnFailure();
		const stop = firstStop ?? agent.getTurnStop();
		if (stop) {
			// #4172: the circuit breaker or the session watchdog stopped the run, so the
			// task is not done. A script must see a failure and why, never "ok" and exit 0.
			exitCode = 1;
			if (isStreamJson) {
				emit({
					type: "result",
					subtype: "error",
					session_id: sessionId,
					ended_at: new Date().toISOString(),
					error: stop.reason,
					stop: stopInfo(stop),
					final_text: finalText,
					project_check: projectCheck,
				});
			} else {
				process.stdout.write(`${finalText}\n`);
				process.stderr.write(`[run] stopped: ${stop.reason}\n`);
			}
		} else if (isEmptyReplyNote(finalText) || turnFailure) {
			// #3524: a blank model reply is not a finished turn, so a script must not read it
			// as success. Same for a turn the harness flagged as failed (an unreachable or
			// timed-out local model, a model error, an honesty-gate refusal): the agent returns
			// those as text, so the flag, which model text cannot set, gives the exit code (#3899).
			// Exit 2 = a permission or sandbox refusal; 1 = everything else (#3899).
			exitCode = turnFailure?.reason === "denied" ? 2 : 1;
			if (isStreamJson) {
				emit({
					type: "result",
					subtype: "error",
					reason: turnFailure?.reason ?? "turn_failed",
					...(turnFailure?.unverified?.length ? { unverified: turnFailure.unverified } : {}),
					session_id: sessionId,
					ended_at: new Date().toISOString(),
					error: finalText,
					final_text: finalText,
				});
			} else {
				process.stderr.write(`${finalText}\n`);
			}
		} else if (isStreamJson) {
			emit({
				type: "result",
				subtype: check.status === "fail" ? "error" : "ok",
				session_id: sessionId,
				ended_at: new Date().toISOString(),
				final_text: finalText,
				project_check: projectCheck,
				...(check.status === "fail" ? { error: check.detail } : {}),
			});
		} else {
			process.stdout.write(`${finalText}\n`);
		}

		await agent.cleanup();
	} catch (err) {
		exitCode = 1;
		const stop = stopOf();
		const msg = stop ? stop.reason : err instanceof Error ? err.message : String(err);
		if (isStreamJson) {
			emit({ type: "error", subtype: "agent", message: msg });
			emit({
				type: "result",
				subtype: "error",
				session_id: sessionId,
				ended_at: new Date().toISOString(),
				error: msg,
				...(stop ? { stop: stopInfo(stop) } : {}),
			});
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
	} finally {
		if (isStreamJson) {
			console.log = originalConsoleLog;
			console.info = originalConsoleInfo;
		}
		if (workspaceRoot) {
			if (priorWorkspaceRoot === undefined)
				Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
			else process.env.EIGHT_WORKSPACE_ROOT = priorWorkspaceRoot;
		}
	}

	return exitCode;
}
