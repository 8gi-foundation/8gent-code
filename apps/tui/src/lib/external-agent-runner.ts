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
 *
 * Resilient install: real-world `/spawn auto-install` hits stale $PATH after
 * `npm -g`, missing brew, EACCES on system Node, profile rc not sourced, and
 * binary names that diverge from package names. The install loop here tries
 * an ordered list of strategies, retries on transient network errors, and
 * post-install searches a comprehensive set of bin dirs (npm prefix, brew
 * prefix, ~/.local/bin, ~/.cargo/bin, etc.) — and self-heals by injecting
 * the discovered dir into the current process's PATH so spawned tabs work
 * without the user editing rc files.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	 *
	 * Multi-strategy: `command` is the primary install command. Optional
	 * `fallbacks` is an ordered list of alternate strategies tried when the
	 * primary fails or completes but leaves no callable binary. Each strategy
	 * may declare a `precheck` (a shell command — strategy is skipped if it
	 * exits non-zero) so e.g. brew-based fallbacks only run on machines that
	 * actually have brew. `hintBins` lists directories the binary may land in
	 * for that strategy, so post-install discovery doesn't depend on $PATH
	 * being refreshed by the user.
	 *
	 * IMPORTANT: only set this for packages we have verified actually
	 * exist with the expected binary. A wrong recipe is worse than no
	 * recipe — it confuses the user with a 404 or, worse, installs the
	 * wrong project under a name-collision.
	 */
	install?: {
		command: string;
		notes?: string;
		precheck?: string;
		hintBins?: string[];
		fallbacks?: InstallStrategy[];
	};
	/** Project documentation URL — surfaced when no install recipe is
	 * available, so the user knows where to find install steps. */
	homepage?: string;
}

