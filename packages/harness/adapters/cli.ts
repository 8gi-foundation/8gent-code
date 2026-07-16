/**
 * CliHarness - generic external-CLI harness adapter (part of #2797).
 *
 * Lets any external coding-agent CLI plug into the meta-harness by spawning
 * it as a scoped subprocess and mapping its stdout/exit status to
 * StatusEvents. This is the "plug in another harness" seam: 8gent stays
 * local-first (8gent-local is the only default), external CLIs register
 * strictly opt-in through EIGHGENT_CLI_HARNESSES.
 *
 * Mapping heuristics (an external CLI has no structured event stream, so
 * states are inferred - honestly - from what the process really does):
 *
 *   | Process signal                    | StatusEvent                        |
 *   | --------------------------------- | ---------------------------------- |
 *   | run accepted                      | queued                             |
 *   | process spawned                   | working (elapsedMs)                |
 *   | stdout/stderr output line         | working (elapsedMs)                |
 *   | line matching needsInputPattern   | needs_input                        |
 *   | exit code 0                       | done + output = captured stdout    |
 *   | non-zero exit                     | error + output = stderr / exit msg |
 *   | spawn failure / timeout           | error                              |
 *
 * Honesty rules: `tokens` and `tool` are NEVER set - an external CLI reports
 * neither real token usage nor structured tool calls, and this adapter does
 * not estimate. `elapsedMs` is real wall clock.
 *
 * Security posture (fail safe, no shell, scoped spawn):
 *   - Bun.spawn with an argv ARRAY, never a shell string: the prompt and all
 *     args travel as single argv elements, shell metacharacters are inert.
 *   - Spawn/config failures never throw out of the stream; they terminate it
 *     with a single error event.
 *   - Every run is bounded by timeoutMs (default 10 minutes); runaway
 *     processes are killed. Abandoned streams kill the child in finally.
 *   - Captured output is tail-capped so a chatty CLI cannot grow memory
 *     without bound.
 *
 * Clean-room: the concept (external agent CLIs as pluggable harnesses) is
 * re-derived from scratch; zero external code copied.
 */

import type { Harness, HarnessTask, StatusEvent } from "../index";

/** Env var holding the opt-in JSON array of CLI harness configs. */
export const CLI_HARNESS_ENV = "EIGHGENT_CLI_HARNESSES";

/** Placeholder arg replaced by the task prompt (as a whole argv element). */
export const PROMPT_PLACEHOLDER = "{prompt}";

/** Default wall-clock bound on a single CLI run. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Keep at most this many characters of captured stdout/stderr (tail). */
const MAX_CAPTURE_CHARS = 256 * 1024;

export interface CliHarnessConfig {
	/** Registry name for this harness, e.g. "codex-cli". */
	name: string;
	/** Executable to spawn. Resolved via PATH or given as an absolute path. */
	command: string;
	/** Fixed argv. A "{prompt}" element is replaced by the task prompt. */
	args?: string[];
	/**
	 * How the prompt reaches the CLI. "arg" (default): substituted for a
	 * "{prompt}" placeholder or appended as the final argv element.
	 * "stdin": written to the child's stdin, which is then closed.
	 */
	promptVia?: "arg" | "stdin";
	/** Output line pattern that means the CLI is waiting on a human. */
	needsInputPattern?: RegExp;
	/** Kill the process and error the stream after this long. Default 10 min. */
	timeoutMs?: number;
	/** Extra environment variables layered over the daemon's environment. */
	env?: Record<string, string>;
}

/**
 * A Harness backed by an arbitrary external CLI. One instance per configured
 * CLI; each run spawns a fresh scoped subprocess.
 */
export class CliHarness implements Harness {
	readonly name: string;
	private readonly config: CliHarnessConfig;

	constructor(config: CliHarnessConfig) {
		if (!config.name?.trim()) throw new Error("CliHarness requires a name");
		if (!config.command?.trim()) throw new Error(`CliHarness ${config.name} requires a command`);
		this.name = config.name;
		this.config = config;
	}

	async *run(task: HarnessTask): AsyncIterable<StatusEvent> {
		const startedAt = Date.now();
		const base = (): Pick<StatusEvent, "agentId" | "harness" | "ts"> => ({
			agentId: task.id,
			harness: this.name,
			ts: Date.now(),
		});
		const elapsed = () => Date.now() - startedAt;

		yield { ...base(), state: "queued" };

		const promptVia = this.config.promptVia ?? "arg";
		const argv = buildArgv(this.config, task.prompt);

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn({
				cmd: argv,
				cwd: task.cwd || process.cwd(),
				stdin: promptVia === "stdin" ? "pipe" : "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ...this.config.env },
			});
		} catch (err) {
			yield {
				...base(),
				state: "error",
				output: `failed to spawn ${this.config.command}: ${err instanceof Error ? err.message : String(err)}`,
				elapsedMs: elapsed(),
			};
			return;
		}

		yield { ...base(), state: "working", elapsedMs: elapsed() };

		// Bridge push-style stream pumps into this pull-style generator.
		const pending: StatusEvent[] = [];
		let wake: (() => void) | null = null;
		const wakeUp = () => {
			const w = wake;
			wake = null;
			w?.();
		};
		const push = (e: StatusEvent) => {
			pending.push(e);
			wakeUp();
		};

		if (promptVia === "stdin" && proc.stdin && typeof proc.stdin !== "number") {
			const writer = proc.stdin;
			writer.write(task.prompt);
			writer.end();
		}

		let stdoutText = "";
		let stderrText = "";
		const pattern = this.config.needsInputPattern;

