/**
 * external-agent-runner — spawn another agent CLI as a sub-agent and collect
 * its response. The 8gent TUI uses this to host claude / hermes / codex /
 * openclaw / aider as nested chat tabs. **Inception.**
 *
 * v1: one-shot per turn. Each prompt spawns a fresh subprocess and waits for
 * stdout. Conversation context is maintained in 8gent's own message history,
 * passed as a single composed prompt. The nested CLI doesn't keep its own
 * session - that's a follow-up (`--resume`, `--continue` per-CLI flags).
 *
 * The runner is deliberately dumb. Each preset declares: how to invoke the
 * CLI, where to put the prompt (arg or stdin), and how to extract the reply
 * from stdout. Add a new agent by adding a preset — no core changes.
 */

import { spawn } from "node:child_process";

// ============================================================================
// Public types
// ============================================================================

export interface ExternalAgentPreset {
	/** Stable id used by /spawn and persisted in tab data. */
	id: string;
	/** Human label for the tab title and status bar. */
	label: string;
	/** Binary on $PATH. */
	command: string;
	/**
	 * How to deliver the prompt to the CLI:
	 * - "arg":  passed as the trailing positional argument
	 * - "stdin": written to stdin then EOF
	 * - "flag": prepended to args via the configured `flagName` (e.g., -p)
	 */
	promptMode: "arg" | "stdin" | "flag";
	flagName?: string;
	/** Static flags always passed (e.g., ["--print", "--no-color"]). */
	args: string[];
	/** Per-call timeout. Default 90s. */
	timeoutMs?: number;
	/** Optional post-processor for stdout (strip ANSI, peel JSON envelope). */
	parseStdout?: (raw: string) => string;
}

export interface ExternalAgentResult {
	ok: boolean;
	text: string;
	durationMs: number;
	command: string;
	error?: string;
	exitCode?: number | null;
}

// ============================================================================
// Presets — add a new agent by adding an entry here.
// ============================================================================

const stripAnsi = (s: string): string =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI is exactly the point
	s.replace(/\[[0-9;?]*[a-zA-Z]/g, "").replace(/\][^]*/g, "");

export const EXTERNAL_AGENT_PRESETS: Record<string, ExternalAgentPreset> = {
	claude: {
		id: "claude",
		label: "Claude Code",
		command: "claude",
		promptMode: "flag",
		flagName: "-p",
		args: [],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
	},
	codex: {
		id: "codex",
		label: "OpenAI Codex",
		command: "codex",
		// `codex exec "<prompt>"` is the standard headless invocation.
		promptMode: "arg",
		args: ["exec"],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
	},
	hermes: {
		id: "hermes",
		label: "Hermes Agent",
		command: "hermes",
		promptMode: "arg",
		args: ["--headless"],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
	},
	openclaw: {
		id: "openclaw",
		label: "OpenClaw",
		command: "openclaw",
		promptMode: "arg",
		args: ["run", "--headless"],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
	},
	aider: {
		id: "aider",
		label: "Aider",
		command: "aider",
		// Aider eats prompts via --message; --no-pretty silences ANSI.
		promptMode: "flag",
		flagName: "--message",
		args: ["--no-pretty", "--yes", "--no-stream"],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
	},
};

export function getPreset(id: string): ExternalAgentPreset | null {
	return EXTERNAL_AGENT_PRESETS[id.toLowerCase()] ?? null;
}

export function listPresetIds(): string[] {
	return Object.keys(EXTERNAL_AGENT_PRESETS);
}

// ============================================================================
// Runner
// ============================================================================

/**
 * Compose a prompt + history into a single text payload. The nested CLI runs
 * one-shot, so we re-send context each turn. v2 will use per-CLI session
 * resume flags.
 */
export function composePrompt(history: Array<{ role: string; content: string }>, prompt: string): string {
	const lines: string[] = [];
	for (const m of history) {
		const tag = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
		lines.push(`${tag}: ${m.content}`);
	}
	lines.push(`User: ${prompt}`);
	lines.push("Assistant:");
	return lines.join("\n\n");
}

/**
 * Run an external agent for one turn. Returns the text response.
 * If the binary is missing on $PATH, returns ok:false with a clear error.
 */
export async function runExternalAgent(
	preset: ExternalAgentPreset,
	prompt: string,
	signal?: AbortSignal,
): Promise<ExternalAgentResult> {
	const start = performance.now();
	const argv = [...preset.args];

	if (preset.promptMode === "flag") {
		argv.push(preset.flagName ?? "-p", prompt);
	} else if (preset.promptMode === "arg") {
		argv.push(prompt);
	}
	// For "stdin" mode argv stays untouched; prompt goes to stdin below.

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let exited = false;

		const proc = spawn(preset.command, argv, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});

		const finish = (result: Omit<ExternalAgentResult, "durationMs" | "command">) => {
			if (exited) return;
			exited = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				...result,
				durationMs: Math.round(performance.now() - start),
				command: `${preset.command} ${argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
			});
		};

		proc.on("error", (err: NodeJS.ErrnoException) => {
			finish({
				ok: false,
				text: "",
				error: err.code === "ENOENT" ? `${preset.command}: not installed (no binary on $PATH)` : err.message,
				exitCode: null,
			});
		});

		proc.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			const text = preset.parseStdout ? preset.parseStdout(stdout).trim() : stdout.trim();
			if (code === 0 || (code !== null && text.length > 0)) {
				finish({ ok: code === 0, text, exitCode: code, error: code === 0 ? undefined : stderr.trim().slice(0, 400) });
			} else {
				finish({
					ok: false,
					text,
					exitCode: code,
					error: stderr.trim().slice(0, 400) || `exited with code ${code}`,
				});
			}
		});

		if (preset.promptMode === "stdin" && proc.stdin) {
			proc.stdin.write(prompt);
			proc.stdin.end();
		}

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			finish({
				ok: false,
				text: stdout,
				error: `timeout after ${preset.timeoutMs ?? 90_000}ms`,
				exitCode: null,
			});
		}, preset.timeoutMs ?? 90_000);

		const onAbort = () => {
			proc.kill("SIGTERM");
			finish({ ok: false, text: stdout, error: "aborted", exitCode: null });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
