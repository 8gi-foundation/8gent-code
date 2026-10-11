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
 *   pi.registerCommand(name, { description, handler(args, ctx) }), types.d.ts:1147-1153, 1207
 *   pi.on("tool_call", (event, ctx) => { block, reason }), types.d.ts:1200, 1065-1074
 *     event { type: "tool_call", toolCallId, toolName, input }, types.d.ts:907-953
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
 * "edit", list_files "ls". Other 8gent tools keep their names, so a guard
 * written for "bash" does not see git_*, term_* or other command-running
 * tools. A tool_call handler cannot rewrite the input (Pi allows mutating
 * event.input; 8gent hands handlers a frozen copy). An extension may not
 * register a tool under one of Pi's built-in names (host.ts
 * RESERVED_PI_TOOL_NAMES): a second "bash" would skip run_command's checks.
 *
 * Imported extensions are off until `8gent ext enable`, and their sha256 is
 * checked against the import record on every load (importGate).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
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

/** Prefix of the virtual module names Pi files are rewritten to import. */
export const PI_SHIM_PREFIX = "8gent-pi-compat:";
let modulesRegistered = false;
const scopedDirs = new Set<string>();

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite a Pi file's imports of the shimmed modules (static `from`,
 * `import()` and `require()` with a literal name) to 8gent's virtual names.
 * Nothing else in the file changes.
 */
export function rewritePiImports(source: string): string {
	const names = PI_SHIMMED_MODULES.map(escapeRegExp).join("|");
	const re = new RegExp(
		`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)(["'])(${names})\\2`,
		"g",
	);
	return source.replace(
		re,
		(_m, lead: string, q: string, name: string) => `${lead}${q}${PI_SHIM_PREFIX}${name}${q}`,
	);
}

/**
 * Serve the npm modules Pi extensions import (typebox, pi-ai,
 * pi-coding-agent) to Pi extension files only. The modules exist only under
 * virtual names (8gent-pi-compat:<name>), and a load hook scoped to
 * `<dir>/pi-*` rewrites those files' imports to them, so no other code in the
 * process ever resolves "typebox" or "@sinclair/typebox" to the shim.
 */
export function registerPiModules(dir: string): void {
	const typeExports = { Type, default: Type };
	if (!modulesRegistered) {
		modulesRegistered = true;
		Bun.plugin({
			name: "8gent-pi-compat-modules",
			setup(build) {
				build.module(`${PI_SHIM_PREFIX}typebox`, () => ({
					exports: typeExports,
					loader: "object",
				}));
				build.module(`${PI_SHIM_PREFIX}@sinclair/typebox`, () => ({
					exports: typeExports,
					loader: "object",
				}));
				build.module(`${PI_SHIM_PREFIX}@earendil-works/pi-ai`, () => ({
					exports: { Type, StringEnum },
					loader: "object",
				}));
				build.module(`${PI_SHIM_PREFIX}@earendil-works/pi-coding-agent`, () => ({
					exports: { defineTool },
					loader: "object",
				}));
			},
		});
	}
	let real: string;
	try {
		real = fs.realpathSync(dir);
	} catch {
		return;
	}
	if (scopedDirs.has(real)) return;
	scopedDirs.add(real);
	const filter = new RegExp(
		`^${escapeRegExp(real)}[\\\\/]pi-[^\\\\/]+(\\.(m?[jt]s|tsx|cjs)$|[\\\\/].*\\.(m?[jt]s|tsx|cjs)$)`,
	);
	Bun.plugin({
		name: `8gent-pi-compat-files:${real}`,
		setup(build) {
			build.onLoad({ filter }, async (args) => {
				const ext = path.extname(args.path).slice(1);
				// Serve exactly the bytes whose hash matches the import record: read
				// once, hash those bytes, and load those same bytes. No gap between
				// the check and the load.
				const bytes = new Uint8Array(await Bun.file(args.path).arrayBuffer());
				const verdict = servedBytesCheck(real, args.path, bytes);
				if (verdict) {
					return { contents: `throw new Error(${JSON.stringify(verdict)});`, loader: "js" };
				}
				const source = new TextDecoder().decode(bytes);
				const loader = (ext === "tsx" ? "tsx" : ext.endsWith("ts") ? "ts" : "js") as
					| "ts"
					| "tsx"
					| "js";
				return { contents: rewritePiImports(source), loader };
			});
		},
	});
}

/**
 * Why the bytes about to be loaded for a pi-* file must not run, or null when
 * they match that file's sha256 in an enabled import record.
 */
