/**
 * 8gent Code - one-file extensions (G1).
 *
 * An extension is a single TypeScript (or JavaScript) file in
 * ~/.8gent/extensions/. No manifest, no build step: Bun imports the file as it
 * is. Its default export receives an API object:
 *
 *   export default function (api) {
 *     api.registerTool({ name: "word_count", description: "...", parameters: {...},
 *       execute: async ({ text }) => String(String(text).split(/\s+/).length) });
 *     api.registerCommand({ name: "hello", description: "Say hi", run: (args) => `hi ${args}` });
 *     api.on("tool_call", (e) => e.toolName === "run_command" && String(e.args.command).includes("rm -rf")
 *       ? { block: true, reason: "no recursive deletes here" } : undefined);
 *   }
 *
 * The file needs no imports; the types below (ExtensionAPI) are for editors.
 *
 * Plugs (the name for extensions here) can listen to six events, each handler
 * called as (event, ctx) with ctx.cwd, ctx.hasUI and ctx.ui.confirm/select:
 *   tool_call     { block, reason } refuses; { args } changes the arguments
 *   tool_result   { result } rewrites what the model sees
 *   input         { text } rewrites what the person typed
 *   turn_start, turn_end, session_start   notifications
 * Without a person at the keyboard, ctx.ui.confirm is No and ctx.ui.select is
 * no choice. A handler on any event except tool_call that throws or is slow is
 * skipped and logged; a tool_call handler that does refuses the call.
 *
 * Safety: a tool_call handler can only make a call stricter (refuse it, or
 * change its arguments, which the policy checks again). Nothing a plug returns
 * can allow a call the mode, a hook or the permission policy refused, because
 * the executor asks the host only after the policy has allowed the call. Each
 * handler gets a frozen copy of the call; one that throws or takes longer
 * than HANDLER_TIMEOUT_MS refuses the call (fail closed). Extension tools run
 * through the agent's executor like built-ins and cannot take a built-in
 * name or a reserved prefix (mcp__, term_, git_, desktop_, browser_); commands cannot take a
 * built-in slash command. The agent loads extensions only when its host opts
 * in, and never in a no-tool or Table session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** JSON Schema for a tool's arguments (an object schema). */
export interface ExtensionToolParameters {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
}

export interface ExtensionContext {
	/** The working directory of the session the call belongs to. */
	cwd: string;
}

