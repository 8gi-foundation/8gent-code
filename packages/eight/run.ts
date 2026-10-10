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
import { resolve as resolvePath } from "node:path";
import type { AgentEventCallbacks } from "./types";

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
 *                                downscaled to fit 1024x1024; inside the working directory)
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
 * 1024x1024 before it leaves the process.
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
	};
}

/**
 * The workspace root a run sets (#3747): its working directory, as
 * EIGHT_WORKSPACE_ROOT, which the policy engine's workspace boundary reads
 * for the actions it evaluates. It does not by itself confine every tool:
 * native read_file (#3759), native run_command and the notebook tools (#3760)
 * are not covered by this change. A root already in the environment is kept.
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
 * contacted. The image is downscaled to fit 1024x1024 exactly as read_image
 * does, so what reaches the model is bounded the same way on both paths;
 * sharp's own pixel limit bounds the decode.
 */
export async function loadRunImage(
	file: string,
	cwd: string,
): Promise<{ base64: string; mimeType: string } | { error: string }> {
	const path = await import("node:path");
	const fs = await import("node:fs");
	// Same containment as every file tool: inside the working directory, no
	// credential or device paths, no symlink escape. Refused before any read.
	let absolute: string;
	try {
		const { safePath } = await import("./tools");
		absolute = safePath(file, cwd);
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
		const shown = await resizeImage(absolute, 1024, 1024);
		const format = shown.format === "jpg" ? "jpeg" : shown.format;
		return { base64: shown.base64, mimeType: `image/${format}` };
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
function emit(obj: Record<string, unknown>): void {
	try {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	} catch {
		// If stdout is closed (parent died), nothing we can do.
	}
}

/**
 * Pick a sensible default model for the active provider when the caller did
 * not specify one. Unknown providers fall through to `auto:free` — the
 * OpenRouter free-tier alias — instead of assuming an ollama model is
 * installed.
 */
function defaultModelFor(provider: string): string {
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

export async function runRunCommand(argv: string[]): Promise<number> {
	const opts = parseRunArgs(argv);

	if (!opts.prompt) {
		const err =
			'Error: `8gent run` requires a prompt. Usage: 8gent run [--yes] [--output-format stream-json] "<prompt>"';
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

	// Resolve provider + model.
	// If the caller didn't pick a provider, probe ollama once and only
	// route to it when it actually answers. Otherwise drop to the free
	// cloud tier so the run doesn't fail with `ECONNREFUSED 127.0.0.1:11434`
	// on a fresh Windows install that has never had ollama.
	let provider = opts.provider;
	if (!provider) {
		provider = (await isOllamaUp()) ? "ollama" : "openrouter";
	}
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
			process.stderr.write(`[run] warn: could not apply the pinned provider to permissions: ${String(err)}\n`);
		}
	}
	let model = opts.model;
	if (!model) {
		if (provider === "ollama") {
			model = (await autoDetectOllamaModel()) || defaultModelFor(provider);
		} else {
			model = defaultModelFor(provider);
		}
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
	const sessionId = `run-${Date.now()}`;

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
	try {
		// --image: the file is read before the agent exists, so a bad path is a
		// usage error and never a model turn (#3641).
		let image: { base64: string; mimeType: string } | undefined;
		if (opts.image) {
			const loaded = await loadRunImage(opts.image, opts.cwd || process.cwd());
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
		const agent = new Agent({
			model,
			runtime: provider as "ollama" | "lmstudio" | "openrouter" | "apple-foundation",
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

		const finalText = await agent.chat(opts.prompt, image?.base64, image?.mimeType);

		if (isStreamJson) {
			emit({
				type: "result",
				subtype: "ok",
				session_id: sessionId,
				ended_at: new Date().toISOString(),
				final_text: finalText,
			});
		} else {
			process.stdout.write(`${finalText}\n`);
		}

		await agent.cleanup();
	} catch (err) {
		exitCode = 1;
		const msg = err instanceof Error ? err.message : String(err);
		if (isStreamJson) {
			emit({ type: "error", subtype: "agent", message: msg });
			emit({
				type: "result",
				subtype: "error",
				session_id: sessionId,
				ended_at: new Date().toISOString(),
				error: msg,
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
			if (priorWorkspaceRoot === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
			else process.env.EIGHT_WORKSPACE_ROOT = priorWorkspaceRoot;
		}
	}

	return exitCode;
}
