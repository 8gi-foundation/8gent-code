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

import { execSync, spawn } from "node:child_process";

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
	/**
	 * Optional auto-install recipe. When the binary is not on $PATH,
	 * `/spawn` runs this command so users don't have to leave the TUI.
	 * - `command` is a single shell command (no arg array).
	 * - `notes` is a human-readable hint shown in the chat for cases
	 *   that need extra steps (auth, manual setup) the installer can't
	 *   handle automatically.
	 *
	 * IMPORTANT: only set this for packages we have verified actually
	 * exist with the expected binary. A wrong recipe is worse than no
	 * recipe — it confuses the user with a 404 or, worse, installs the
	 * wrong project under a name-collision.
	 */
	install?: {
		command: string;
		notes?: string;
	};
	/** Project documentation URL — surfaced when no install recipe is
	 * available, so the user knows where to find install steps. */
	homepage?: string;
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
		homepage: "https://docs.claude.com/en/docs/claude-code",
		install: {
			// `--prefix` dodges EACCES when system Node owns /usr/local/lib
			// and the user lacks sudo. Binary lands in ~/.npm-global/bin which
			// the post-install note tells the user to add to PATH if needed.
			command: "npm install -g --prefix=$HOME/.npm-global @anthropic-ai/claude-code",
			notes:
				"Binary at ~/.npm-global/bin/claude. If `claude` isn't on PATH after install, add `export PATH=\"$HOME/.npm-global/bin:$PATH\"` to your shell rc. Then run `claude` once outside the TUI to authenticate with Anthropic.",
		},
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
		homepage: "https://github.com/openai/codex",
		install: {
			command: "npm install -g --prefix=$HOME/.npm-global @openai/codex",
			notes:
				"Binary at ~/.npm-global/bin/codex. Add `~/.npm-global/bin` to PATH if needed. Requires `export OPENAI_API_KEY=sk-...` before /spawn.",
		},
	},
	hermes: {
		id: "hermes",
		label: "Hermes Agent",
		command: "hermes",
		// Verified against `hermes --help` on a real install: `-z PROMPT`
		// is the one-shot non-interactive prompt flag. The previous
		// `--headless` was wrong (no such flag in the current Hermes CLI).
		promptMode: "flag",
		flagName: "-z",
		args: [],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
		homepage: "https://github.com/NousResearch/hermes-agent",
		install: {
			// `--skip-setup --no-venv` are the official non-interactive flags.
			// Without them the installer hangs forever waiting for keyboard
			// input on read -p prompts that have no TTY in our spawned subprocess.
			// Verified by reading the script source at install.sh:1566 lines.
			command:
				"curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --no-venv",
			notes:
				"Hermes needs Python ≥ 3.11 (anaconda's default 3.10 won't work — use pyenv or brew install python@3.11). Installer symlinks `hermes` into ~/.local/bin; add it to PATH if needed. After install, run `hermes setup` or `hermes model` outside the TUI to configure a provider — without that, /spawn'd Hermes tabs will fail with auth errors (Bedrock is the default provider).",
		},
	},
	openclaw: {
		id: "openclaw",
		label: "OpenClaw",
		command: "openclaw",
		promptMode: "arg",
		args: ["run", "--headless"],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
		homepage: "https://github.com/openclaw/openclaw",
		install: {
			command: "npm install -g --prefix=$HOME/.npm-global openclaw@latest",
			notes:
				"Requires Node 22.12+ at runtime (not just at install). On nvm: `nvm install 22 && nvm use 22`. Binary at ~/.npm-global/bin/openclaw. Add `~/.npm-global/bin` to PATH if needed. After install run `openclaw onboard` outside the TUI to set up the gateway, workspace, and skills.",
		},
	},
	pi: {
		// Pi (badlogic/pi-mono) — minimal terminal coding harness.
		// Replaces the previous Aider preset. Pi is the substrate that
		// OpenClaw is built on, so adding it as a peer makes the spawn
		// matrix more interesting (we can compare same-task on the
		// raw pi vs OpenClaw's wrapper).
		id: "pi",
		label: "Pi (pi-mono)",
		command: "pi",
		// `pi -p "<prompt>"` is the documented headless one-shot mode
		// (--print, prints reply and exits). Verified end-to-end via
		// runExternalAgent against a real install.
		promptMode: "flag",
		flagName: "-p",
		args: [],
		timeoutMs: 120_000,
		parseStdout: stripAnsi,
		homepage: "https://pi.dev",
		install: {
			command: "npm install -g --prefix=$HOME/.npm-global @mariozechner/pi-coding-agent",
			notes:
				"Binary at ~/.npm-global/bin/pi. Add `~/.npm-global/bin` to PATH if needed. Default provider is Google (Gemini) — set GEMINI_API_KEY, or override with --provider/--model and the matching API key env var (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY).",
		},
	},
	"8gent": {
		// 8gent inside 8gent. The bidirectional half: our own binary already has
		// `8gent chat <msg>` (pipe-friendly) and `8gent run <prompt>` (one-shot
		// for Orchestra/cmux). Lets the user /spawn 8gent in any 8gent tab.
		id: "8gent",
		label: "8gent (nested)",
		command: "8gent",
		// `run` is the documented one-shot pipe-friendly subcommand
		// (`chat` boots the full TUI splash and isn't usable from a
		// child process). Live-tested: `8gent run "<prompt>"` returns
		// the agent's reply on stdout. First call may take 30-60s
		// (cold Ollama model load); subsequent calls are fast.
		promptMode: "arg",
		args: ["run"],
		timeoutMs: 180_000,
		parseStdout: stripAnsi,
		homepage: "https://8gent.dev",
		install: {
			command:
				"npm install -g --prefix=$HOME/.npm-global @8gi-foundation/8gent-code --force",
			notes:
				"Binary at ~/.npm-global/bin/8gent. --force overwrites stale `8` / `8gent` / `8gent-code` bin symlinks (npm 9+ EEXIST). Add `~/.npm-global/bin` to PATH if not already.",
		},
	},
};