		const pump = async (
			stream: ReadableStream<Uint8Array> | null | undefined,
			onText: (text: string) => void,
		) => {
			if (!stream) return;
			const decoder = new TextDecoder();
			const reader = stream.getReader();
			let lineBuffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				onText(text);
				lineBuffer = scanLines(lineBuffer + text, (line) => {
					if (pattern?.test(line)) {
						push({ ...base(), state: "needs_input", elapsedMs: elapsed() });
					} else if (line.trim().length > 0) {
						push({ ...base(), state: "working", elapsedMs: elapsed() });
					}
				});
			}
		};

		const pumps = Promise.allSettled([
			pump(proc.stdout as ReadableStream<Uint8Array>, (t) => {
				stdoutText = capTail(stdoutText + t);
			}),
			pump(proc.stderr as ReadableStream<Uint8Array>, (t) => {
				stderrText = capTail(stderrText + t);
			}),
		]);

		const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// Already gone - nothing to kill.
			}
		}, timeoutMs);

		try {
			// Signal used to break the drain loop once the process fully ends.
			let exitCode: number | null = null;
			let finished = false;
			void (async () => {
				exitCode = await proc.exited;
				await pumps; // Flush remaining output before terminal event.
				finished = true;
				wakeUp();
			})();

			while (true) {
				while (pending.length > 0) {
					const next = pending.shift();
					if (next) yield next;
				}
				if (finished) break;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
			while (pending.length > 0) {
				const next = pending.shift();
				if (next) yield next;
			}

			const elapsedMs = elapsed();
			if (timedOut) {
				yield {
					...base(),
					state: "error",
					output: `${this.config.command} timed out after ${timeoutMs}ms and was killed`,
					elapsedMs,
				};
			} else if (exitCode === 0) {
				yield { ...base(), state: "done", output: stdoutText.trim(), elapsedMs };
			} else {
				const detail = stderrText.trim() || stdoutText.trim();
				yield {
					...base(),
					state: "error",
					output: detail
						? `${this.config.command} exited with code ${exitCode}: ${detail}`
						: `${this.config.command} exited with code ${exitCode}`,
					elapsedMs,
				};
			}
			settled = true;
		} finally {
			clearTimeout(timer);
			if (!settled) {
				// Consumer abandoned the stream: do not leave the child running.
				try {
					proc.kill();
				} catch {
					// Already gone.
				}
			}
		}
	}
}

/** Build the argv array. The prompt is always a single argv element. */
function buildArgv(config: CliHarnessConfig, prompt: string): string[] {
	const args = config.args ?? [];
	if ((config.promptVia ?? "arg") === "stdin") {
		return [config.command, ...args];
	}
	if (args.includes(PROMPT_PLACEHOLDER)) {
		return [config.command, ...args.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a))];
	}
	return [config.command, ...args, prompt];
}

/** Invoke onLine per complete line; return the trailing partial line. */
function scanLines(buffer: string, onLine: (line: string) => void): string {
	const lines = buffer.split("\n");
	const partial = lines.pop() ?? "";
	for (const line of lines) onLine(line);
	return partial;
}

function capTail(text: string): string {
	return text.length > MAX_CAPTURE_CHARS ? text.slice(-MAX_CAPTURE_CHARS) : text;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => typeof v === "string")
	);
}

/**
 * Parse the EIGHGENT_CLI_HARNESSES JSON array. Fail safe: anything invalid
 * (bad JSON, non-array, malformed entries, uncompilable patterns) is skipped
 * rather than throwing - a misconfigured entry must never take the daemon
 * down or register a half-valid harness.
 */
export function parseCliHarnessConfigs(raw: string | undefined): CliHarnessConfig[] {
	if (!raw?.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const configs: CliHarnessConfig[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.name !== "string" || !e.name.trim()) continue;
		if (typeof e.command !== "string" || !e.command.trim()) continue;
		if (e.args !== undefined && !isStringArray(e.args)) continue;
		if (e.promptVia !== undefined && e.promptVia !== "arg" && e.promptVia !== "stdin") continue;
		if (e.timeoutMs !== undefined && typeof e.timeoutMs !== "number") continue;
		if (e.env !== undefined && !isStringRecord(e.env)) continue;

		let needsInputPattern: RegExp | undefined;
		if (e.needsInputPattern !== undefined) {
			if (typeof e.needsInputPattern !== "string") continue;
			try {
				needsInputPattern = new RegExp(e.needsInputPattern, "i");
			} catch {
				continue;
			}
		}

		configs.push({
			name: e.name,
			command: e.command,
			args: e.args as string[] | undefined,
			promptVia: e.promptVia as "arg" | "stdin" | undefined,
			needsInputPattern,
			timeoutMs: e.timeoutMs as number | undefined,
			env: e.env as Record<string, string> | undefined,
		});
	}
	return configs;
}

/**
 * Opt-in registration: read CLI harness configs from the environment and
 * register them. No env var = no external harnesses (local-first default is
 * untouched). Entries that fail to register (e.g. a name collision with
 * 8gent-local or another entry) are skipped. Returns the registered names.
 */
export function registerCliHarnessesFromEnv(
	registry: { register(h: Harness): void; list(): string[] },
	env: Record<string, string | undefined> = process.env,
): string[] {
	const registered: string[] = [];
	for (const config of parseCliHarnessConfigs(env[CLI_HARNESS_ENV])) {
		try {
			registry.register(new CliHarness(config));
			registered.push(config.name);
		} catch {
			// Fail safe: a bad entry never blocks the rest or the daemon boot.
		}
	}
	return registered;
}
