/**
 * Host-CLI delegation provider (generic).
 *
 * Shells out to a user-configured host binary, reuses the caller's existing
 * session on that host as routable compute for 8gent, and surfaces the
 * completion text. Opt-in only: gated behind `PROVIDERS_ALLOW_HOST_CLI=1`
 * and the presence of the configured binary on PATH.
 *
 * One adapter, many binaries. Users bind their chosen CLIs via env config
 * (see `PROVIDERS_HOST_CLI_PRIMARY_BINARY` / `_SECONDARY_BINARY` in
 * `index.ts`). No binary names are hardcoded in this file.
 *
 * Not a streaming-protocol shim: we surface completion text first. Tool
 * calls, thinking blocks, and interactive sessions are a follow-up.
 *
 * Security: honours `packages/permissions/policy-engine.ts`. The full
 * invocation is evaluated as a `run_command` action so existing deny rules
 * apply. The caller still owns any session credentials on the host; 8gent
 * never touches them.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { LLMClient, LLMResponse, Message } from "../eight/types.js";
import { evaluatePolicy } from "../permissions/policy-engine.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Resolve a binary to an absolute path by scanning PATH. Returns null if missing. */
function resolveOnPath(binary: string): string | null {
	if (isAbsolute(binary)) return existsSync(binary) ? binary : null;
	const dirs = (process.env.PATH || "").split(delimiter);
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = join(dir, binary);
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* ignore */
		}
	}
	return null;
}

/**
 * Describes how to invoke a given host CLI. Two knobs matter: how to turn
 * a prompt into argv, and how to recognise rate-limit / auth-failure exits.
 * Everything else is generic.
 */
export interface HostCliBinarySpec {
	/** Binary name or absolute path. Resolved via PATH when not absolute. */
	binary: string;
	/**
	 * Build argv from a single concatenated prompt string. Defaults to
	 * `["-p", prompt]`. Override for binaries that expect a positional
	 * subcommand (e.g. `exec <prompt>`) or a different flag name.
	 */
	buildArgs?: (prompt: string, extraArgs: string[]) => string[];
	/**
	 * Non-zero exit code that should be treated as a rate limit. Some CLIs
	 * map 429 to a small integer (e.g. 7) rather than preserving it.
	 */
	rateLimitExitCode?: number;
	/** Stderr substring/regex hint that indicates a rate limit. */
	rateLimitStderrPattern?: RegExp;
	/** Stderr substring/regex hint that indicates an auth failure. */
	authFailureStderrPattern?: RegExp;
}

export interface HostCliClientOptions {
	spec: HostCliBinarySpec;
	/** Human-friendly model label returned in the response. Default: `host-cli`. */
	model?: string;
	/** Max wall time per invocation. Defaults to 120s. */
	timeoutMs?: number;
	/** Override working directory. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Additional argv passed through (e.g. `["--no-color"]`). */
	extraArgs?: string[];
}

export interface HostCliAvailability {
	available: boolean;
	reason?: string;
	binary?: string;
}

export class HostCliUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostCliUnavailableError";
	}
}

export class HostCliRateLimitError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
	) {
		super(message);
		this.name = "HostCliRateLimitError";
	}
}

/**
 * Opt-in check. Env-var gate first, then binary presence. Never throws:
 * returns `{available: false}` so callers can skip this provider in the
 * failover chain cleanly.
 */
export function checkHostCliAvailability(binary: string): HostCliAvailability {
	if (process.env.PROVIDERS_ALLOW_HOST_CLI !== "1") {
		return {
			available: false,
			reason: "PROVIDERS_ALLOW_HOST_CLI is not set to 1 (opt-in required).",
		};
	}
	if (!binary) {
		return {
			available: false,
			reason: "No host CLI binary configured for this slot.",
		};
	}
	const resolved = resolveOnPath(binary);
	if (!resolved) {
		return {
			available: false,
			reason: `\`${binary}\` not found on PATH. Install the host CLI and authenticate it first.`,
		};
	}
	return { available: true, binary: resolved };
}