export function getPreset(id: string): ExternalAgentPreset | null {
	return EXTERNAL_AGENT_PRESETS[id.toLowerCase()] ?? null;
}

export function listPresetIds(): string[] {
	return Object.keys(EXTERNAL_AGENT_PRESETS);
}

/**
 * True if the preset's binary is on $PATH right now. Cheap synchronous
 * check via `command -v`. Returns false on any error.
 */
export function isInstalled(preset: ExternalAgentPreset): boolean {
	try {
		execSync(`command -v "${preset.command}"`, {
			stdio: "ignore",
			timeout: 1500,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Result of running a preset's auto-install recipe.
 */
export interface InstallResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	command: string;
	error?: string;
}

/**
 * Run the preset's install recipe and resolve with the outcome.
 * Streams stdout/stderr to the optional `onLine` callback so the TUI
 * can show live progress. Long-running (npm/pip install can take
 * 30s-90s); we cap at 5 minutes which is generous but bounded.
 */
export async function installAgent(
	preset: ExternalAgentPreset,
	onLine?: (line: string, source: "stdout" | "stderr") => void,
): Promise<InstallResult> {
	const start = performance.now();
	if (!preset.install) {
		return {
			ok: false,
			stdout: "",
			stderr: "",
			durationMs: 0,
			command: "",
			error: `No install recipe for ${preset.id}. Install ${preset.command} manually and try again.`,
		};
	}
	const command = preset.install.command;

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let exited = false;

		const proc = spawn("bash", ["-lc", command], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});

		const finish = (result: Omit<InstallResult, "durationMs" | "command">) => {
			if (exited) return;
			exited = true;
			clearTimeout(timer);
			resolve({
				...result,
				durationMs: Math.round(performance.now() - start),
				command,
			});
		};

		const pipeLines = (chunk: Buffer | string, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") stdout += text;
			else stderr += text;
			if (onLine) {
				for (const line of text.split(/\r?\n/)) {
					if (line.trim().length > 0) onLine(line, source);
				}
			}
		};

		proc.stdout?.on("data", (c) => pipeLines(c, "stdout"));
		proc.stderr?.on("data", (c) => pipeLines(c, "stderr"));

		proc.on("error", (err) => {
			finish({ ok: false, stdout, stderr, error: err.message });
		});

		proc.on("close", (code) => {
			finish({
				ok: code === 0,
				stdout,
				stderr,
				error: code === 0 ? undefined : stderr.trim().slice(0, 800) || `installer exited with code ${code}`,
			});
		});

		const timer = setTimeout(
			() => {
				proc.kill("SIGTERM");
				finish({ ok: false, stdout, stderr, error: "install timed out after 5 minutes" });
			},
			5 * 60 * 1000,
		);
	});
}

/**
 * Verify the preset's binary is on PATH; if missing AND an install
 * recipe is configured, run the installer and re-check. Returns true
 * if the binary is callable at the end.
 */
export async function ensureInstalled(
	preset: ExternalAgentPreset,
	onLine?: (line: string, source: "stdout" | "stderr" | "info") => void,
): Promise<boolean> {
	if (isInstalled(preset)) return true;
	if (!preset.install) {
		onLine?.(`${preset.command}: not installed and no auto-install recipe is configured.`, "info");
		return false;
	}
	onLine?.(`${preset.command}: not installed — running ${preset.install.command}`, "info");
	const result = await installAgent(preset, (line, source) => onLine?.(line, source));
	if (!result.ok) {
		onLine?.(`Install failed: ${result.error ?? "unknown error"}`, "info");
		return false;
	}
	const stillThere = isInstalled(preset);
	if (!stillThere) {
		onLine?.(
			`Install reported success but ${preset.command} is still not on $PATH. You may need to open a new shell or add the install dir to PATH.`,
			"info",
		);
	}
	return stillThere;
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
			env: {
				...process.env,
				NO_COLOR: "1",
				FORCE_COLOR: "0",
				// Skip the splash banner when 8gent is invoked nested
				// (the user is in another agent's chat, not our TUI).
				"8GENT_NO_INTRO": "1",
				// Suppress noisy AI SDK warnings that pollute stdout.
				AI_SDK_LOG_WARNINGS: "false",
			},
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
		} else if (proc.stdin) {
			// CLIs like pi, codex check whether stdin is a TTY. With a
			// piped stdin that never closes, they assume more input is
			// coming and hang. Closing stdin immediately tells them to
			// process whatever's already on the command line and exit.
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