export interface ExtensionTool {
	name: string;
	description: string;
	parameters: ExtensionToolParameters;
	execute: (args: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
}

export interface ExtensionCommand {
	/** Typed as /name. */
	name: string;
	description?: string;
	/** Gets the text after /name. A returned string is shown to the person. */
	run: (args: string, ctx: ExtensionContext) => string | undefined | Promise<string | undefined>;
}

export interface ToolCallEvent {
	toolName: string;
	args: Record<string, unknown>;
}

/**
 * Return { block: true } to refuse the call, or { args } to run it with other
 * arguments (the changed call goes through the permission policy again).
 * Anything else lets it through. Nothing here can allow what policy denied.
 */
export type ToolCallDecision =
	| { block: true; reason?: string }
	| { args: Record<string, unknown> }
	| Nothing;

/** A handler that returns nothing lets the event through. */
// biome-ignore lint/suspicious/noConfusingVoidType: a plain `() => {}` handler must type-check
type Nothing = undefined | void;

export interface ToolResultEvent {
	toolName: string;
	args: Record<string, unknown>;
	result: string;
}

/** Return { result } to replace what the model sees. */
export type ToolResultDecision = { result: string } | Nothing;

export interface InputEvent {
	text: string;
}

/** Return { text } to replace what the person typed before the turn starts. */
export type InputDecision = { text: string } | Nothing;

export interface TurnStartEvent {
	text: string;
}

export interface TurnEndEvent {
	text: string;
	reply?: string;
}

export interface SessionStartEvent {
	cwd: string;
}

/** What a plug can ask the owner. Unattended, or without a UI, confirm is false and select is undefined. */
export interface PlugUI {
	confirm(message: string, opts?: { title?: string }): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
}

/** The person-facing channel behind PlugUI, supplied by the 8gent that owns the host. */
export interface PlugUIProvider {
	/** True only when a person is at the keyboard and can answer. */
	attended(): boolean;
	confirm?(message: string, opts?: { title?: string }): Promise<boolean>;
	select?(title: string, options: string[]): Promise<string | undefined>;
}

export interface PlugContext extends ExtensionContext {
	hasUI: boolean;
	ui: PlugUI;
}

export type PlugEventName =
	| "tool_call"
	| "tool_result"
	| "input"
	| "turn_start"
	| "turn_end"
	| "session_start";

const PLUG_EVENTS = new Set<string>([
	"tool_call",
	"tool_result",
	"input",
	"turn_start",
	"turn_end",
	"session_start",
]);

type Maybe<T> = T | Promise<T>;

export interface ExtensionAPI {
	registerTool(tool: ExtensionTool): void;
	registerCommand(command: ExtensionCommand): void;
	on(
		event: "tool_call",
		handler: (e: ToolCallEvent, ctx: PlugContext) => Maybe<ToolCallDecision>,
	): void;
	on(
		event: "tool_result",
		handler: (e: ToolResultEvent, ctx: PlugContext) => Maybe<ToolResultDecision>,
	): void;
	on(event: "input", handler: (e: InputEvent, ctx: PlugContext) => Maybe<InputDecision>): void;
	on(event: "turn_start", handler: (e: TurnStartEvent, ctx: PlugContext) => Maybe<void>): void;
	on(event: "turn_end", handler: (e: TurnEndEvent, ctx: PlugContext) => Maybe<void>): void;
	on(
		event: "session_start",
		handler: (e: SessionStartEvent, ctx: PlugContext) => Maybe<void>,
	): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

/** Identity helper so an extension file gets types without importing anything else. */
export function defineExtension(factory: ExtensionFactory): ExtensionFactory {
	return factory;
}

export interface ExtensionLoadResult {
	file: string;
	ok: boolean;
	error?: string;
	tools: string[];
	commands: string[];
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EXTENSIONS = new Set([".ts", ".js", ".mjs", ".mts"]);
/**
 * Tool name prefixes that belong to built-in families (MCP, terminal, git,
 * desktop, browser). The executor gives those families their own policy
 * class by name, so an extension tool there would escape extension_call.
 */
export const RESERVED_TOOL_PREFIXES = ["mcp__", "term_", "git_", "desktop_", "browser_"];
/** A tool_call handler that takes longer than this refuses the call. */
export const HANDLER_TIMEOUT_MS = 2000;
/**
 * Built-in slash command names an extension command may not take. Kept in
 * step with the SlashCommand union in apps/tui/src/lib/slash-commands.ts by
 * host.test.ts.
 */
export const RESERVED_COMMANDS = new Set(
	`help kanban predict avenues clear quit plan status model provider apikeys llama models voice theme infinite
onboarding preferences skip animations adhd quarantine toolshed skills design evidence auth vision session sessions
resume history continue compact chat agent github debug music dj pet export fork rewind durable branch cron deploy
vercel telegram router rename spawn settings quiet term create-app hands eyes handeyes goal subgoal build
notes ideas btw questions projects terminal reload exit
copy out hotkeys tree import update route privacy consult bug me allow-read mode herdr
stack judge local context ctx thinking scoped-models think scoped scope bring-it-home bringithome control loops changelog`.split(
		/\s+/,
	),
);

/** The default extensions folder: ~/.8gent/extensions. Throws without an absolute home directory. */
export function defaultExtensionsDir(): string {
	const home = os.homedir();
	if (!home || !path.isAbsolute(home)) {
		throw new Error(`no absolute home directory (got "${home}"); not loading extensions`);
	}
	return path.join(home, ".8gent", "extensions");
}

type Handler = (e: never, ctx: PlugContext) => unknown;

interface PlugHandler {
	event: PlugEventName;
	fn: Handler;
}

interface Registered<T> {
	value: T;
	file: string;
}

/** What one file registered: staged, then swapped in as a whole. */
interface FileRegistration {
	tools: ExtensionTool[];
	commands: ExtensionCommand[];
	handlers: PlugHandler[];
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
	}
	return value;
}

export class ExtensionHost {
	private tools = new Map<string, Registered<ExtensionTool>>();
	private commands = new Map<string, Registered<ExtensionCommand>>();
	private handlers: Array<Registered<PlugHandler>> = [];
	private results: ExtensionLoadResult[] = [];
	/** The last good registration of each file, by real path. */
	private byFile = new Map<string, FileRegistration>();
	private uiProvider: PlugUIProvider | null = null;
	private log: (line: string) => void = (line) => console.warn(line);
	private skips: string[] = [];

