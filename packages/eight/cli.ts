/**
 * 8gent Code - CLI Non-Interactive Mode
 *
 * Enables 8gent as a subagent callable from scripts, CI, or other agents.
 *
 * Usage:
 *   8gent --cli "write a rate limiter in under 100 lines"
 *   8gent --cli --output /tmp/result.ts "write a debounce utility"
 *   8gent --cli --json "explain this codebase"
 *   echo "Summarize this" | 8gent --cli
 *   8gent --cli --task-kind review "find what is wrong in this diff"
 *
 * --task-kind <simple|code|reasoning|review> is passed to the provider router
 * as `taskKind`. It only changes anything when EIGHT_EFFORT_POLICY=1 (#3461).
 * Any other value is rejected with exit code 1 before a model is called.
 * If --task-kind is repeated, the last one wins: a later valid value clears an
 * earlier error, and a later invalid value replaces an earlier valid kind.
 * A flag in the value slot (`--task-kind --json`) is taken as the value and
 * rejected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EFFORT_BY_TASK_KIND, type EffortTaskKind } from "../providers/effort-policy";
import {
	type ChatRequest,
	type ChatResponse,
	type ProviderName,
	getProviderManager,
} from "../providers/index";

// ============================================
// Types
// ============================================

export interface CLIOptions {
	prompt: string;
	outputPath?: string;
	jsonMode: boolean;
	model?: string;
	provider?: ProviderName;
	/** Task kind for the effort policy (#3461). Only set when valid. */
	taskKind?: CLITaskKind;
	/** Set when --task-kind was given a missing or unknown value. */
	taskKindError?: string;
}

/**
 * Values accepted by --task-kind: exactly the kinds the effort policy has a
 * level for, derived from its table so the two cannot drift.
 */
export type CLITaskKind = EffortTaskKind;
export const CLI_TASK_KINDS: readonly CLITaskKind[] = Object.keys(
	EFFORT_BY_TASK_KIND,
) as CLITaskKind[];

function setTaskKind(opts: CLIOptions, value: string | undefined): void {
	if (value && (CLI_TASK_KINDS as readonly string[]).includes(value)) {
		opts.taskKind = value as CLITaskKind;
		opts.taskKindError = undefined;
		return;
	}
	opts.taskKind = undefined;
	opts.taskKindError = `Invalid --task-kind ${JSON.stringify(value ?? "")}. Use one of: ${CLI_TASK_KINDS.join(", ")}.`;
}

export interface CLIResult {
	response: string;
	files_created: string[];
	files_modified: string[];
	model: string;
	provider: string;
	exitCode: number;
	/** Token counts, present only when the provider reported them. */
	usage?: ChatResponse["usage"];
	/**
	 * Thinking level requested and applied (after downgrade), present only
	 * when the request carried a level. Lets an A/B of #3461 read both.
	 */
	thinking?: ChatResponse["thinking"];
}

/**
 * The `--json` result for a completed call. `usage` and `thinking` are copied
 * from the response only when present, so the default output keeps its keys.
 */
export function buildCLIResult(
	result: ChatResponse,
	created: string[],
	modified: string[],
): CLIResult {
	return {
		response: result.content,
		files_created: created,
		files_modified: modified,
		model: result.model,
		provider: result.provider,
		exitCode: 0,
		...(result.usage ? { usage: result.usage } : {}),
		...(result.thinking ? { thinking: result.thinking } : {}),
	};
}

// ============================================
// Arg Parsing
// ============================================

export function parseCLIArgs(args: string[]): CLIOptions | null {
	if (!args.includes("--cli")) return null;

	const filtered = args.filter((a) => a !== "--cli");
	const opts: CLIOptions = {
		prompt: "",
		jsonMode: filtered.includes("--json"),
	};

	const withoutFlags: string[] = [];
	for (let i = 0; i < filtered.length; i++) {
		const arg = filtered[i];
		if (arg === "--json") continue;
		if (arg === "--output" || arg === "-o") {
			opts.outputPath = filtered[++i];
		} else if (arg.startsWith("--output=")) {
			opts.outputPath = arg.slice("--output=".length);
		} else if (arg === "--model" || arg === "-m") {
			opts.model = filtered[++i];
		} else if (arg.startsWith("--model=")) {
			opts.model = arg.slice("--model=".length);
		} else if (arg === "--provider") {
			opts.provider = filtered[++i] as ProviderName;
		} else if (arg.startsWith("--provider=")) {
			opts.provider = arg.slice("--provider=".length) as ProviderName;
		} else if (arg === "--task-kind") {
			setTaskKind(opts, filtered[++i]);
		} else if (arg.startsWith("--task-kind=")) {
			setTaskKind(opts, arg.slice("--task-kind=".length));
		} else if (!arg.startsWith("--")) {
			withoutFlags.push(arg);
		}
	}

	opts.prompt = withoutFlags.join(" ").trim();
	return opts;
}

/**
 * The request `--cli` sends to the router. `taskKind` is added only when the
 * option was given, so without it the request is the same as before #3461.
 */
export function buildCLIChatRequest(opts: CLIOptions): ChatRequest {
	return {
		messages: [
			{
				role: "system",
				content:
					"You are 8gent Code, an autonomous coding agent. When asked to write code, output clean TypeScript inside a fenced code block. Be concise and practical.",
			},
			{ role: "user", content: opts.prompt },
		],
		model: opts.model,
		...(opts.taskKind ? { taskKind: opts.taskKind } : {}),
	};
}