function flatten(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** Concatenate chat history into a single prompt for CLI mode. */
function buildPrompt(messages: Message[]): string {
	return messages
		.map((m) => {
			const body = flatten(m.content);
			if (m.role === "system") return `[system]\n${body}`;
			if (m.role === "assistant") return `[assistant]\n${body}`;
			return body;
		})
		.join("\n\n");
}

function defaultBuildArgs(prompt: string, extraArgs: string[]): string[] {
	return ["-p", prompt, ...extraArgs];
}

/**
 * Generic host-CLI delegation client. Conforms to the `LLMClient` shape
 * expected by `packages/eight/clients` so it can be slotted in anywhere
 * a runtime client is consumed.
 *
 * The binary-specific behaviour lives in `HostCliBinarySpec` so the same
 * class serves any CLI that can be driven non-interactively.
 */
export class HostCliClient implements LLMClient {
	private readonly spec: HostCliBinarySpec;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly cwd: string;
	private readonly extraArgs: string[];

	constructor(opts: HostCliClientOptions) {
		this.spec = opts.spec;
		this.model = opts.model ?? "host-cli";
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.cwd = opts.cwd ?? process.cwd();
		this.extraArgs = opts.extraArgs ?? [];
	}

	async isAvailable(): Promise<boolean> {
		return checkHostCliAvailability(this.spec.binary).available;
	}

	async chat(messages: Message[], _tools?: object[]): Promise<LLMResponse> {
		const avail = checkHostCliAvailability(this.spec.binary);
		if (!avail.available) {
			throw new HostCliUnavailableError(avail.reason ?? "unavailable");
		}

		const prompt = buildPrompt(messages);

		// Policy gate: the full invocation is evaluated as `run_command` so
		// existing deny rules (no git push, no secret exfil, etc.) apply.
		const invocation = `${this.spec.binary} ${this.extraArgs.join(" ")}`.trim();
		const decision = evaluatePolicy("run_command", { command: invocation });
		if (!decision.allowed) {
			throw new Error(
				`Policy blocked host-CLI delegation: ${decision.reason ?? "denied"}`,
			);
		}

		// Non-interactive invocation. Stdin is closed so the CLI does not hang
		// on an open tty. We use the resolved absolute path so spawn does not
		// re-scan PATH.
		const binaryPath = avail.binary ?? this.spec.binary;
		const buildArgs = this.spec.buildArgs ?? defaultBuildArgs;
		const args = buildArgs(prompt, this.extraArgs);
		const result = spawnSync(binaryPath, args, {
			cwd: this.cwd,
			encoding: "utf-8",
			timeout: this.timeoutMs,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new HostCliUnavailableError(
					`Host CLI \`${this.spec.binary}\` disappeared between availability check and spawn (ENOENT).`,
				);
			}
			throw new Error(
				`Host CLI invocation failed (${this.spec.binary}): ${result.error.message}`,
			);
		}

		if (result.status !== 0) {
			const stderr = (result.stderr || "").trim();
			const exit = result.status ?? -1;

			// Rate limit surfaces via a CLI-specific exit code or a stderr hint.
			const isRateLimit =
				(this.spec.rateLimitExitCode !== undefined &&
					exit === this.spec.rateLimitExitCode) ||
				exit === 429 ||
				(this.spec.rateLimitStderrPattern?.test(stderr) ?? false) ||
				/rate[- ]?limit|quota/i.test(stderr);
			if (isRateLimit) {
				throw new HostCliRateLimitError(
					`Host CLI rate-limited (${this.spec.binary}, exit ${exit}): ${stderr}`,
					exit,
				);
			}

			// Auth failure: surface as Unavailable so failover can skip this slot
			// rather than retry indefinitely.
			const isAuthFailure =
				(this.spec.authFailureStderrPattern?.test(stderr) ?? false) ||
				/login|auth|unauthori[sz]ed/i.test(stderr);
			if (isAuthFailure) {
				throw new HostCliUnavailableError(
					`Host CLI not authenticated (${this.spec.binary}). Complete login on the host and retry. stderr: ${stderr}`,
				);
			}

			throw new Error(
				`Host CLI (${this.spec.binary}) exited with ${exit}: ${stderr || "(no stderr)"}`,
			);
		}

		const content = (result.stdout || "").trim();
		return {
			model: this.model,
			message: { role: "assistant", content },
			done: true,
		};
	}

	async generate(prompt: string): Promise<string> {
		const response = await this.chat([{ role: "user", content: prompt }]);
		return flatten(response.message.content);
	}
}
