/**
 * 8gent Code - Pi extension compatibility (G1, Pi import).
 *
 * Pi (@earendil-works/pi-coding-agent) extensions export a default factory
 * that receives Pi's `ExtensionAPI` (dist/core/extensions/types.d.ts:1162).
 * This module runs such a factory against 8gent's own extension host, so a
 * Pi tool, command or tool_call guard registers through the same path as a
 * native 8gent extension: the extension_call policy gate, the unattended
 * approval rule, the executor's scrubber and filters, the frozen tool_call
 * copy and the handler timeout. Nothing here loosens any of that.
 *
 * Supported (exact Pi shapes):
 *   pi.registerTool({ name, label, description, parameters, execute(toolCallId, params, signal, onUpdate, ctx) })
 *     -> result { content: [{ type: "text", text }], details }, types.d.ts:448-506
 *   pi.registerCommand(name, { description, handler(args, ctx) }), types.d.ts:1147-1153, 1206
 *   pi.on("tool_call", (event, ctx) => { block, reason }), types.d.ts:1201, 1065-1074
 *     event { type: "tool_call", toolCallId, toolName, input }, types.d.ts:913-959
 *   imports: Type from "typebox" / "@sinclair/typebox" / "@earendil-works/pi-ai",
 *     StringEnum from "@earendil-works/pi-ai", defineTool from "@earendil-works/pi-coding-agent"
 *   ctx: cwd, hasUI (false), mode, signal, ui.notify (shown as command output),
 *     ui.confirm (answers no), ui.select / ui.input (answer nothing)
 *
 * Accepted but inactive (the extension loads as "partial", each one named):
 *   every other pi.on(event) (session_start, agent_end, tool_result, ...),
 *   registerShortcut, registerFlag, the renderer registrations, registerProvider,
 *   registerMcpServer, registerVirtualModel.
 *
 * Unsupported (calling one is an error that names it): sendMessage,
 * sendUserMessage, appendEntry, exec, setActiveTools, setModel, events, and
 * the rest of the session-control API; any npm import other than the ones
 * above (8gent never installs packages for an extension).
 *
 * Tool names in a tool_call event use Pi's names for the tools both have:
 * run_command is "bash", read_file "read", write_file "write", edit_file
 * "edit", list_files "ls". A tool_call handler cannot rewrite the input
 * (Pi allows mutating event.input; 8gent hands handlers a frozen copy).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallDecision, ToolCallEvent } from "./host";

/** Our tool names, as Pi's tool_call events name the same tools. */
export const PI_TOOL_NAMES: Record<string, string> = {
	run_command: "bash",
	read_file: "read",
	write_file: "write",
	edit_file: "edit",
	list_files: "ls",
};

/** Pi registration methods 8gent accepts but does not act on (the load is "partial"). */
export const PI_INACTIVE_METHODS = [
	"registerShortcut",
	"registerFlag",
	"registerMessageRenderer",
	"registerMarkdownTransformer",
	"registerEntryRenderer",
	"registerToolRenderer",
	"registerProvider",
	"registerMcpServer",
	"registerVirtualModel",
] as const;

/** npm specifiers a Pi extension may import; each is served by 8gent, never installed. */
export const PI_SHIMMED_MODULES = [
	"typebox",
	"@sinclair/typebox",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
] as const;

/** Is this file (or its folder) a Pi extension? Imported ones are named pi-*. */
export function isPiExtension(file: string): boolean {
	const base = path.basename(file);
	const parent = path.basename(path.dirname(file));
	return base.startsWith("pi-") || (/^index\.[cm]?[jt]s$/.test(base) && parent.startsWith("pi-"));
}

// ── TypeBox-compatible schema builder ─────────────────────────────────────────

const OPTIONAL = Symbol.for("8gent.pi.optional");
type Schema = Record<string | symbol, unknown>;

function unsupported(what: string): never {
	throw new Error(`Pi API ${what} is not supported by 8gent's Pi compatibility`);
}

