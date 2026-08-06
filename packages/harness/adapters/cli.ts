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
 *   | stdout/stderr output line         | working (throttled, elapsedMs)     |
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
 *   - spawn with an argv ARRAY, never a shell string: the prompt and all
 *     args travel as single argv elements, shell metacharacters are inert.
 *   - Spawn/config failures never throw out of the stream; they terminate it
 *     with a single error event.
 *   - The child runs in its OWN process group (detached). Every kill targets
 *     the whole group, so wrapper scripts cannot leave grandchildren behind
 *     (#2806). Timeout kills escalate SIGTERM -> SIGKILL, so a child that
 *     traps SIGTERM still dies (#2806).
 *   - run() always terminates within a bounded window: after the child
 *     exits, output flushing is given a bounded grace period, then any
 *     descendant still holding the stdout/stderr pipes open is group-killed
 *     and the pipes are severed - an orphaned grandchild can never deadlock
 *     the generator (#2806).
 *   - From the moment the process is spawned, ONE try/finally guards every
 *     yield point: abandoning the stream anywhere kills the process group
 *     (#2807).
 *   - needsInputPattern is a TRUST BOUNDARY: the pattern comes from operator
 *     config but is tested against untrusted CLI output. The probe is
 *     length-capped and time-budgeted; a pattern that blows the budget
 *     (catastrophic backtracking) disables itself for the rest of the run
 *     instead of stalling the daemon's event loop (#2808).
 *   - Per-line "working" events are throttled so a chatty CLI cannot flood
 *     task buffers or SSE subscribers (#2810). Captured output is
 *     tail-capped so it cannot grow memory without bound.
 *
 * needs_input delivery (#2809): when needsInputPattern is configured the
 * child's stdin is kept OPEN for the whole run, and respond(taskId, input)
 * writes a follow-up line to it - surfaced upstream as
 * HarnessRunner.respond() and POST /harness/respond. Without a
 * needsInputPattern the old contract is unchanged (stdin is closed after the
 * initial prompt, or ignored entirely for promptVia "arg").
 *
 * Clean-room: the concept (external agent CLIs as pluggable harnesses) is
 * re-derived from scratch; zero external code copied.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Harness, HarnessTask, StatusEvent } from "../index";

/** Env var holding the opt-in JSON array of CLI harness configs. */
export const CLI_HARNESS_ENV = "EIGHGENT_CLI_HARNESSES";

/** Placeholder arg replaced by the task prompt (as a whole argv element). */
export const PROMPT_PLACEHOLDER = "{prompt}";

/** Default wall-clock bound on a single CLI run. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Keep at most this many characters of captured stdout/stderr (tail). */
const MAX_CAPTURE_CHARS = 256 * 1024;

/** Grace between SIGTERM and the SIGKILL escalation on timeout (#2806). */
const KILL_GRACE_MS = 750;

/**
 * After the child exits, how long output flushing may take before any
 * pipe-holding descendants are group-killed and the pipes severed (#2806).
 */
const FLUSH_GRACE_MS = 1_000;

/**
 * needsInputPattern probe guards (#2808). The pattern exists to match short
 * interactive markers like "[y/N]", so only a bounded prefix of each line is
 * tested, and a probe that blows the time budget (catastrophic backtracking)
 * disables the pattern for the rest of the run - fail safe, never stall.
 */
const NEEDS_INPUT_SCAN_WINDOW = 256;
const NEEDS_INPUT_BUDGET_MS = 25;

/** Emit at most one per-line "working" event per this window (#2810). */
const WORKING_EVENT_MIN_INTERVAL_MS = 50;

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
	 * "stdin": written to the child's stdin, which is then closed (unless a
	 * needsInputPattern keeps the stdin channel open, see below).
	 */
	promptVia?: "arg" | "stdin";
	/**
	 * Output line pattern that means the CLI is waiting on a human.
	 * TRUST BOUNDARY: tested against untrusted CLI output - probes are
	 * length-capped and time-budgeted (#2808). Configuring a pattern also
	 * keeps the child's stdin open so respond() can deliver an answer
	 * (#2809).
	 */
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
	private readonly pattern?: RegExp;
	/** Open stdin channels of in-flight interactive runs, by task id. */
	private readonly stdinByTask = new Map<string, Writable>();

	constructor(config: CliHarnessConfig) {
		if (!config.name?.trim()) throw new Error("CliHarness requires a name");
		if (!config.command?.trim()) throw new Error(`CliHarness ${config.name} requires a command`);
		this.name = config.name;
		this.config = config;
		// Strip stateful flags (g/y make .test() carry lastIndex between lines).
		this.pattern = config.needsInputPattern
			? new RegExp(config.needsInputPattern.source, config.needsInputPattern.flags.replace(/[gy]/g, ""))
			: undefined;
	}

	/**
	 * Deliver a follow-up input line to a running task's stdin (#2809). Only
	 * possible while the task is in flight AND a needsInputPattern was
	 * configured (which keeps stdin open). Returns false when undeliverable.
	 */
	respond(taskId: string, input: string): boolean {
		const stdin = this.stdinByTask.get(taskId);
		if (!stdin || stdin.destroyed || !stdin.writable) return false;
		try {
			stdin.write(input.endsWith("\n") ? input : `${input}\n`);
			return true;
		} catch {
			return false;
		}
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
		const interactive = Boolean(this.pattern);
		const argv = buildArgv(this.config, task.prompt);

		let child: ChildProcess;
		try {
			child = spawn(argv[0] as string, argv.slice(1), {
				cwd: task.cwd || process.cwd(),
				env: { ...process.env, ...this.config.env },
				// Own process group so kills reach the WHOLE tree (#2806).
				detached: process.platform !== "win32",
				stdio: [interactive || promptVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
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

		// From here on the process may be running: ONE try/finally guards every
		// yield point so an abandoned stream always kills the group (#2807).
		let settled = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const killTree = (signal: NodeJS.Signals) => {
			const pid = child.pid;
			try {
				if (pid && pid > 0 && process.platform !== "win32") {
					process.kill(-pid, signal); // whole process group
					return;
				}
			} catch {
				// Group already gone or not a group leader - fall through.
			}
			try {
				child.kill(signal);
			} catch {
				// Already gone - nothing to kill.
			}
		};
		const severPipes = () => {
			try {
				child.stdout?.destroy();
			} catch {}
			try {
				child.stderr?.destroy();
			} catch {}
		};

		try {
			// node:child_process reports missing executables asynchronously.
			const spawnError = await new Promise<Error | null>((resolve) => {
				child.once("spawn", () => resolve(null));
				child.once("error", (err) => resolve(err));
			});
			if (spawnError) {
				yield {
					...base(),
					state: "error",
					output: `failed to spawn ${this.config.command}: ${spawnError.message}`,
					elapsedMs: elapsed(),
				};
				settled = true;
				return;
			}
			// Late errors (e.g. EPIPE on kill) must never crash the daemon.
			child.on("error", () => {});

			const exited = new Promise<number | null>((resolve) => {
				child.once("exit", (code) => resolve(code));
			});

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

			if (child.stdin) {
				if (interactive) this.stdinByTask.set(task.id, child.stdin);
				if (promptVia === "stdin") {
					child.stdin.write(task.prompt);
					// Keep stdin open for respond() when a pattern is configured.
					if (!interactive) child.stdin.end();
				}
			}

			let stdoutText = "";
			let stderrText = "";

			// #2808: bounded, self-disabling needs_input probe.
			let patternDisabled = false;
			const matchesNeedsInput = (line: string): boolean => {
				if (!this.pattern || patternDisabled) return false;
				const candidate =
					line.length > NEEDS_INPUT_SCAN_WINDOW ? line.slice(0, NEEDS_INPUT_SCAN_WINDOW) : line;
				const probeStart = performance.now();
				let matched = false;
				try {
					matched = this.pattern.test(candidate);
				} catch {
					patternDisabled = true;
					return false;
				}
				if (performance.now() - probeStart > NEEDS_INPUT_BUDGET_MS) {
					// Catastrophic backtracking: never probe again this run.
					patternDisabled = true;
				}
				return matched;
			};

			// #2810: throttle per-line working events at the source.
			let lastWorkingPushAt = 0;
			const handleLine = (line: string) => {
				if (matchesNeedsInput(line)) {
					push({ ...base(), state: "needs_input", elapsedMs: elapsed() });
				} else if (line.trim().length > 0) {
					const now = Date.now();
					if (now - lastWorkingPushAt >= WORKING_EVENT_MIN_INTERVAL_MS) {
						lastWorkingPushAt = now;
						push({ ...base(), state: "working", elapsedMs: elapsed() });
					}
				}
			};

			const pump = async (stream: Readable | null, onText: (text: string) => void) => {
				if (!stream) return;
				stream.setEncoding("utf8");
				let lineBuffer = "";
				try {
					for await (const chunk of stream as AsyncIterable<string>) {
						const text = String(chunk);
						onText(text);
						lineBuffer = scanLines(lineBuffer + text, handleLine);
					}
				} catch {
					// Pipe severed during teardown - treated as EOF.
				}
			};

			const pumps = Promise.allSettled([
				pump(child.stdout, (t) => {
					stdoutText = capTail(stdoutText + t);
				}),
				pump(child.stderr, (t) => {
					stderrText = capTail(stderrText + t);
				}),
			]);

			const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			let timedOut = false;
			timers.push(
				setTimeout(() => {
					timedOut = true;
					killTree("SIGTERM");
					// #2806: escalate - a child trapping SIGTERM still dies.
					timers.push(
						setTimeout(() => {
							killTree("SIGKILL");
						}, KILL_GRACE_MS),
					);
				}, timeoutMs),
			);

			// Signal used to break the drain loop once the process fully ends.
			let exitCode: number | null = null;
			let finished = false;
			void (async () => {
				exitCode = await exited;
				// #2806: bound the flush. A grandchild that inherited the pipes
				// would otherwise hold them open forever and deadlock run().
				const flushed = await Promise.race([
					pumps.then(() => true),
					new Promise<boolean>((resolve) => {
						timers.push(setTimeout(() => resolve(false), FLUSH_GRACE_MS));
					}),
				]);
				if (!flushed) {
					killTree("SIGKILL"); // descendants still holding the pipes
					severPipes();
					await pumps;
				}
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
				const exitLabel =
					exitCode === null
						? `${this.config.command} was terminated by a signal`
						: `${this.config.command} exited with code ${exitCode}`;
				yield {
					...base(),
					state: "error",
					output: detail ? `${exitLabel}: ${detail}` : exitLabel,
					elapsedMs,
				};
			}
			settled = true;
		} finally {
			for (const timer of timers) clearTimeout(timer);
			this.stdinByTask.delete(task.id);
			// Release the stdin fd whether or not it was ever written to
			// (no-op when already ended/ignored).
			try {
				child.stdin?.end();
			} catch {}
			if (!settled) {
				// Consumer abandoned the stream (at ANY yield point after spawn):
				// do not leave the process group running (#2807).
				killTree("SIGTERM");
				killTree("SIGKILL");
				severPipes();
				try {
					child.stdin?.destroy();
				} catch {}
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