// ============================================
// Stdin Reader
// ============================================

async function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) {
			resolve("");
			return;
		}
		const chunks: Buffer[] = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8").trim()));
		process.stdin.on("error", () => resolve(""));
	});
}

// ============================================
// Code Extractor
// ============================================

function extractCode(text: string): string | null {
	const fenced = text.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	// Fall back: if response looks like raw code, return as-is
	if (
		text.trim().startsWith("//") ||
		text.trim().startsWith("export") ||
		text.trim().startsWith("import")
	) {
		return text.trim();
	}
	return null;
}

// ============================================
// Track files written during session
// ============================================

const filesCreated: string[] = [];
const filesModified: string[] = [];

function writeOutput(filePath: string, content: string): void {
	const existed = fs.existsSync(filePath);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
	if (existed) {
		filesModified.push(filePath);
	} else {
		filesCreated.push(filePath);
	}
}

// ============================================
// Main CLI Handler
// ============================================

/** Named reasons a one-shot call can fail. Every failure prints one of these. */
export type CLIFailure =
	| "no-prompt"
	| "unknown-provider"
	| "no-key"
	| "model-unavailable"
	| "empty-completion"
	| "request-failed";

const NEXT_STEP: Record<CLIFailure, string> = {
	"no-prompt": "pass the prompt as an argument or pipe it on stdin",
	"unknown-provider": "run 8gent --help for the provider list or fix --provider",
	"no-key": "set the provider's key env var or save it in ~/.8gent/providers.json",
	"model-unavailable": "pick another --model or omit it to use the provider default",
	"empty-completion": "retry, or try another --model or --provider",
	"request-failed": "check the network and provider status, then retry",
};

export interface OneShotDeps {
	manager?: Pick<
		ReturnType<typeof getProviderManager>,
		"chat" | "setActiveProvider" | "isKnownProvider" | "getActiveProvider" | "getApiKey"
	>;
	readStdin?: () => Promise<string>;
}

export interface OneShotOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Run one prompt. Always resolves to either a non-empty stdout with exit 0,
 * or a named reason on stderr with exit 1. It never resolves to exit 0 with
 * empty stdout.
 */
export async function executeOneShot(
	args: string[],
	deps: OneShotDeps = {},
): Promise<OneShotOutcome> {
	const opts = parseCLIArgs(args);
	if (!opts) {
		return { exitCode: 1, stdout: "", stderr: "Error: --cli flag required\n" };
	}

	if (opts.taskKindError) {
		return {
			exitCode: 1,
			stdout: opts.jsonMode
				? `${JSON.stringify({ error: opts.taskKindError, exitCode: 1 })}\n`
				: "",
			stderr: `Error: ${opts.taskKindError}\n`,
		};
	}

	const fail = (reason: CLIFailure, detail: string): OneShotOutcome => {
		const line = `8gent: ${reason}: ${detail}. Next: ${NEXT_STEP[reason]}.\n`;
		return {
			exitCode: 1,
			stdout: opts.jsonMode ? `${JSON.stringify({ error: reason, detail, exitCode: 1 })}\n` : "",
			stderr: line,
		};
	};

	if (!opts.prompt) {
		opts.prompt = await (deps.readStdin ?? readStdin)();
	}
	if (!opts.prompt) return fail("no-prompt", "no prompt was given");

	const manager = deps.manager ?? getProviderManager();

	if (opts.provider) {
		if (!manager.isKnownProvider(opts.provider)) {
			return fail("unknown-provider", `"${opts.provider}" is not a known provider`);
		}
		try {
			manager.setActiveProvider(opts.provider);
		} catch (e) {
			return fail("unknown-provider", e instanceof Error ? e.message : String(e));
		}
	}

	const active = manager.getActiveProvider();
	if (active.apiKeyEnv && !manager.getApiKey(active.name)) {
		return fail("no-key", `no key for ${active.displayName} (${active.apiKeyEnv} is not set)`);
	}

	try {
		const result = await manager.chat(buildCLIChatRequest(opts));

		const responseText = result.content ?? "";
		if (!responseText.trim()) {
			return fail(
				"empty-completion",
				`${result.provider} returned an empty completion from ${result.model}`,
			);
		}

		let stderr = "";
		if (opts.outputPath) {
			const code = extractCode(responseText) ?? responseText;
			writeOutput(opts.outputPath, code);
			stderr = `Written to: ${opts.outputPath}\n`;
		}

		const cliResult = buildCLIResult(result, filesCreated, filesModified);
		const stdout = opts.jsonMode ? JSON.stringify(cliResult, null, 2) : responseText;
		return { exitCode: 0, stdout: `${stdout}\n`, stderr };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const unavailable =
			/\b(404|400)\b/.test(message) && /model|not found|no endpoints|not a valid/i.test(message);
		return unavailable
			? fail("model-unavailable", message.slice(0, 200))
			: fail("request-failed", message.slice(0, 200));
	}
}

export async function runCLI(args: string[]): Promise<void> {
	const out = await executeOneShot(args);
	if (out.stdout) process.stdout.write(out.stdout);
	if (out.stderr) process.stderr.write(out.stderr);
	process.exit(out.exitCode);
}

// Running this file directly (`bun packages/eight/cli.ts "..."`) used to import
// cleanly and do nothing, exiting 0 with no output. It is a one-shot entry too.
if (import.meta.main) {
	const argv = process.argv.slice(2);
	await runCLI(argv.includes("--cli") ? argv : ["--cli", ...argv]);
}
