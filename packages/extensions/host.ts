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
 * built-in checks, and the policy inside each built-in tool still runs. A
 * handler that throws refuses the call (fail closed). Extension tools cannot
 * take a built-in tool's name.
 */

import * as fs from "node:fs";
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
	run: (args: string, ctx: ExtensionContext) => string | void | Promise<string | void>;
}

export interface ToolCallEvent {
	toolName: string;
	args: Record<string, unknown>;
}

/** Return { block: true } to refuse the call; anything else lets it through. */
export type ToolCallDecision = { block: true; reason?: string } | undefined | void;

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

/** The default extensions folder: ~/.8gent/extensions. */
export function defaultExtensionsDir(): string {
	return path.join(process.env.HOME || process.env.USERPROFILE || "~", ".8gent", "extensions");
}

interface Registered<T> {
	value: T;
	file: string;
}

export class ExtensionHost {
	private tools = new Map<string, Registered<ExtensionTool>>();
	private commands = new Map<string, Registered<ExtensionCommand>>();
	private handlers: Array<
		Registered<(e: ToolCallEvent) => ToolCallDecision | Promise<ToolCallDecision>>
	> = [];
	private results: ExtensionLoadResult[] = [];

	/**
	 * @param dir folder of one-file extensions
	 * @param reserved names an extension tool may not take (the built-in tools)
	 */
	constructor(
		private readonly dir: string = defaultExtensionsDir(),
		private readonly reserved: () => Iterable<string> = () => [],
	) {}

	/** One-file extensions in the folder, sorted so load order is stable. */
	files(): string[] {
		if (!fs.existsSync(this.dir)) return [];
		return fs
			.readdirSync(this.dir, { withFileTypes: true })
			.filter(
				(e) => e.isFile() && EXTENSIONS.has(path.extname(e.name)) && !e.name.endsWith(".d.ts"),
			)
			.map((e) => path.join(this.dir, e.name))
			.sort();
	}

	/**
	 * Load every extension, replacing whatever was loaded before (this is also
	 * reload, D12). One broken file never stops the others; its error is in the
	 * result. Each load drops the cached module first, so an edited file takes effect.
	 */
	async load(): Promise<ExtensionLoadResult[]> {
		this.tools.clear();
		this.commands.clear();
		this.handlers = [];
		const reserved = new Set(this.reserved());
		const results: ExtensionLoadResult[] = [];
		for (const file of this.files()) {
			results.push(await this.loadFile(file, reserved));
		}
		this.results = results;
		return results;
	}

	private async loadFile(file: string, reserved: Set<string>): Promise<ExtensionLoadResult> {
		const result: ExtensionLoadResult = { file, ok: false, tools: [], commands: [] };
		// Staged, so a file that fails halfway registers nothing.
		const tools: ExtensionTool[] = [];
		const commands: ExtensionCommand[] = [];
		const handlers: Array<(e: ToolCallEvent) => ToolCallDecision | Promise<ToolCallDecision>> = [];
		try {
			// Bun keys its module cache by path and ignores a ?query, so drop the
			// cached copy: an edited file then loads fresh on reload.
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
					if (this.tools.has(t.name) || tools.some((x) => x.name === t.name)) {
						throw new Error(`tool "${t.name}" is already registered`);
					}
					if (typeof t.execute !== "function") throw new Error(`tool "${t.name}" has no execute`);
					if (t.parameters?.type !== "object") {
						throw new Error(`tool "${t.name}" parameters must be an object schema`);
					}
					tools.push(t);
				},
				registerCommand: (c) => {
					if (!c || typeof c.name !== "string" || !NAME.test(c.name)) {
						throw new Error(`command name ${JSON.stringify(c?.name)} must match ${NAME}`);
					}
					if (this.commands.has(c.name) || commands.some((x) => x.name === c.name)) {
						throw new Error(`command "${c.name}" is already registered`);
					}
					if (typeof c.run !== "function") throw new Error(`command "${c.name}" has no run`);
					commands.push(c);
				},
				on: (event, handler) => {
					if (event !== "tool_call") throw new Error(`unknown event "${event}"`);
					if (typeof handler !== "function") throw new Error("tool_call handler is not a function");
					handlers.push(handler);
				},
			};
			await factory(api);
		} catch (err) {
			result.error = err instanceof Error ? err.message : String(err);
			return result;
		}
		for (const t of tools) this.tools.set(t.name, { value: t, file });
		for (const c of commands) this.commands.set(c.name, { value: c, file });
		for (const h of handlers) this.handlers.push({ value: h, file });
		result.ok = true;
		result.tools = tools.map((t) => t.name);
		result.commands = commands.map((c) => c.name);
		return result;
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
			try {
				const d = await h.value({ toolName, args });
				if (d && typeof d === "object" && d.block === true) {
					return `Extension ${where} blocked tool "${toolName}"${d.reason ? `: ${d.reason}` : ""}`;
				}
			} catch (err) {
				return `Extension ${where} failed while checking tool "${toolName}", so the call was refused: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		return null;
	}
}
