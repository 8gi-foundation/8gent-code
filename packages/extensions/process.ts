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
 * bytes and to the program it runs (grant.ts), so editing either turns the
 * extension off again. An unattended host starts nothing unless the person
 * approved that one run in advance (`8gent ext approve-run`).
 *
 * Children are closed when the host exits and on SIGINT, SIGTERM and SIGHUP.
 * SIGKILL cannot be caught: after one, a child only sees its stdin close.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { unattended } from "../core/one-yes";
import type { MCPToolSchema } from "../mcp/tool-bridge";
import { StdioTransport } from "../mcp/transport";
import { ToolG8 } from "../permissions/toolg8";
import {
	DEFAULT_TTL_MS,
	type Fingerprint,
	MAX_TTL_MS,
	changedMessage,
	fingerprint,
	grantHash,
	grantText,
	mintApproval,
	newRunId,
	pruneRuns,
	verifyApproval,
} from "./grant";

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

/** A folder name that would reorder or rewrite a terminal line is not an extension. */
export const unsafeFolderName = (dir: string): boolean => UNSAFE.test(path.basename(dir));

export type GrantState =
	| { state: "ok"; fp: Fingerprint; hash: string }
	| { state: "none" }
	| { state: "changed"; message: string };

/** Hash the manifest and what it names now. Throws when the program cannot be resolved. */
export function currentFingerprint(dir: string, manifestFile: string, bytes: Buffer): Fingerprint {
	if (manifestFile === PROCESS_MANIFEST) {
		const m = parseProcessManifest(bytes);
		if (!m) throw new Error("Invalid manifest");
		return fingerprint(dir, bytes, m);
	}
	// A legacy in-process manifest: bind its entry file.
	let entry: unknown;
	try {
		entry = JSON.parse(bytes.toString("utf-8"))?.entry;
	} catch {}
	return fingerprint(dir, bytes, { entry });
}

/** Compare the recorded grant with the manifest and the program as they are on disk now. */
function checkGrant(dir: string, manifestFile: string, bytes: Buffer): GrantState {
	let recorded: string;
	try {
		recorded = fs.readFileSync(path.join(dir, ENABLED_FILE), "utf-8").trim();
	} catch {
		return { state: "none" };
	}
	const folder = path.basename(dir);
	// A grant from before #47 bound the manifest bytes only.
	if (/^[0-9a-f]{64}$/.test(recorded))
		return {
			state: "changed",
			message: `enabled before program checks; run 8gent ext enable ${folder} to review`,
		};
	try {
		const fp = currentFingerprint(dir, manifestFile, bytes);
		if (grantText(fp) === recorded) return { state: "ok", fp, hash: grantHash(fp) };
	} catch {}
	return { state: "changed", message: changedMessage(folder) };
}

/**
 * Read a manifest once and check the grant against those same bytes and the
 * program on disk now. `enabled` is true only when the grant still matches.
 */
export function readManifestFile(
	dir: string,
	manifestFile: string,
): { bytes: Buffer; enabled: boolean; grant: GrantState } | null {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(path.join(dir, manifestFile));
	} catch {
		return null;
	}
	const grant = checkGrant(dir, manifestFile, bytes);
	return { bytes, enabled: grant.state === "ok", grant };
}

