/**
 * 8gent Code - Out-of-process extensions.
 *
 * An extension is a program named by ~/.8gent/extensions/<name>/manifest.json.
 * It runs as a child process and speaks the MCP stdio JSON-RPC that
 * packages/mcp/transport.ts already carries. Nothing is imported into the
 * host, so a crash or a hang in the extension stays in the extension.
 * This is crash isolation, not containment: the child has the person's rights.
 *
 * Off until a person turns it on: enableExtension() asks, default No, and a
 * session with no terminal answers No. The grant is bound to the manifest
 * bytes, so editing the manifest turns the extension off again. An unattended
 * host never starts the child at all.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type { MCPToolSchema } from "../mcp/tool-bridge";
import { StdioTransport } from "../mcp/transport";
import { ToolG8 } from "../permissions/toolg8";

export const PROCESS_MANIFEST = "manifest.json";
const ENABLED_FILE = ".enabled";

export interface ProcessManifest {
	name: string;
	version: string;
	description: string;
	command: string;
	args?: string[];
	/** "tool:<name>" per tool the extension may run, or "tool:*". Anything else is denied. */
	permissions?: string[];
}

// C0, DEL and C1 controls, and the bidi overrides and isolates: none may reach a terminal prompt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

const safe = (v: unknown): boolean =>
	typeof v === "string" ? !UNSAFE.test(v) : Array.isArray(v) ? v.every(safe) : true;

/** Parse manifest bytes; null when a field is missing, mistyped or holds control characters. */
export function parseProcessManifest(bytes: Buffer): ProcessManifest | null {
	try {
		const m = JSON.parse(bytes.toString("utf-8"));
		const strings = ["name", "version", "description", "command"].every(
			(k) => typeof m?.[k] === "string" && m[k],
		);
		const lists = [m?.args, m?.permissions].every(
			(l) => l === undefined || (Array.isArray(l) && l.every((x) => typeof x === "string")),
		);
		const clean = Object.values(m).every(safe);
		return strings && lists && clean ? (m as ProcessManifest) : null;
	} catch {
		return null;
	}
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Read a manifest once; `enabled` says whether a person granted exactly these bytes. */
export function readManifestFile(
	dir: string,
	manifestFile: string,
): { bytes: Buffer; enabled: boolean } | null {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(path.join(dir, manifestFile));
	} catch {
		return null;
	}
	let enabled = false;
	try {
		enabled = fs.readFileSync(path.join(dir, ENABLED_FILE), "utf-8").trim() === digest(bytes);
	} catch {}
	return { bytes, enabled };
}

export async function promptDefaultNo(question: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
	} finally {
		rl.close();
	}
}

/** Ask, then record the grant. Returns whether the extension is now enabled. */
export async function enableExtension(
	dir: string,
	manifestFile: string = PROCESS_MANIFEST,
	ask: (q: string) => Promise<boolean> = promptDefaultNo,
): Promise<boolean> {
	const read = readManifestFile(dir, manifestFile);
	if (!read) return false;
	const m = manifestFile === PROCESS_MANIFEST ? parseProcessManifest(read.bytes) : null;
	if (manifestFile === PROCESS_MANIFEST && !m) return false;
	// JSON.stringify keeps every argument visible as one quoted element.
	const what = m
		? `runs the program ${JSON.stringify(m.command)} with arguments ${JSON.stringify(m.args ?? [])} as its own process`
		: "runs code inside this process";
	if (!(await ask(`Enable extension ${JSON.stringify(path.basename(dir))}? It ${what}.`)))
		return false;
	fs.writeFileSync(path.join(dir, ENABLED_FILE), digest(read.bytes));
	return true;
}

export interface ProcessExtension {
	manifest: ProcessManifest;
	/** Callable tools by name; every call is checked before it reaches the child. */
	tools: Record<string, (args?: Record<string, unknown>) => Promise<string>>;
	close(): void;
}