export function servedBytesCheck(dir: string, file: string, bytes: Uint8Array): string | null {
	const manifest = readPiManifest(dir);
	if (manifest.error) return manifest.error;
	const found = recordFor(manifest.entries, file);
	if (!found) return `${path.basename(file)} is not part of an imported extension record`;
	if (!found.entry.enabled) return `imported extension ${found.entry.name} is off`;
	const expected = found.entry.files[found.rel];
	if (!expected) return `${found.rel} was not part of ${found.entry.name} when it was imported`;
	if (sha256(bytes) !== expected) return `${found.rel} in ${found.entry.name} changed since import`;
	return null;
}

/**
 * Turn a load error from a missing named import into one that names the Pi
 * API, e.g. `Export named 'CustomEditor' not found` becomes
 * `Pi API CustomEditor is not supported ...`.
 */
export function explainPiLoadError(message: string): string {
	const m = message.match(/(?:Export named|export) '([^']+)' not found in module '([^']+)'/i);
	if (m) {
		const from = m[2].replace(PI_SHIM_PREFIX, "");
		return `Pi API ${m[1]} (from ${from}) is not supported by 8gent's Pi compatibility`;
	}
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

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The file a relative import names, as Bun resolves it: the exact path, the
 * path with a source extension, the TypeScript twin of a .js/.mjs/.cjs name
 * (the "import ./x.js means x.ts" convention), or a folder's index.
 */
function resolveRelative(fromFile: string, spec: string): string | null {
	const base = path.resolve(path.dirname(fromFile), spec);
	const twins: string[] = [];
	const ext = path.extname(base);
	if ([".js", ".mjs", ".cjs", ".jsx"].includes(ext)) {
		const stem = base.slice(0, -ext.length);
		twins.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
	}
	const candidates = [
		base,
		...twins,
		...SOURCE_EXTS.map((e) => `${base}${e}`),
		...SOURCE_EXTS.map((e) => path.join(base, `index${e}`)),
	];
	for (const c of candidates) {
		try {
			if (fs.statSync(c).isFile()) return c;
		} catch {
			/* next */
		}
	}
	return null;
}

/**
 * Bare npm imports an extension file (and the relative files it imports)
 * makes that 8gent will not serve, for a clear message before load. This is
 * a courtesy check, not the guard: a computed import() or require() cannot be
 * seen statically. The guard is that 8gent runs Bun with --no-install, so no
 * import ever installs a package (bin/8gent.ts shebang, the TUI launcher).
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
				const target = resolveRelative(file, spec);
				if (target) visit(target);
				continue;
			}
			if (BUILTINS.has(spec) || allowed.has(spec) || spec.startsWith("bun:")) continue;
			out.add(spec);
		}
	};
	visit(entry);
	return [...out].sort();
}

// ── Static report (import never runs extension code) ─────────────────────────

/** Methods of Pi's API 8gent runs. */
const PI_ACTIVE = new Set(["registerTool", "registerCommand", "on"]);
/** Named value exports 8gent's shims provide, per module. */
const PI_EXPORTS: Record<string, Set<string>> = {
	typebox: new Set(["Type", "default"]),
	"@sinclair/typebox": new Set(["Type", "default"]),
	"@earendil-works/pi-ai": new Set(["Type", "StringEnum"]),
	"@earendil-works/pi-coding-agent": new Set(["defineTool"]),
};

export interface PiStaticReport {
	status: "loaded" | "partial" | "failed";
	/** What it registers, from the source text. */
	registers: string[];
	/** Accepted-but-inactive APIs (partial). */
	missing: string[];
	/** Why it would fail. */
	errors: string[];
}

/**
 * Judge a Pi extension from its source text alone (all files it imports
 * relatively): no code runs. The first enabled load is the real check; this
 * report names what that load would refuse or ignore.
 */
export function analyzePiExtension(entry: string): PiStaticReport {
	const errors: string[] = [];
	const missing = new Set<string>();
	const registers = new Set<string>();
	const unserved = unservedImports(entry, true);
	const piPackages = unserved.filter((u) => u.startsWith("@earendil-works/"));
	const other = unserved.filter((u) => !u.startsWith("@earendil-works/"));
	for (const u of piPackages) errors.push(`Pi API package "${u}" is not supported`);
	if (other.length)
		errors.push(`imports ${other.map((u) => `"${u}"`).join(", ")}, which 8gent does not install`);

	const files: string[] = [];
	const seen = new Set<string>();
	const transpiler = new Bun.Transpiler({ loader: "tsx" });
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		files.push(file);
		try {
			for (const { path: spec } of transpiler.scanImports(fs.readFileSync(file, "utf8"))) {
				if (spec.startsWith(".")) {
					const t = resolveRelative(file, spec);
					if (t) walk(t);
				}
			}
		} catch {
			/* syntax errors show on load */
		}
	};
	walk(entry);

	for (const file of files) {
		const src = fs.readFileSync(file, "utf8");
		// Named value imports from the shimmed modules that 8gent does not provide.
		const importRe = /import\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
		for (const m of src.matchAll(importRe)) {
			if (m[1]) continue;
			const provided = PI_EXPORTS[m[3]];
			if (!provided) continue;
			for (const raw of m[2].split(",")) {
				const part = raw.trim();
				if (!part || part.startsWith("type ")) continue;
				const name = part.split(/\s+as\s+/)[0].trim();
				if (!provided.has(name)) errors.push(`Pi API ${name} (from ${m[3]}) is not supported`);
			}
		}
		// The API parameter's name: `export default function (pi)`, `(api) =>`, etc.
		const param =
			src.match(/export\s+default\s+(?:async\s+)?function\s*[\w$]*\s*\(\s*([\w$]+)/)?.[1] ??
			src.match(/export\s+default\s+(?:async\s+)?\(?\s*([\w$]+)\s*(?::[^)=]*)?\)?\s*=>/)?.[1] ??
			"pi";
		const call = new RegExp(`\\b${escapeRegExp(param)}\\.([A-Za-z_$][\\w$]*)`, "g");
		for (const m of src.matchAll(call)) {
			const method = m[1];
			if (method === "registerTool") registers.add("tools");
			else if (method === "registerCommand") registers.add("commands");
			else if (method === "on") continue;
			else if ((PI_INACTIVE_METHODS as readonly string[]).includes(method))
				missing.add(`pi.${method}`);
			else if (!PI_ACTIVE.has(method)) errors.push(`Pi API pi.${method} is not supported`);
		}
		const onRe = new RegExp(`\\b${escapeRegExp(param)}\\.on\\(\\s*["']([\\w-]+)["']`, "g");
		for (const m of src.matchAll(onRe)) {
			if (m[1] === "tool_call") registers.add("tool_call checks");
			else missing.add(`pi.on("${m[1]}")`);
		}
	}
	const uniqueErrors = [...new Set(errors)];
	return {
		status: uniqueErrors.length ? "failed" : missing.size ? "partial" : "loaded",
		registers: [...registers],
		missing: [...missing],
		errors: uniqueErrors,
	};
}

