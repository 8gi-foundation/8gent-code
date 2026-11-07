/**
 * 8gent Code - Out-of-process extensions.
 *
 * An extension is a program named by ~/.8gent/extensions/<name>/manifest.json.
 * It runs as a child process and speaks the MCP stdio JSON-RPC that
 * packages/mcp/transport.ts already carries. Nothing is imported into the
 * host, so a crash or a hang in the extension stays in the extension.
 *
 * Off until a person turns it on: enableExtension() asks, default No, and a
 * session with no terminal answers No. The grant is bound to the manifest
 * bytes, so editing the manifest turns the extension off again.
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

export function readProcessManifest(dir: string): ProcessManifest | null {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(dir, PROCESS_MANIFEST), "utf-8"));
		const ok = ["name", "version", "description", "command"].every(
			(k) => typeof m?.[k] === "string" && m[k],
		);
		return ok ? (m as ProcessManifest) : null;
	} catch {
		return null;
	}
}

const digestOf = (file: string): string =>
	createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** True only when a person enabled this exact manifest (shared by both loaders). */
export function isEnabled(dir: string, manifestFile: string): boolean {
	try {
		const granted = fs.readFileSync(path.join(dir, ENABLED_FILE), "utf-8").trim();
		return granted === digestOf(path.join(dir, manifestFile));
	} catch {
		return false;
	}
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
	const file = path.join(dir, manifestFile);
	if (!fs.existsSync(file)) return false;
	const m = manifestFile === PROCESS_MANIFEST ? readProcessManifest(dir) : null;
	const what = m
		? `runs "${[m.command, ...(m.args ?? [])].join(" ")}" as its own process`
		: "runs code inside this process";
	if (!(await ask(`Enable extension "${path.basename(dir)}"? It ${what}.`))) return false;
	fs.writeFileSync(path.join(dir, ENABLED_FILE), digestOf(file));
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

/** Spawn the child, handshake, list its tools. Throws if the child never answers. */
export async function startProcessExtension(
	dir: string,
	opts: { attended?: boolean } = {},
): Promise<ProcessExtension> {
	// A person is at the keyboard when both ends are terminals; tests may say so.
	const attended = opts.attended ?? !!(process.stdin.isTTY && process.stdout.isTTY);
	const manifest = readProcessManifest(dir);
	if (!manifest) throw new Error("Invalid manifest");
	if (!isEnabled(dir, PROCESS_MANIFEST)) throw new Error("disabled");

	// An argument naming a file in the extension's folder is resolved against it.
	const args = (manifest.args ?? []).map((a) =>
		fs.existsSync(path.join(dir, a)) ? path.join(dir, a) : a,
	);
	const transport = new StdioTransport(manifest.command, args);
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
