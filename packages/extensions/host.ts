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
 * Safety: a tool_call handler can only ADD a refusal. Nothing an extension
 * returns can allow a call the mode, a hook or the permission policy refused,
 * because the host is consulted only by the agent's refusal gate, after the
 * built-in checks, and the policy inside each built-in tool still runs. Each
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

/** Return { block: true } to refuse the call; anything else lets it through. */
export type ToolCallDecision = { block: true; reason?: string } | undefined;

export interface ExtensionAPI {
	registerTool(tool: ExtensionTool): void;
	registerCommand(command: ExtensionCommand): void;
	on(
		event: "tool_call",
		handler: (e: ToolCallEvent) => ToolCallDecision | Promise<ToolCallDecision>,
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
resume history continue compact chat agent github debug music dj pet export fork rewind branch cron deploy
vercel telegram router rename spawn settings quiet term create-app hands eyes handeyes goal subgoal build
notes ideas btw questions projects terminal reload exit
copy hotkeys tree import update route privacy consult bug me allow-read mode`.split(/\s+/),
);

/** The default extensions folder: ~/.8gent/extensions. Throws without an absolute home directory. */
export function defaultExtensionsDir(): string {
	const home = os.homedir();
	if (!home || !path.isAbsolute(home)) {
		throw new Error(`no absolute home directory (got "${home}"); not loading extensions`);
	}
	return path.join(home, ".8gent", "extensions");
}

type Handler = (e: ToolCallEvent) => ToolCallDecision | Promise<ToolCallDecision>;

interface Registered<T> {
	value: T;
	file: string;
}

/** What one file registered: staged, then swapped in as a whole. */
interface FileRegistration {
	tools: ExtensionTool[];
	commands: ExtensionCommand[];
	handlers: Handler[];
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
	private handlers: Array<Registered<Handler>> = [];
	private results: ExtensionLoadResult[] = [];
	/** The last good registration of each file, by real path. */
	private byFile = new Map<string, FileRegistration>();

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
				if (previous && previous.handlers.length > 0) {
					next.set(real, { tools: [], commands: [], handlers: previous.handlers });
					result.error = `${result.error}; kept previous version of ${path.basename(real)} (its tool_call checks only; its tools and commands are off until it loads)`;
				}
			}
			results.push(result);
		}
		// One synchronous swap: nothing can observe a half-built set.
		const tools = new Map<string, Registered<ExtensionTool>>();
		const commands = new Map<string, Registered<ExtensionCommand>>();
		const handlers: Array<Registered<Handler>> = [];
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
				on: (event, handler) => {
					if (event !== "tool_call") throw new Error(`unknown event "${event}"`);
					if (typeof handler !== "function") throw new Error("tool_call handler is not a function");
					reg.handlers.push(handler);
				},
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

	/**
	 * Ask every tool_call handler about a call. The first block wins and its
	 * reason is the refusal; a handler that throws refuses too (fail closed).
	 * Null: no extension objects. This can only refuse, never allow.
	 */
	async checkToolCall(toolName: string, args: Record<string, unknown>): Promise<string | null> {
		for (const h of this.handlers) {
			const where = path.basename(h.file);
			// Each handler sees its own frozen copy: it can read the call, never change it.
			let event: ToolCallEvent;
			try {
				event = deepFreeze({ toolName, args: structuredClone(args) });
			} catch {
				return `Tool "${toolName}" arguments could not be copied for extension ${where}, so the call was refused`;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const timeout = new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), this.handlerTimeoutMs);
				});
				const d = await Promise.race([Promise.resolve().then(() => h.value(event)), timeout]);
				if (d === "timeout") {
					return `Extension ${where} did not answer within ${this.handlerTimeoutMs} ms about tool "${toolName}", so the call was refused`;
				}
				if (d && typeof d === "object" && d.block === true) {
					return `Extension ${where} blocked tool "${toolName}"${d.reason ? `: ${d.reason}` : ""}`;
				}
			} catch (err) {
				return `Extension ${where} failed while checking tool "${toolName}", so the call was refused: ${err instanceof Error ? err.message : String(err)}`;
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		return null;
	}
}