// ── Import from Pi's extensions folder ────────────────────────────────────────

/**
 * Pi's user extensions folder, as Pi finds it (dist/config.js getAgentDir):
 * $PI_CODING_AGENT_DIR/extensions, else <home>/.pi/agent/extensions. On
 * Windows that is C:\Users\<you>\.pi\agent\extensions. `p` and `home` are
 * parameters so the Windows form is testable on any machine.
 */
export function defaultPiExtensionsDir(
	env: Record<string, string | undefined> = process.env,
	p: path.PlatformPath = path,
	home: string = resolveHome(),
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
	/** sha256 over the sorted file list and each file's sha256 (see extensionHash). */
	sha256: string;
	/** sha256 of every file, by path relative to the folder (a single file: its own name). */
	files: Record<string, string>;
	importedAt: string;
	/** Imported extensions are off until `8gent ext enable <name>`. */
	enabled: boolean;
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

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Every regular file under `dir`, dotfiles included, sorted. A symlink or any
 * other kind of entry is refused: it could point outside the hashed bytes.
 * `skip` names top-level-or-nested folder names left out (node_modules when
 * copying from Pi; nothing when checking a copy).
 */
function listFiles(dir: string, skip: Set<string> = new Set(), rel = ""): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isSymbolicLink())
			throw new Error(`${r} is a symlink; imported extensions may not contain links`);
		if (e.isDirectory()) {
			if (skip.has(e.name)) continue;
			out.push(...listFiles(dir, skip, r));
		} else if (e.isFile()) out.push(r);
		else throw new Error(`${r} is not a regular file`);
	}
	return out.sort();
}