const TypeImpl = {
	Object(properties: Record<string, Schema>, options: Schema = {}): Schema {
		const props: Record<string, Schema> = {};
		const required: string[] = [];
		for (const [k, v] of Object.entries(properties ?? {})) {
			props[k] = v;
			if (!v?.[OPTIONAL]) required.push(k);
		}
		return {
			...options,
			type: "object",
			properties: props,
			...(required.length ? { required } : {}),
		};
	},
	Optional(schema: Schema): Schema {
		const copy: Schema = { ...schema };
		Object.defineProperty(copy, OPTIONAL, { value: true, enumerable: false });
		return copy;
	},
	String: (o: Schema = {}): Schema => ({ ...o, type: "string" }),
	Number: (o: Schema = {}): Schema => ({ ...o, type: "number" }),
	Integer: (o: Schema = {}): Schema => ({ ...o, type: "integer" }),
	Boolean: (o: Schema = {}): Schema => ({ ...o, type: "boolean" }),
	Null: (o: Schema = {}): Schema => ({ ...o, type: "null" }),
	Any: (o: Schema = {}): Schema => ({ ...o }),
	Unknown: (o: Schema = {}): Schema => ({ ...o }),
	Array: (items: Schema, o: Schema = {}): Schema => ({ ...o, type: "array", items }),
	Literal: (value: unknown, o: Schema = {}): Schema => ({ ...o, const: value }),
	Union: (anyOf: Schema[], o: Schema = {}): Schema => ({ ...o, anyOf }),
	Enum: (e: Record<string, unknown>, o: Schema = {}): Schema => ({ ...o, enum: Object.values(e) }),
	Record: (_k: Schema, v: Schema, o: Schema = {}): Schema => ({
		...o,
		type: "object",
		additionalProperties: v,
	}),
	Tuple: (items: Schema[], o: Schema = {}): Schema => ({
		...o,
		type: "array",
		prefixItems: items,
		minItems: items.length,
		maxItems: items.length,
	}),
};

/** `Type` as Pi extensions use it; an unknown builder names itself when called. */
export const Type: typeof TypeImpl & Record<string, unknown> = new Proxy(TypeImpl, {
	get(target, prop) {
		if (typeof prop === "string" && !(prop in target)) {
			return () => unsupported(`Type.${prop}`);
		}
		return (target as Record<string | symbol, unknown>)[prop];
	},
}) as typeof TypeImpl & Record<string, unknown>;

/** pi-ai's StringEnum: a string schema limited to the given values. */
export function StringEnum(values: string[], o: Schema = {}): Schema {
	return { ...o, type: "string", enum: [...values] };
}

/** pi-coding-agent's defineTool: an identity helper for typing. */
export function defineTool<T>(tool: T): T {
	return tool;
}

let modulesRegistered = false;

/**
 * Serve the npm modules Pi extensions import (typebox, pi-ai,
 * pi-coding-agent) from this file, process-wide, once. 8gent's own code does
 * not import any of these names.
 */
export function registerPiModules(): void {
	if (modulesRegistered) return;
	modulesRegistered = true;
	const typeExports = { Type, default: Type };
	Bun.plugin({
		name: "8gent-pi-compat",
		setup(build) {
			build.module("typebox", () => ({ exports: typeExports, loader: "object" }));
			build.module("@sinclair/typebox", () => ({ exports: typeExports, loader: "object" }));
			build.module("@earendil-works/pi-ai", () => ({
				exports: { Type, StringEnum },
				loader: "object",
			}));
			build.module("@earendil-works/pi-coding-agent", () => ({
				exports: { defineTool },
				loader: "object",
			}));
		},
	});
}

/**
 * Turn a load error from a missing named import into one that names the Pi
 * API, e.g. `Export named 'CustomEditor' not found` becomes
 * `Pi API CustomEditor is not supported ...`.
 */
export function explainPiLoadError(message: string): string {
	const m = message.match(/(?:Export named|export) '([^']+)' not found in module '([^']+)'/i);
	if (m) return `Pi API ${m[1]} (from ${m[2]}) is not supported by 8gent's Pi compatibility`;
	return message;
}

// ── The Pi API object ─────────────────────────────────────────────────────────

interface PiToolResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

interface PiToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: PiContext,
	) => Promise<PiToolResult> | PiToolResult;
}

interface PiCommandOptions {
	description?: string;
	handler: (args: string, ctx: PiContext) => Promise<void> | void;
}

export interface PiContext {
	cwd: string;
	hasUI: false;
	mode: "print";
	signal: AbortSignal | undefined;
	ui: {
		notify(message: string, level?: string): void;
		confirm(title: string, message?: string): Promise<boolean>;
		select(title: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		setStatus(key: string, text?: string): void;
	};
}

function piContext(cwd: string, notes?: string[]): PiContext {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		signal: undefined,
		ui: {
			notify: (message) => {
				notes?.push(String(message));
			},
			// No dialog in 8gent's extension runtime: a question is answered "no".
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
			setStatus: () => {},
		},
	};
}

/** Text a Pi tool result shows the model: its text parts, images noted. */
function resultText(result: PiToolResult | undefined): string {
	const parts = (result?.content ?? []).map((c) =>
		c.type === "text" ? String(c.text ?? "") : `[${c.type} omitted]`,
	);
	const text = parts.join("\n");
	return result?.isError ? `Error: ${text}` : text;
}