export interface InstallStrategy {
	/** Short label used in install logs (e.g. "npm-prefix", "brew", "pipx"). */
	name: string;
	/** Shell command run via `bash -lc`. */
	command: string;
	/** Optional precondition. Strategy is skipped if this exits non-zero. */
	precheck?: string;
	/** Bin directories where this strategy's binary may land. */
	hintBins?: string[];
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
	s.replace(/\[[0-9;?]*[a-zA-Z]/g, "").replace(/\][^]*/g, "");

// Common dirs node-package and Python --user installs land in. Used both for
// post-install discovery and for self-healing the current process's PATH.
const COMMON_BIN_DIRS = [
	"~/.npm-global/bin",
	"~/.local/bin",
	"/usr/local/bin",
	"/opt/homebrew/bin",
	"~/.cargo/bin",
	"~/go/bin",
	"~/.bun/bin",
	"~/.deno/bin",
	"/usr/local/opt/node/bin",
];

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
			// and the user lacks sudo. Binary lands in ~/.npm-global/bin.
			command: "npm install -g --prefix=$HOME/.npm-global @anthropic-ai/claude-code",
			hintBins: ["~/.npm-global/bin"],
			precheck: "command -v npm",
			fallbacks: [
				{
					name: "npm-default-prefix",
					command: "npm install -g @anthropic-ai/claude-code",
					precheck: "command -v npm",
					// `npm config get prefix` is resolved at search time.
					hintBins: ["/usr/local/bin", "/opt/homebrew/bin"],
				},
				{
					name: "brew",
					command: "brew install anthropic-ai/claude/claude-code",
					precheck: "command -v brew",
					hintBins: ["/opt/homebrew/bin", "/usr/local/bin"],
				},
			],
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
			hintBins: ["~/.npm-global/bin"],
			precheck: "command -v npm",
			fallbacks: [
				{
					name: "npm-default-prefix",
					command: "npm install -g @openai/codex",
					precheck: "command -v npm",
					hintBins: ["/usr/local/bin", "/opt/homebrew/bin"],
				},
			],
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
			command:
				"curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --no-venv",
			hintBins: ["~/.local/bin"],
			precheck: "command -v curl",
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
			hintBins: ["~/.npm-global/bin"],
			precheck: "command -v npm",
			fallbacks: [
				{
					name: "npm-default-prefix",
					command: "npm install -g openclaw@latest",
					precheck: "command -v npm",
					hintBins: ["/usr/local/bin", "/opt/homebrew/bin"],
				},
			],
			notes:
				"Binary at ~/.npm-global/bin/openclaw. Add `~/.npm-global/bin` to PATH if needed. After install run `openclaw onboard` outside the TUI to set up the gateway, workspace, and skills.",
		},
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
		homepage: "https://aider.chat",
		install: {
			// pipx isolates aider's deps from the user's site-packages and
			// usually puts the binary in ~/.local/bin without surprises. We
			// prefer it when available; pip --user is the no-pipx fallback.
			command: "pipx install aider-chat",
			hintBins: ["~/.local/bin"],
			precheck: "command -v pipx",
			fallbacks: [
				{
					name: "pip-user",
					command: "python3 -m pip install --user aider-chat",
					precheck: "command -v python3",
					hintBins: ["~/.local/bin"],
				},
				{
					name: "brew",
					command: "brew install aider",
					precheck: "command -v brew",
					hintBins: ["/opt/homebrew/bin", "/usr/local/bin"],
				},
			],
			notes:
				"If `aider` is still not on PATH after install, ensure ~/.local/bin (or the equivalent for your Python) is in your shell's PATH. Then set OPENAI_API_KEY or ANTHROPIC_API_KEY before using it.",
		},
	},
	"8gent": {
		// 8gent inside 8gent. The bidirectional half: our own binary already has
		// `8gent chat <msg>` (pipe-friendly) and `8gent run <prompt>` (one-shot
		// for Orchestra/cmux). Lets the user /spawn 8gent in any 8gent tab.
		id: "8gent",
		label: "8gent (nested)",
		command: "8gent",
		promptMode: "arg",
		args: ["chat"],
		timeoutMs: 180_000,
		parseStdout: stripAnsi,
		homepage: "https://8gent.dev",
		install: {
			// --force overwrites stale `8` / `8gent` / `8gent-code` bin
			// symlinks (npm 9+ EEXIST).
			command:
				"npm install -g --prefix=$HOME/.npm-global @8gi-foundation/8gent-code --force",
			hintBins: ["~/.npm-global/bin"],
			precheck: "command -v npm",
			fallbacks: [
				{
					name: "npm-default-prefix",
					command: "npm install -g @8gi-foundation/8gent-code --force",
					precheck: "command -v npm",
					hintBins: ["/usr/local/bin", "/opt/homebrew/bin"],
				},
			],
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

// ============================================================================
// PATH discovery & self-heal
// ============================================================================

function expandTilde(p: string): string {
	if (p.startsWith("~/") || p === "~") return p.replace(/^~/, homedir());
	return p;
}

/**
 * Resolve dirs that depend on system state (npm prefix, brew prefix, python
 * user-base). Cached for the lifetime of the process — these don't change
 * between strategies and the shell-outs are not free.
 */
let dynamicBinDirsCache: string[] | null = null;
function getDynamicBinDirs(): string[] {
	if (dynamicBinDirsCache) return dynamicBinDirsCache;
	const out: string[] = [];
	const probe = (cmd: string): string => {
		try {
			return execSync(cmd, {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
				shell: "/bin/bash",
			})
				.toString()
				.trim();
		} catch {
			return "";
		}
	};
	const npmPrefix = probe("npm config get prefix 2>/dev/null");
	if (npmPrefix && npmPrefix !== "undefined") out.push(`${npmPrefix}/bin`);
	const brewPrefix = probe("brew --prefix 2>/dev/null");
	if (brewPrefix) out.push(`${brewPrefix}/bin`);
	const pyUserBase = probe("python3 -m site --user-base 2>/dev/null");
	if (pyUserBase) out.push(`${pyUserBase}/bin`);
	const bunInstall = process.env.BUN_INSTALL;
	if (bunInstall) out.push(`${bunInstall}/bin`);
	dynamicBinDirsCache = out;
	return out;
}

function resetDynamicBinDirsCacheForTests(): void {
	dynamicBinDirsCache = null;
}
// Surface for tests; not part of the public API.
export const _internals = { resetDynamicBinDirsCacheForTests };

/**
 * Build the full ordered list of bin dirs to search for `name`. Order:
 *   1. Strategy hint bins (most specific)
 *   2. Common static dirs (~/.npm-global/bin, ~/.local/bin, etc.)
 *   3. Dynamic dirs (npm prefix, brew prefix, python user-base)
 * Existing $PATH entries are excluded — we already covered those via
 * `command -v`.
 */
function buildSearchDirs(extraHints: string[] = []): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];
	const push = (d: string) => {
		const expanded = expandTilde(d);
		if (!expanded || seen.has(expanded)) return;
		seen.add(expanded);
		dirs.push(expanded);
	};
	for (const h of extraHints) push(h);
	for (const d of COMMON_BIN_DIRS) push(d);
	for (const d of getDynamicBinDirs()) push(d);
	return dirs;
}