	/**
	 * @param dir folder of one-file extensions
	 * @param reserved names an extension tool may not take (the built-in tools)
	 * @param handlerTimeoutMs how long a tool_call handler may take before the call is refused
	 */
	constructor(
		private readonly dir: string = defaultExtensionsDir(),
		private readonly reserved: () => Iterable<string> = () => [],
		private readonly handlerTimeoutMs: number = HANDLER_TIMEOUT_MS,
	) {}

	/** One-file extensions in the folder (real paths), sorted so load order is stable. */
	files(): string[] {
		if (!fs.existsSync(this.dir)) return [];
		return fs
			.readdirSync(this.dir, { withFileTypes: true })
			.filter(
				(e) =>
					(e.isFile() || e.isSymbolicLink()) &&
					EXTENSIONS.has(path.extname(e.name)) &&
					!e.name.endsWith(".d.ts"),
			)
			.map((e) => path.join(this.dir, e.name))
			.filter((f) => {
				try {
					return fs.statSync(f).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	}

	/**
	 * Load every extension (this is also reload, D12). Everything is imported
	 * and registered into new maps first; the live maps are swapped in one step
	 * only after every import settled, so a tool_call block is never missing
	 * while a reload runs. A file that fails to load keeps only the tool_call
	 * handlers of its last good version (they can only refuse), not its tools
	 * or commands, and its result says "kept previous version of <file>"; a
	 * file that is gone is dropped. The module
	 * cache is cleared by real path first, so an edited file takes effect even
	 * through a symlinked folder.
	 */
	async load(): Promise<ExtensionLoadResult[]> {
		const reserved = new Set(this.reserved());
		const results: ExtensionLoadResult[] = [];
		const next = new Map<string, FileRegistration>();
		for (const listed of this.files()) {
			let real: string;
			try {
				real = fs.realpathSync(listed);
			} catch (err) {
				results.push({ file: listed, ok: false, error: String(err), tools: [], commands: [] });
				continue;
			}
			const { result, reg } = await this.loadFile(real, reserved, next);
			if (reg) {
				next.set(real, reg);
			} else {
				// A broken edit keeps only the old tool_call handlers, which can
				// only refuse; its old tools and commands are dropped.
				const previous = this.byFile.get(real);
				const kept = previous?.handlers.filter((h) => h.event === "tool_call") ?? [];
				if (previous && kept.length > 0) {
					next.set(real, { tools: [], commands: [], handlers: kept });
					result.error = `${result.error}; kept previous version of ${path.basename(real)} (its tool_call checks only; its tools and commands are off until it loads)`;
				}
			}
			results.push(result);
		}
		// One synchronous swap: nothing can observe a half-built set.
		const tools = new Map<string, Registered<ExtensionTool>>();
		const commands = new Map<string, Registered<ExtensionCommand>>();
		const handlers: Array<Registered<PlugHandler>> = [];
		for (const [file, reg] of next) {
			for (const t of reg.tools) tools.set(t.name, { value: t, file });
			for (const c of reg.commands) commands.set(c.name, { value: c, file });
			for (const h of reg.handlers) handlers.push({ value: h, file });
		}
		this.tools = tools;
		this.commands = commands;
		this.handlers = handlers;
		this.byFile = next;
		this.results = results;
		return results;
	}

	private async loadFile(
		file: string,
		reserved: Set<string>,
		taken: Map<string, FileRegistration>,
	): Promise<{ result: ExtensionLoadResult; reg?: FileRegistration }> {
		const result: ExtensionLoadResult = { file, ok: false, tools: [], commands: [] };
		// Staged, so a file that fails halfway registers nothing.
		const reg: FileRegistration = { tools: [], commands: [], handlers: [] };
		const toolTaken = (name: string) =>
			reg.tools.some((x) => x.name === name) ||
			[...taken.values()].some((r) => r.tools.some((x) => x.name === name));
		const commandTaken = (name: string) =>
			reg.commands.some((x) => x.name === name) ||
			[...taken.values()].some((r) => r.commands.some((x) => x.name === name));
		try {
			// Bun keys its module cache by real path and ignores a ?query, so drop
			// the cached copy: an edited file then loads fresh on reload.
			try {
				delete require.cache[file];
			} catch {
				/* no CommonJS cache here: first load only */
			}
			const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
			const factory = mod.default;
			if (typeof factory !== "function") throw new Error("default export is not a function");
			const api: ExtensionAPI = {
				registerTool: (t) => {
					if (!t || typeof t.name !== "string" || !NAME.test(t.name)) {
						throw new Error(`tool name ${JSON.stringify(t?.name)} must match ${NAME}`);
					}
					if (reserved.has(t.name)) throw new Error(`tool "${t.name}" is a built-in tool`);
					const prefix = RESERVED_TOOL_PREFIXES.find((p) => t.name.startsWith(p));
					if (prefix) throw new Error(`tool "${t.name}": the prefix "${prefix}" is reserved`);
					if (toolTaken(t.name)) throw new Error(`tool "${t.name}" is already registered`);
					if (typeof t.execute !== "function") throw new Error(`tool "${t.name}" has no execute`);
					if (t.parameters?.type !== "object") {
						throw new Error(`tool "${t.name}" parameters must be an object schema`);
					}
					reg.tools.push(t);
				},
				registerCommand: (c) => {
					if (!c || typeof c.name !== "string" || !NAME.test(c.name)) {
						throw new Error(`command name ${JSON.stringify(c?.name)} must match ${NAME}`);
					}
					if (RESERVED_COMMANDS.has(c.name)) {
						throw new Error(`command "/${c.name}" is a built-in command`);
					}
					if (commandTaken(c.name)) throw new Error(`command "${c.name}" is already registered`);
					if (typeof c.run !== "function") throw new Error(`command "${c.name}" has no run`);
					reg.commands.push(c);
				},
				on: ((event: string, handler: unknown) => {
					if (!PLUG_EVENTS.has(event)) throw new Error(`unknown event "${event}"`);
					if (typeof handler !== "function") throw new Error(`${event} handler is not a function`);
					reg.handlers.push({ event: event as PlugEventName, fn: handler as Handler });
				}) as ExtensionAPI["on"],
			};
			await factory(api);
		} catch (err) {
			result.error = err instanceof Error ? err.message : String(err);
			return { result };
		}
		result.ok = true;
		result.tools = reg.tools.map((t) => t.name);
		result.commands = reg.commands.map((c) => c.name);
		return { result, reg };
	}

	/** The outcome of the last load, one entry per file. */
	lastLoad(): readonly ExtensionLoadResult[] {
		return this.results;
	}

	listTools(): ExtensionTool[] {
		return [...this.tools.values()].map((r) => r.value);
	}

	getTool(name: string): ExtensionTool | undefined {
		return this.tools.get(name)?.value;
	}

	listCommands(): Array<{ name: string; description: string; file: string }> {
		return [...this.commands.values()].map((r) => ({
			name: r.value.name,
			description: r.value.description ?? "",
			file: r.file,
		}));
	}

	hasCommand(name: string): boolean {
		return this.commands.has(name);
	}

	/** Run /name. Null when no extension registered it. Errors come back as text. */
	async runCommand(name: string, args: string, ctx: ExtensionContext): Promise<string | null> {
		const entry = this.commands.get(name);
		if (!entry) return null;
		try {
			const out = await entry.value.run(args, ctx);
			return typeof out === "string" ? out : "";
		} catch (err) {
			return `/${name} failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** Run an extension tool; the result is always a string for the model. */
	async runTool(
		name: string,
		args: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<string> {
		const entry = this.tools.get(name);
		if (!entry) return `Error: no extension tool "${name}"`;
		try {
			const out = await entry.value.execute(args, ctx);
			return typeof out === "string" ? out : JSON.stringify(out ?? null);
		} catch (err) {
			return `Error running tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** Back ctx.ui with a person-facing channel. Without one, confirm is No and select is no choice. */
	setUI(provider: PlugUIProvider | null): void {
		this.uiProvider = provider;
	}

	/** Where skips and refusals are logged. Default: console.warn. */
	setLog(log: (line: string) => void): void {
		this.log = log;
	}

	/** Every skip and refusal since this host was made, oldest first. */
	skipLog(): readonly string[] {
		return this.skips;
	}

	private note(line: string): void {
		const text = `[plug] ${line}`;
		this.skips.push(text);
		if (this.skips.length > 200) this.skips.shift();
		try {
			this.log(text);
		} catch {
			/* a broken logger never breaks a turn */
		}
	}

	/**
	 * Run one handler with its own frozen event and a context. The time a
	 * handler spends waiting for the owner (ctx.ui) does not count toward the
	 * timeout; everything else does. Never throws.
	 */
	private async invoke(
		h: Registered<PlugHandler>,
		event: unknown,
		cwd: string,
	): Promise<{ ok: true; value: unknown } | { ok: false; timedOut: boolean; message: string }> {
		const state = { waiting: 0 };
		const provider = this.uiProvider;
		const asking = async <T>(no: T, run: (() => Promise<T>) | undefined): Promise<T> => {
			// No person to ask, or no way to ask: the answer is No.
			if (!provider || !run || !provider.attended()) return no;
			state.waiting++;
			try {
				return await run();
			} catch {
				return no;
			} finally {
				state.waiting--;
			}
		};
		const ui: PlugUI = {
			confirm: async (message, opts) => {
				const out = await asking<boolean>(
					false,
					provider?.confirm && (() => provider.confirm!(message, opts)),
				);
				return out === true;
			},
			select: async (title, options) => {
				const out = await asking<string | undefined>(
					undefined,
					provider?.select && (() => provider.select!(title, options)),
				);
				return typeof out === "string" && options.includes(out) ? out : undefined;
			},
		};
		const ctx: PlugContext = { cwd, hasUI: provider?.attended() === true, ui };
		let timer: ReturnType<typeof setInterval> | undefined;
		try {
			let spent = 0;
			let last = Date.now();
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setInterval(() => {
					const now = Date.now();
					if (state.waiting === 0) spent += now - last;
					last = now;
					if (spent >= this.handlerTimeoutMs) resolve("timeout");
				}, 10);
			});
			const out = await Promise.race([
				Promise.resolve().then(() =>
					(h.value.fn as (e: unknown, c: PlugContext) => unknown)(event, ctx),
				),
				timeout,
			]);
			if (out === "timeout") {
				return {
					ok: false,
					timedOut: true,
					message: `did not answer within ${this.handlerTimeoutMs} ms`,
				};
			}
			return { ok: true, value: out };
		} catch (err) {
			return {
				ok: false,
				timedOut: false,
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			if (timer) clearInterval(timer);
		}
	}

	private handlersFor(event: PlugEventName): Array<Registered<PlugHandler>> {
		return this.handlers.filter((h) => h.value.event === event);
	}

	private freeze<T>(value: T): T | null {
		try {
			return deepFreeze(structuredClone(value));
		} catch {
			return null;
		}
	}

	/**
	 * Ask every tool_call handler about a call, in load order. The first block
	 * wins; { args } replaces the arguments for the handlers after it and for
	 * the call. A handler that throws, times out or returns unusable arguments
	 * refuses the call (fail closed: a broken gate never opens it), and the
	 * refusal is logged. This can only make a call stricter: the caller runs
	 * the permission policy before this and again on any changed arguments.
	 */
	async runToolCall(
		toolName: string,
		args: Record<string, unknown>,
		cwd = process.cwd(),
	): Promise<{ blocked: string } | { args?: Record<string, unknown> }> {
		let current = args;
		let changed = false;
		for (const h of this.handlersFor("tool_call")) {
			const where = path.basename(h.file);
			const event = this.freeze({ toolName, args: current });
			if (!event) {
				const msg = `Plug ${where} could not be shown the arguments of tool "${toolName}", so the call was refused`;
				this.note(msg);
				return { blocked: msg };
			}
			const r = await this.invoke(h, event, cwd);
			if (!r.ok) {
				const msg = r.timedOut
					? `Plug ${where} did not answer within ${this.handlerTimeoutMs} ms about tool "${toolName}", so the call was refused`
					: `Plug ${where} failed while checking tool "${toolName}", so the call was refused: ${r.message}`;
				this.note(msg);
				return { blocked: msg };
			}
			const d = r.value as { block?: unknown; reason?: unknown; args?: unknown } | undefined;
			if (d && typeof d === "object" && d.block === true) {
				return {
					blocked: `Plug ${where} blocked tool "${toolName}"${typeof d.reason === "string" && d.reason ? `: ${d.reason}` : ""}`,
				};
			}
			if (d && typeof d === "object" && d.args !== undefined) {
				const next = d.args;
				const ok = next !== null && typeof next === "object" && !Array.isArray(next);
				let copy: Record<string, unknown> | null = null;
				if (ok) {
					try {
						copy = structuredClone(next) as Record<string, unknown>;
					} catch {
						copy = null;
					}
				}
				if (!copy) {
					const msg = `Plug ${where} returned arguments for tool "${toolName}" that are not a plain object, so the call was refused`;
					this.note(msg);
					return { blocked: msg };
				}
				current = copy;
				changed = true;
			}
		}
		return changed ? { args: current } : {};
	}

	/** The refusal text for a call, or null. Arguments a plug changes are not applied here; use runToolCall. */
	async checkToolCall(toolName: string, args: Record<string, unknown>): Promise<string | null> {
		const r = await this.runToolCall(toolName, args);
		return "blocked" in r ? r.blocked : null;
	}

	/**
	 * Let tool_result handlers rewrite a result, in load order. A handler that
	 * throws, times out or returns something other than { result: string } is
	 * skipped and logged; the result so far goes on unchanged.
	 */
	async runToolResult(
		toolName: string,
		args: Record<string, unknown>,
		result: string,
		cwd = process.cwd(),
	): Promise<string> {
		let current = result;
		for (const h of this.handlersFor("tool_result")) {
			const where = path.basename(h.file);
			const event = this.freeze({ toolName, args, result: current });
			if (!event) {
				this.note(
					`skipped ${where} on tool_result for "${toolName}": arguments could not be copied`,
				);
				continue;
			}
			const r = await this.invoke(h, event, cwd);
			if (!r.ok) {
				this.note(`skipped ${where} on tool_result for "${toolName}": ${r.message}`);
				continue;
			}
			const d = r.value as { result?: unknown } | undefined;
			if (d && typeof d === "object" && d.result !== undefined) {
				if (typeof d.result === "string") current = d.result;
				else this.note(`skipped ${where} on tool_result for "${toolName}": result is not a string`);
			}
		}
		return current;
	}

	/** Let input handlers rewrite what the person typed, in load order. A failing handler is skipped and logged. */
	async runInput(text: string, cwd = process.cwd()): Promise<string> {
		let current = text;
		for (const h of this.handlersFor("input")) {
			const where = path.basename(h.file);
			const r = await this.invoke(h, deepFreeze({ text: current }), cwd);
			if (!r.ok) {
				this.note(`skipped ${where} on input: ${r.message}`);
				continue;
			}
			const d = r.value as { text?: unknown } | undefined;
			if (d && typeof d === "object" && d.text !== undefined) {
				if (typeof d.text === "string") current = d.text;
				else this.note(`skipped ${where} on input: text is not a string`);
			}
		}
		return current;
	}

	/** Tell turn_start, turn_end and session_start handlers. A failing handler is skipped and logged. */
	async fire(
		event: "turn_start" | "turn_end" | "session_start",
		payload: Record<string, unknown>,
		cwd = process.cwd(),
	): Promise<void> {
		for (const h of this.handlersFor(event)) {
			const frozen = this.freeze(payload);
			const where = path.basename(h.file);
			if (!frozen) {
				this.note(`skipped ${where} on ${event}: payload could not be copied`);
				continue;
			}
			const r = await this.invoke(h, frozen, cwd);
			if (!r.ok) this.note(`skipped ${where} on ${event}: ${r.message}`);
		}
	}
}