/**
 * Build Pi's ExtensionAPI over one of 8gent's registration APIs. `missing`
 * collects every accepted-but-inactive API the extension used, so the load
 * reports "partial" and names them. Unsupported runtime methods throw.
 */
export function createPiApi(
	ours: ExtensionAPI,
	missing: string[],
	defaultCwd = process.cwd(),
): unknown {
	const note = (what: string) => {
		if (!missing.includes(what)) missing.push(what);
	};
	const api: Record<string, unknown> = {
		registerTool(def: PiToolDefinition) {
			if (!def || typeof def.execute !== "function") {
				throw new Error(`Pi tool ${JSON.stringify(def?.name)} has no execute()`);
			}
			ours.registerTool({
				name: def.name,
				description: def.description,
				parameters: def.parameters as { type: "object"; properties: Record<string, unknown> },
				execute: async (args: Record<string, unknown>, ctx: ExtensionContext) => {
					const params = def.prepareArguments ? def.prepareArguments(args) : args;
					const out = await def.execute(
						`8gent-${Date.now()}`,
						params,
						undefined,
						undefined,
						piContext(ctx.cwd),
					);
					return resultText(out);
				},
			});
		},
		registerCommand(name: string, options: PiCommandOptions) {
			if (!options || typeof options.handler !== "function") {
				throw new Error(`Pi command ${JSON.stringify(name)} has no handler`);
			}
			ours.registerCommand({
				name,
				description: options.description,
				run: async (args: string, ctx: ExtensionContext) => {
					const notes: string[] = [];
					await options.handler(args, piContext(ctx.cwd, notes));
					return notes.join("\n");
				},
			});
		},
		on(event: string, handler: (e: unknown, ctx: PiContext) => unknown) {
			if (typeof handler !== "function") throw new Error(`pi.on("${event}") needs a handler`);
			if (event !== "tool_call") {
				note(`pi.on("${event}")`);
				return () => {};
			}
			ours.on("tool_call", async (e: ToolCallEvent): Promise<ToolCallDecision> => {
				const piEvent = {
					type: "tool_call",
					toolCallId: "",
					toolName: PI_TOOL_NAMES[e.toolName] ?? e.toolName,
					input: e.args,
				};
				const r = (await handler(piEvent, piContext(defaultCwd))) as
					| { block?: boolean; reason?: string }
					| undefined;
				return r?.block === true ? { block: true, reason: r.reason } : undefined;
			});
			return () => {};
		},
	};
	for (const m of PI_INACTIVE_METHODS) {
		api[m] = () => note(`pi.${m}`);
	}
	return new Proxy(api, {
		get(target, prop) {
			if (typeof prop !== "string") return undefined;
			if (prop in target) return target[prop];
			if (prop === "then") return undefined; // not a thenable
			// Anything else is Pi API 8gent does not provide: name it when used.
			return () => unsupported(`pi.${prop}`);
		},
	});
}

// ── Static import check ───────────────────────────────────────────────────────

const BUILTINS = new Set(
	(require("node:module") as { builtinModules: string[] }).builtinModules.flatMap((m) => [
		m,
		`node:${m}`,
	]),
);

/**
 * Bare npm imports an extension file (and the relative files it imports)
 * makes that 8gent will not serve. Bun would otherwise try to auto-install
 * them from the network; an extension loads local files only.
 */
export function unservedImports(entry: string, allowPi: boolean): string[] {
	const transpiler = new Bun.Transpiler({ loader: "tsx" });
	const allowed = new Set<string>(allowPi ? PI_SHIMMED_MODULES : []);
	const out = new Set<string>();
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		let src: string;
		try {
			src = fs.readFileSync(file, "utf8");
		} catch {
			return;
		}
		let imports: Array<{ path: string }>;
		try {
			imports = transpiler.scanImports(src);
		} catch {
			return; // A syntax error surfaces when the file is imported.
		}
		for (const { path: spec } of imports) {
			if (spec.startsWith(".") || spec.startsWith("/")) {
				const base = path.resolve(path.dirname(file), spec);
				for (const candidate of [
					base,
					`${base}.ts`,
					`${base}.js`,
					path.join(base, "index.ts"),
					path.join(base, "index.js"),
				]) {
					if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
						visit(candidate);
						break;
					}
				}
				continue;
			}
			if (BUILTINS.has(spec) || allowed.has(spec) || spec.startsWith("bun:")) continue;
			out.add(spec);
		}
	};
	visit(entry);
	return [...out].sort();
}

// ── Import from Pi's extensions folder ────────────────────────────────────────