export async function promptDefaultNo(question: string): Promise<boolean> {
	// CI, EIGHT_HEADLESS, EIGHT_UNATTENDED or no terminal: nobody can answer, so No.
	if (unattended()) return false;
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
	if (unsafeFolderName(dir)) return false;
	const read = readManifestFile(dir, manifestFile);
	if (!read) return false;
	const m = manifestFile === PROCESS_MANIFEST ? parseProcessManifest(read.bytes) : null;
	if (manifestFile === PROCESS_MANIFEST && !m) return false;
	let fp: Fingerprint;
	try {
		fp = currentFingerprint(dir, manifestFile, read.bytes);
	} catch {
		// A program that cannot be found, or that leaves the folder, is never offered.
		return false;
	}
	// JSON.stringify keeps every argument visible as one quoted element. The
	// resolved path is shown, so the person sees which python3 would run.
	const what =
		m && fp.program
			? `runs the program ${JSON.stringify(fp.program.path)} with arguments ${JSON.stringify(m.args ?? [])} as its own process`
			: "runs code inside this process";
	if (!(await ask(`Enable extension ${JSON.stringify(path.basename(dir))}? It ${what}.`)))
		return false;
	// Grant what the person was shown: a change while the prompt was open is not granted.
	const again = readManifestFile(dir, manifestFile);
	try {
		if (!again || grantText(currentFingerprint(dir, manifestFile, again.bytes)) !== grantText(fp))
			return false;
	} catch {
		return false;
	}
	fs.writeFileSync(path.join(dir, ENABLED_FILE), grantText(fp));
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

// ── Host exit and signals ────────────────────────────────────────────────────

const live = new Set<StdioTransport>();
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const hooks = new Map<string, () => void>();

function closeAll(): void {
	for (const t of live) t.close();
	live.clear();
	for (const [event, fn] of hooks) process.removeListener(event, fn);
	hooks.clear();
}

/** Close every child on exit or a terminating signal, then let the signal do what it would have done. */
function track(t: StdioTransport): void {
	live.add(t);
	if (hooks.size) return;
	hooks.set("exit", closeAll);
	for (const sig of SIGNALS) {
		hooks.set(sig, () => {
			closeAll();
			// Nobody else listens: re-raise so the default action (the host ends) still happens.
			if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
		});
	}
	for (const [event, fn] of hooks) process.on(event, fn);
}

function untrack(t: StdioTransport): void {
	t.close();
	live.delete(t);
	if (live.size === 0) closeAll();
}

/**
 * Why this enabled extension may not start in this host, or null when it may:
 * the grant must still match the program on disk, and either a person can
 * answer or a valid approval covers this one run.
 */
export function startRefusal(
	dir: string,
	grant: GrantState,
	attended: boolean,
	env: Record<string, string | undefined> = process.env,
): string | null {
	if (grant.state === "changed") return grant.message;
	if (grant.state !== "ok") return "disabled";
	if (attended) return null;
	const approval = verifyApproval(path.basename(dir), grant.hash, { env });
	if (approval.ok) return null;
	return env.EIGHT_EXT_APPROVAL
		? `disabled (unattended): ${approval.reason}`
		: "disabled (unattended)";
}

/** Spawn the child, handshake, list its tools. Throws if the child never answers. */
export async function startProcessExtension(
	dir: string,
	opts: { attended?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<ProcessExtension> {
	const env = opts.env ?? process.env;
	// A person is at the keyboard when both ends are terminals; the host may say otherwise.
	const attended = opts.attended ?? !unattended();
	// Unattended means no: the child's code runs at spawn, before any call is gated.
	if (!attended && !env.EIGHT_EXT_APPROVAL) throw new Error("disabled (unattended)");
	const read = readManifestFile(dir, PROCESS_MANIFEST);
	const manifest = read && parseProcessManifest(read.bytes);
	if (!read || !manifest) throw new Error("Invalid manifest");
	// Checked right before every spawn: the program on disk now must be the one granted.
	const refused = startRefusal(dir, read.grant, attended, env);
	if (refused) throw new Error(refused);
	const program = read.grant.state === "ok" ? read.grant.fp.program : undefined;
	if (!program) throw new Error("Invalid manifest");

	const args = manifest.args ?? [];
	if (args.some((a) => a.split(/[\\/]/).includes("..")))
		throw new Error("an argument leaves the extension folder");
	// The absolute path that was hashed is the path spawned, never a fresh PATH lookup.
	// The extension's folder is its working directory, so relative arguments mean its own files.
	const transport = new StdioTransport(program.path, args, undefined, fs.realpathSync(dir));
	await transport.start();
	// The host leaving, or a terminating signal, takes the child with it.
	track(transport);

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
		untrack(transport);
		throw err;
	}

	const tools: ProcessExtension["tools"] = {};
	for (const t of listed) {
		tools[t.name] = async (callArgs = {}) => {
			// Reaching here means a person is attended or approved this run in advance,
			// for this program: either way the person answered, so the gate sees attended.
			const blocked = refusal(manifest, t.name, true);
			if (blocked) return blocked;
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
			untrack(transport);
		},
	};
}

// ── 8gent ext ────────────────────────────────────────────────────────────────

const EXTENSIONS_ROOT = () => path.resolve(process.env.HOME ?? "~", ".8gent", "extensions");

/** "90m", "1h", "45s" or a bare number of minutes. */
export function parseTtl(v: string | undefined): number | null {
	if (v === undefined) return DEFAULT_TTL_MS;
	const m = /^(\d+)(s|m|h)?$/.exec(v.trim());
	if (!m) return null;
	const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "m"];
	return ms > 0 && ms <= MAX_TTL_MS ? ms : null;
}

/**
 * `8gent ext enable <name>` and `8gent ext approve-run <name> [--ttl 1h]`.
 * Both ask a person at a terminal, default No. Returns the exit code.
 */
export async function runExtCli(
	argv: string[],
	opts: {
		root?: string;
		log?: (line: string) => void;
		ask?: (q: string) => Promise<boolean>;
	} = {},
): Promise<number> {
	const log = opts.log ?? console.log;
	const ask = opts.ask ?? promptDefaultNo;
	const [sub, name, ...rest] = argv;
	const usage = "Usage: 8gent ext enable <name> | 8gent ext approve-run <name> [--ttl 1h]";
	if (!sub || !name || (sub !== "enable" && sub !== "approve-run")) {
		log(usage);
		return 2;
	}
	// A folder name only: never a path out of the extensions folder.
	if (
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".." ||
		UNSAFE.test(name)
	) {
		log("Not an extension name.");
		return 2;
	}
	const dir = path.join(opts.root ?? EXTENSIONS_ROOT(), name);
	if (!fs.existsSync(dir)) {
		log(`No extension named ${JSON.stringify(name)} is installed.`);
		return 1;
	}
	const legacy = !fs.existsSync(path.join(dir, PROCESS_MANIFEST));

	if (sub === "enable") {
		const ok = await enableExtension(dir, legacy ? "8gent-extension.json" : PROCESS_MANIFEST, ask);
		log(ok ? "enabled" : "not enabled");
		return ok ? 0 : 1;
	}

	const ttlFlag = rest.indexOf("--ttl");
	const ttl = parseTtl(ttlFlag >= 0 ? rest[ttlFlag + 1] : undefined);
	if (ttl === null) {
		log("--ttl must be like 30m or 2h, at most 24h.");
		return 2;
	}
	if (legacy) {
		log("Only out-of-process extensions (manifest.json) can be approved for a run.");
		return 1;
	}
	const read = readManifestFile(dir, PROCESS_MANIFEST);
	if (!read || read.grant.state !== "ok") {
		log(
			read?.grant.state === "changed"
				? read.grant.message
				: `not enabled; run 8gent ext enable ${name} first`,
		);
		return 1;
	}
	const minutes = Math.round(ttl / 60_000);
	const program = read.grant.fp.program?.path ?? "";
	if (
		!(await ask(
			`Let extension ${JSON.stringify(name)} start once, with nobody at the keyboard, within ${minutes} min? It runs ${JSON.stringify(program)}.`,
		))
	) {
		log("not approved");
		return 1;
	}
	const run = newRunId();
	pruneRuns();
	const token = mintApproval({ ext: name, grant: read.grant.hash, run, ttlMs: ttl });
	log(`Approved ${name} for one run, until ${new Date(Date.now() + ttl).toISOString()}.`);
	log("Set both in that run's environment:");
	log(`EIGHT_RUN_ID=${run}`);
	log(`EIGHT_EXT_APPROVAL=${token}`);
	return 0;
}

if (import.meta.main) process.exitCode = await runExtCli(process.argv.slice(2));