/**
 * Locate `name` on disk. Returns the absolute path or null. Tries the live
 * shell first (catches anything on $PATH), then walks the comprehensive
 * search dirs. Cheap — no `find` recursion, just direct existsSync probes.
 */
function findBinary(name: string, hints: string[] = []): string | null {
	try {
		const out = execSync(`command -v "${name}"`, {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1500,
			shell: "/bin/bash",
		})
			.toString()
			.trim();
		if (out && existsSync(out)) return out;
	} catch {
		// fallthrough to dir walk
	}
	for (const dir of buildSearchDirs(hints)) {
		const candidate = join(dir, name);
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		} catch {
			// permissions / EACCES on a parent dir — keep going
		}
	}
	return null;
}

/**
 * Inject `dir` at the front of process.env.PATH if not already present.
 * Self-heal so the current process's `spawn` calls find binaries that the
 * user's shell rc hasn't been re-sourced to pick up. Returns true if PATH
 * was actually mutated.
 */
function ensureDirOnPath(dir: string): boolean {
	const sep = process.platform === "win32" ? ";" : ":";
	const current = (process.env.PATH ?? "").split(sep).filter(Boolean);
	if (current.includes(dir)) return false;
	process.env.PATH = [dir, ...current].join(sep);
	return true;
}

/**
 * True if the preset's binary is callable from this process. If the binary
 * exists in a known dir not currently on $PATH, this also patches the
 * process's PATH so subsequent `spawn(preset.command, ...)` calls succeed
 * without the user editing their shell rc. Intentional side effect — the
 * "self-healing" requirement makes implicit PATH mutation the right call.
 */
export function isInstalled(preset: ExternalAgentPreset): boolean {
	const found = findBinary(preset.command, preset.install?.hintBins);
	if (!found) return false;
	const dir = found.slice(0, found.lastIndexOf("/"));
	if (dir) ensureDirOnPath(dir);
	return true;
}

// ============================================================================
// Multi-strategy install
// ============================================================================

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
	/** Discovered absolute path to the binary, if any. */
	resolvedPath?: string;
	/** Name of the strategy that succeeded, if any. */
	strategyUsed?: string;
}

function getStrategies(preset: ExternalAgentPreset): InstallStrategy[] {
	if (!preset.install) return [];
	const { command, precheck, hintBins, fallbacks = [] } = preset.install;
	const primary: InstallStrategy = {
		name: "primary",
		command,
		precheck,
		hintBins,
	};
	return [primary, ...fallbacks];
}

function isTransientError(stderr: string): boolean {
	return /ENETUNREACH|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|fetch failed|socket hang up|registry\.npmjs\.org|gateway timeout|503 Service|504 |network is unreachable/i.test(
		stderr,
	);
}

/**
 * Run a single shell command, streaming output. 5-minute hard cap.
 */
function runShellCommand(
	command: string,
	onLine?: (line: string, source: "stdout" | "stderr") => void,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;

		const proc = spawn("bash", ["-lc", command], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});

		const finish = (r: { ok: boolean; stdout: string; stderr: string; error?: string }) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(r);
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
		proc.on("error", (err) => finish({ ok: false, stdout, stderr, error: err.message }));
		proc.on("close", (code) =>
			finish({
				ok: code === 0,
				stdout,
				stderr,
				error: code === 0 ? undefined : stderr.trim().slice(0, 800) || `installer exited with code ${code}`,
			}),
		);

		const timer = setTimeout(
			() => {
				proc.kill("SIGTERM");
				finish({ ok: false, stdout, stderr, error: "install timed out after 5 minutes" });
			},
			5 * 60 * 1000,
		);
	});
}