/**
 * Pi's user extensions folder, as Pi finds it (dist/config.js getAgentDir):
 * $PI_CODING_AGENT_DIR/extensions, else <home>/.pi/agent/extensions. On
 * Windows that is C:\Users\<you>\.pi\agent\extensions. `p` and `home` are
 * parameters so the Windows form is testable on any machine.
 */
export function defaultPiExtensionsDir(
	env: NodeJS.ProcessEnv = process.env,
	p: path.PlatformPath = path,
	home: string = os.homedir(),
): string {
	const fromEnv = env.PI_CODING_AGENT_DIR;
	if (fromEnv) {
		const tilde = fromEnv === "~" || fromEnv.startsWith("~/") || fromEnv.startsWith("~\\");
		const expanded = tilde ? p.join(home, fromEnv.slice(1)) : fromEnv;
		return p.join(p.resolve(expanded), "extensions");
	}
	if (!home || !p.isAbsolute(home)) {
		throw new Error(
			"no absolute home directory; pass the Pi extensions folder: 8gent ext import-pi <path>",
		);
	}
	return p.join(home, ".pi", "agent", "extensions");
}

export interface PiImportEntry {
	/** Name as 8gent loads it: pi-<name>. */
	name: string;
	/** The file or folder in Pi's extensions folder. */
	source: string;
	/** Where it was copied. */
	dest: string;
	/** sha256 of the file, or of the sorted file list and contents for a folder. */
	sha256: string;
	importedAt: string;
}

export const PI_IMPORT_MANIFEST = "pi-imports.json";
const EXT = /\.(ts|js|mjs|mts)$/;

function safeName(raw: string): string {
	const s = raw
		.toLowerCase()
		.replace(/\.(ts|js|mjs|mts)$/, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56);
	if (!s || !/^[a-z]/.test(s)) return `x${s}`;
	return s;
}

function folderFiles(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...folderFiles(dir, r));
		else if (e.isFile()) out.push(r);
	}
	return out.sort();
}

function sha256Of(source: string): string {
	const h = createHash("sha256");
	if (fs.statSync(source).isDirectory()) {
		for (const rel of folderFiles(source)) {
			h.update(`${rel}\0`);
			h.update(fs.readFileSync(path.join(source, ...rel.split("/"))));
			h.update("\0");
		}
	} else {
		h.update(fs.readFileSync(source));
	}
	return h.digest("hex");
}

/**
 * Copy every Pi extension in `from` into `to` as pi-<name>: a single
 * .ts/.js file, or a folder with an index.ts/index.js (copied without
 * node_modules). Copies, never links: links need extra rights on Windows and
 * would let a later edit in Pi's folder change code without a new hash.
 * Records source, destination and sha256 in pi-imports.json. Loads nothing.
 */
export function copyPiExtensions(from: string, to: string): PiImportEntry[] {
	if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
		throw new Error(`no Pi extensions folder at ${from}`);
	}
	fs.mkdirSync(to, { recursive: true });
	const entries: PiImportEntry[] = [];
	const now = new Date().toISOString();
	for (const e of fs
		.readdirSync(from, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const source = path.join(from, e.name);
		let isDir = e.isDirectory();
		if (e.isSymbolicLink()) {
			try {
				isDir = fs.statSync(source).isDirectory();
			} catch {
				continue;
			}
		}
		if (isDir) {
			const index = ["index.ts", "index.js", "index.mjs"].find((i) =>
				fs.existsSync(path.join(source, i)),
			);
			if (!index) continue;
			const name = `pi-${safeName(e.name)}`;
			const dest = path.join(to, name);
			fs.rmSync(dest, { recursive: true, force: true });
			for (const rel of folderFiles(source)) {
				const target = path.join(dest, ...rel.split("/"));
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.copyFileSync(path.join(source, ...rel.split("/")), target);
			}
			entries.push({ name, source, dest, sha256: sha256Of(source), importedAt: now });
		} else if (EXT.test(e.name) && !e.name.endsWith(".d.ts")) {
			const ext = path.extname(e.name);
			const name = `pi-${safeName(e.name)}`;
			const dest = path.join(to, `${name}${ext}`);
			fs.copyFileSync(source, dest);
			entries.push({ name, source, dest, sha256: sha256Of(source), importedAt: now });
		}
	}
	const manifestPath = path.join(to, PI_IMPORT_MANIFEST);
	let previous: PiImportEntry[] = [];
	try {
		previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PiImportEntry[];
	} catch {
		previous = [];
	}
	const byName = new Map(previous.map((p) => [p.name, p]));
	for (const entry of entries) byName.set(entry.name, entry);
	fs.writeFileSync(manifestPath, `${JSON.stringify([...byName.values()], null, 2)}\n`);
	return entries;
}