/** Per-file sha256 of an extension: a file (keyed by its name) or a folder. */
export function fileHashes(target: string, skip: Set<string> = new Set()): Record<string, string> {
	const st = fs.lstatSync(target);
	if (st.isSymbolicLink())
		throw new Error(`${target} is a symlink; imported extensions may not be links`);
	if (st.isFile()) return { [path.basename(target)]: sha256(fs.readFileSync(target)) };
	const out: Record<string, string> = {};
	for (const rel of listFiles(target, skip))
		out[rel] = sha256(fs.readFileSync(path.join(target, ...rel.split("/"))));
	return out;
}

/** The extension's sha256: over the sorted file list and each file's sha256. */
export function extensionHash(files: Record<string, string>): string {
	const h = createHash("sha256");
	for (const rel of Object.keys(files).sort()) h.update(`${rel}\0${files[rel]}\0`);
	return h.digest("hex");
}

/** sha256 of an extension file or folder as it is on disk now (dotfiles included, links refused). */
export function sha256Of(target: string): string {
	return extensionHash(fileHashes(target));
}

export interface PiCopyResult {
	entries: PiImportEntry[];
	/** Extensions not imported, with the reason (for example a symlink inside). */
	refused: Array<{ name: string; source: string; reason: string }>;
}

/**
 * Import every Pi extension in `from` into `to` as pi-<name>: a single
 * .ts/.js file, or a folder with an index.ts/index.js (copied without
 * node_modules; dotfiles included; any symlink inside refuses the folder).
 * Copies, never links. For each one the record (source, per-file sha256,
 * off) is written to pi-imports.json atomically BEFORE its files are copied,
 * so a pi-* file never exists without a record; the copy is then checked
 * against the record. Loads and runs nothing.
 */
export function copyPiExtensions(from: string, to: string): PiCopyResult {
	if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
		throw new Error(`no Pi extensions folder at ${from}`);
	}
	fs.mkdirSync(to, { recursive: true });
	const manifest = readPiManifest(to);
	if (manifest.error) throw new Error(manifest.error);
	const byName = new Map(manifest.entries.map((p) => [p.name, p]));
	const entries: PiImportEntry[] = [];
	const refused: PiCopyResult["refused"] = [];
	const now = new Date().toISOString();
	const skip = new Set(["node_modules"]);
	for (const e of fs
		.readdirSync(from, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const source = path.join(from, e.name);
		if (e.isSymbolicLink()) {
			refused.push({
				name: e.name,
				source,
				reason: "is a symlink; import the real file or folder",
			});
			continue;
		}
		let name: string;
		let dest: string;
		if (e.isDirectory()) {
			if (!["index.ts", "index.js", "index.mjs"].some((i) => fs.existsSync(path.join(source, i))))
				continue;
			name = `pi-${safeName(e.name)}`;
			dest = path.join(to, name);
		} else if (e.isFile() && EXT.test(e.name) && !e.name.endsWith(".d.ts")) {
			name = `pi-${safeName(e.name)}`;
			dest = path.join(to, `${name}${path.extname(e.name)}`);
		} else continue;

		let files: Record<string, string>;
		try {
			files = fileHashes(source, skip);
		} catch (err) {
			refused.push({ name, source, reason: (err as Error).message });
			continue;
		}
		if (e.isFile()) files = { [path.basename(dest)]: Object.values(files)[0] };
		const entry: PiImportEntry = {
			name,
			source,
			dest,
			sha256: extensionHash(files),
			files,
			importedAt: now,
			enabled: false,
		};
		// The same bytes again keep their on/off choice; changed bytes start off.
		const before = byName.get(name);
		if (before?.enabled && before.sha256 === entry.sha256) entry.enabled = true;
		// Record first (atomic), then copy.
		byName.set(name, entry);
		writeManifest(to, [...byName.values()]);
		fs.rmSync(dest, { recursive: true, force: true });
		if (e.isDirectory()) {
			for (const rel of Object.keys(files)) {
				const target = path.join(dest, ...rel.split("/"));
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.copyFileSync(path.join(source, ...rel.split("/")), target);
			}
		} else {
			fs.copyFileSync(source, dest);
		}
		let copied = "";
		try {
			copied = sha256Of(dest);
		} catch {
			/* reported below */
		}
		if (copied !== entry.sha256) {
			refused.push({
				name,
				source,
				reason: "the copy does not match what was read (changed while importing?)",
			});
			continue;
		}
		entries.push(entry);
	}
	return { entries, refused };
}