function precheckPasses(precheck: string | undefined): boolean {
	if (!precheck) return true;
	try {
		execSync(precheck, {
			stdio: "ignore",
			timeout: 2500,
			shell: "/bin/bash",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Run the preset's install recipe and resolve with the outcome.
 *
 * Tries each strategy in order. For each one:
 *   1. Run `precheck` if present; skip strategy on non-zero.
 *   2. Run the install command. On transient network errors, retry once
 *      after a 2s backoff.
 *   3. Search for the binary across strategy hint bins + common dirs +
 *      dynamic dirs (npm prefix, brew prefix, python user-base).
 *   4. If found in a non-PATH dir, prepend that dir to process.env.PATH.
 *
 * Stops on first strategy that produces a callable binary. If all strategies
 * exhaust, returns ok:false with diagnostics naming the discovered binary
 * location (if any) and the dir to add to PATH manually.
 */
export async function installAgent(
	preset: ExternalAgentPreset,
	onLine?: (line: string, source: "stdout" | "stderr" | "info") => void,
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
	// Reset cache so we re-probe npm prefix / brew prefix / python user-base
	// in case one of the strategies provisioned them in this same call.
	resetDynamicBinDirsCacheForTests();

	const strategies = getStrategies(preset);
	let allStdout = "";
	let allStderr = "";
	let lastError = "";
	let lastCommand = "";

	for (let i = 0; i < strategies.length; i++) {
		const strategy = strategies[i];
		const tag = `${i + 1}/${strategies.length} ${strategy.name}`;
		lastCommand = strategy.command;

		if (!precheckPasses(strategy.precheck)) {
			onLine?.(`Skipping strategy ${tag}: precheck failed (${strategy.precheck})`, "info");
			continue;
		}

		onLine?.(`Trying install strategy ${tag}: ${strategy.command}`, "info");

		let result = await runShellCommand(strategy.command, (line, source) => onLine?.(line, source));
		allStdout += result.stdout;
		allStderr += result.stderr;

		if (!result.ok && isTransientError(result.stderr)) {
			onLine?.(`Strategy ${tag}: transient network error, retrying in 2s...`, "info");
			await new Promise((r) => setTimeout(r, 2000));
			result = await runShellCommand(strategy.command, (line, source) => onLine?.(line, source));
			allStdout += result.stdout;
			allStderr += result.stderr;
		}

		if (!result.ok) {
			lastError = result.error ?? `${strategy.name} failed`;
			onLine?.(`Strategy ${tag} failed: ${lastError}`, "info");
			continue;
		}

		// Reset dyn cache between strategies — npm prefix may have just been created.
		resetDynamicBinDirsCacheForTests();
		const found = findBinary(preset.command, strategy.hintBins);
		if (found) {
			const dir = found.slice(0, found.lastIndexOf("/"));
			const patched = dir ? ensureDirOnPath(dir) : false;
			if (patched) {
				onLine?.(`Found ${preset.command} at ${found}; added ${dir} to PATH for this session.`, "info");
			} else {
				onLine?.(`Found ${preset.command} at ${found}.`, "info");
			}
			return {
				ok: true,
				stdout: allStdout,
				stderr: allStderr,
				durationMs: Math.round(performance.now() - start),
				command: strategy.command,
				resolvedPath: found,
				strategyUsed: strategy.name,
			};
		}

		lastError = `${strategy.name} reported success but ${preset.command} not found in any known bin dir`;
		onLine?.(lastError, "info");
	}

	const diag = buildDiagnostic(preset);
	return {
		ok: false,
		stdout: allStdout,
		stderr: allStderr,
		durationMs: Math.round(performance.now() - start),
		command: lastCommand,
		error: `${lastError || "all install strategies exhausted"}\n${diag}`,
	};
}

/**
 * Build human-readable diagnostics for the all-strategies-failed case.
 * Naming where we looked is the difference between "your install is broken"
 * and "your shell rc didn't pick up the new dir".
 */
function buildDiagnostic(preset: ExternalAgentPreset): string {
	const found = findBinary(preset.command, preset.install?.hintBins);
	if (found) {
		const dir = found.slice(0, found.lastIndexOf("/"));
		return `Binary actually exists at ${found} but its dir is not on $PATH. Run: export PATH="${dir}:$PATH"`;
	}
	const dirs = buildSearchDirs(preset.install?.hintBins ?? []);
	return `Searched: ${dirs.join(", ")}. None contained \`${preset.command}\`. ${preset.install?.notes ?? ""}`.trim();
}

/**
 * Verify the preset's binary is on PATH; if missing AND an install
 * recipe is configured, run the multi-strategy installer and re-check.
 * Returns true if the binary is callable at the end.
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
	const strategies = getStrategies(preset);
	onLine?.(
		`${preset.command}: not installed — running ${strategies.length} install strategy${strategies.length === 1 ? "" : " in order"}.`,
		"info",
	);
	const result = await installAgent(preset, onLine);
	if (result.ok) return true;
	onLine?.(`Install failed: ${result.error ?? "unknown error"}`, "info");
	// Final long-shot: maybe the binary is there but our cached search missed
	// it (e.g. dynamic dirs changed mid-run). Re-run isInstalled which also
	// self-heals PATH.
	return isInstalled(preset);
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