/** Declared permission first (deny by default), then the policy engine's extension_call rules. */
function refusal(m: ProcessManifest, tool: string, attended: boolean): string | null {
	const declared = m.permissions ?? [];
	if (!declared.includes(`tool:${tool}`) && !declared.includes("tool:*"))
		return `[BLOCKED] extension ${m.name}/${tool} is not in the permissions its manifest declares. Nothing was sent to it.`;
	const gate = ToolG8.instance().gate("primary", "extension_call", {
		server: m.name,
		tool,
		action: `${m.name}/${tool}`,
		attended,
	});
	if (gate.allowed) return null;
	return `[BLOCKED] extension ${m.name}/${tool} was refused by policy: ${gate.reason ?? "no reason given"}. Nothing was sent to it.`;
}

/**
 * The program to run. A command with a path separator is the extension's own
 * file: resolved against its folder, real path inside it. A bare name is
 * looked up on PATH, never in the host's working directory.
 */
function resolveCommand(dir: string, command: string): string {
	if (!command.includes("/") && !command.includes(path.sep)) return command;
	const root = fs.realpathSync(dir);
	const real = fs.realpathSync(path.resolve(dir, command));
	if (real !== root && !real.startsWith(root + path.sep))
		throw new Error(`command ${JSON.stringify(command)} is outside the extension folder`);
	return real;
}

/** Spawn the child, handshake, list its tools. Throws if the child never answers. */
export async function startProcessExtension(
	dir: string,
	opts: { attended?: boolean } = {},
): Promise<ProcessExtension> {
	// A person is at the keyboard when both ends are terminals; the host may say otherwise.
	const attended = opts.attended ?? !!(process.stdin.isTTY && process.stdout.isTTY);
	// Unattended means no: the child's code runs at spawn, before any call is gated.
	if (!attended) throw new Error("disabled (unattended)");
	const read = readManifestFile(dir, PROCESS_MANIFEST);
	const manifest = read && parseProcessManifest(read.bytes);
	if (!read || !manifest) throw new Error("Invalid manifest");
	if (!read.enabled) throw new Error("disabled");

	const args = manifest.args ?? [];
	if (args.some((a) => a.split(/[\\/]/).includes("..")))
		throw new Error("an argument leaves the extension folder");
	// The extension's folder is its working directory, so relative arguments mean its own files.
	const transport = new StdioTransport(
		resolveCommand(dir, manifest.command),
		args,
		undefined,
		fs.realpathSync(dir),
	);
	await transport.start();
	// The host leaving takes the child with it.
	const onExit = () => transport.close();
	process.once("exit", onExit);

	let listed: MCPToolSchema[];
	try {
		await transport.send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "8gent-code", version: "0" },
		});
		transport.notify("notifications/initialized");
		listed = ((await transport.send("tools/list")) as { tools?: MCPToolSchema[] })?.tools ?? [];
	} catch (err) {
		process.off("exit", onExit);
		transport.close();
		throw err;
	}

	const tools: ProcessExtension["tools"] = {};
	for (const t of listed) {
		tools[t.name] = async (callArgs = {}) => {
			const refused = refusal(manifest, t.name, attended);
			if (refused) return refused;
			try {
				const res = (await transport.send("tools/call", {
					name: t.name,
					arguments: callArgs,
				})) as { content?: { type: string; text?: string }[] };
				return (res?.content ?? [])
					.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
					.join("\n");
			} catch (err) {
				// A dead child is a failed call, never a failed host.
				return `[extension ${manifest.name} stopped: ${err instanceof Error ? err.message : err}]`;
			}
		};
	}
	return {
		manifest,
		tools,
		close() {
			process.off("exit", onExit);
			transport.close();
		},
	};
}

if (import.meta.main && process.argv[2] === "enable" && process.argv[3]) {
	const dir = path.resolve(process.env.HOME ?? "~", ".8gent", "extensions", process.argv[3]);
	const file = fs.existsSync(path.join(dir, PROCESS_MANIFEST))
		? PROCESS_MANIFEST
		: "8gent-extension.json";
	console.log((await enableExtension(dir, file)) ? "enabled" : "not enabled");
}