/** Write the manifest atomically: a temp file in the same folder, then rename. */
function writeManifest(dir: string, entries: PiImportEntry[]): void {
	const file = path.join(dir, PI_IMPORT_MANIFEST);
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/**
 * The import manifest of an extensions folder. No file: no entries. A file
 * that cannot be read or parsed: `error` is set, and every pi-* extension is
 * refused (the gate fails closed).
 */
export function readPiManifest(dir: string): { entries: PiImportEntry[]; error?: string } {
	const file = path.join(dir, PI_IMPORT_MANIFEST);
	if (!fs.existsSync(file)) return { entries: [] };
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(raw)) throw new Error("not a list");
		for (const e of raw) {
			if (
				!e ||
				typeof e.name !== "string" ||
				typeof e.dest !== "string" ||
				typeof e.sha256 !== "string" ||
				!e.files ||
				typeof e.files !== "object"
			) {
				throw new Error("an entry is malformed");
			}
		}
		return { entries: raw as PiImportEntry[] };
	} catch (err) {
		return {
			entries: [],
			error: `${file} cannot be read (${(err as Error).message}); no imported (pi-*) extension loads until it is fixed or the extensions are imported again`,
		};
	}
}

function realOrResolved(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/** The record an extension file belongs to, and the file's path inside it. */
export function recordFor(
	entries: PiImportEntry[],
	file: string,
): { entry: PiImportEntry; rel: string } | null {
	const real = realOrResolved(file);
	for (const e of entries) {
		const dest = realOrResolved(e.dest);
		if (dest === real) return { entry: e, rel: path.basename(e.dest) };
		if (real.startsWith(dest + path.sep)) {
			return { entry: e, rel: path.relative(dest, real).split(path.sep).join("/") };
		}
	}
	return null;
}

/**
 * The load gate. `file` is what the host is about to load (a file, or a
 * folder's index). A file the person wrote (not pi-*, no record): null, the
 * host's own rules apply. A pi-* file loads only with a matching record,
 * enabled, whose sha256 still matches the bytes on disk (checked on every
 * load). It fails closed: no record, or an unreadable record file, refuses it.
 */
export function importGate(
	dir: string,
	file: string,
): { allowed: boolean; reason?: string } | null {
	const pi = isPiExtension(file);
	const manifest = readPiManifest(dir);
	if (manifest.error) return pi ? { allowed: false, reason: manifest.error } : null;
	const found = recordFor(manifest.entries, file);
	if (!found) {
		if (!pi) return null;
		return {
			allowed: false,
			reason: `${path.basename(file)} has no import record in ${PI_IMPORT_MANIFEST}; pi-* extensions load only after 8gent ext import-pi and 8gent ext enable`,
		};
	}
	const { entry } = found;
	if (!entry.enabled) {
		return {
			allowed: false,
			reason: `imported extension ${entry.name} is off; turn it on with: 8gent ext enable ${entry.name}`,
		};
	}
	let now: string;
	try {
		now = sha256Of(entry.dest);
	} catch (err) {
		return {
			allowed: false,
			reason: `imported extension ${entry.name} cannot be checked: ${(err as Error).message}`,
		};
	}
	if (now !== entry.sha256) {
		return {
			allowed: false,
			reason: `imported extension ${entry.name} changed since import (sha256 ${now.slice(0, 12)}, recorded ${entry.sha256.slice(0, 12)}), so it was not loaded; import it again to accept the change`,
		};
	}
	return { allowed: true };
}

/**
 * Turn an imported extension on or off. Turning it on re-checks its sha256
 * against the import record first, so a copy edited after import is refused.
 */
export function setImportedEnabled(
	dir: string,
	name: string,
	on: boolean,
): { code: number; output: string } {
	const manifest = readPiManifest(dir);
	if (manifest.error) return { code: 1, output: manifest.error };
	const entries = manifest.entries;
	const entry = entries.find((e) => e.name === name);
	if (!entry) {
		const names = entries.map((e) => e.name);
		return {
			code: 1,
			output: `No imported extension "${name}".${names.length ? ` Imported: ${names.join(", ")}` : ""}`,
		};
	}
	if (on) {
		let now = "";
		try {
			now = sha256Of(entry.dest);
		} catch {
			/* reported below */
		}
		if (now !== entry.sha256) {
			return {
				code: 1,
				output: `${name} changed since import (or is missing); import it again before enabling it.`,
			};
		}
	}
	entry.enabled = on;
	writeManifest(dir, entries);
	return {
		code: 0,
		output: on
			? `${name} is on. It loads the next time 8gent starts, when that session has extensions on.`
			: `${name} is off.`,
	};
}
