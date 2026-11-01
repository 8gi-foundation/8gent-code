/**
 * Lean MCP tool access (#3474), behind EIGHT_MCP_LEAN=1 (exactly "1"), on the
 * text-tool path (ToolExecutor). Concept from Uber's "Designing MCP Gateway";
 * no code taken. Full behaviour and what is not covered: CHANGELOG #3474.
 *
 *   mcp_list_tools {query?, server?}  -> top 8 matching tools, one line each
 *   mcp_list_tools {tool, server?}    -> that one tool's full input schema
 *   mcp_call_tool {..., fields?}      -> keep only those dotted paths
 *   any result over RESULT_CAP chars  -> spilled to a harness-named 0600 file
 *
 * Servers start on first lean use, only after one approval card per session
 * that names every server in full. Server output is untrusted: capped before
 * any regex, scrubbed before projection and again after, never names a file.
 */

import { randomUUID } from "node:crypto";
import {
	constants,
	closeSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/home";
import type { MCPClient, MCPToolResult } from "./client";
import type { ServerConfig } from "./config";
import { clean, formatToolResult } from "./index";

export const RESULT_CAP = 4000;
export const PREVIEW = 400;
const HARD_MAX = 10_000_000; // chars read from a server at all
const PARSE_MAX = 2_000_000; // chars handed to JSON.parse for projection
const TOP = 8;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type Client = Pick<
	MCPClient,
	"listTools" | "callTool" | "isConnected" | "connect" | "loadServerConfigs" | "close"
>;

/** Asks the person before servers start: null to go ahead, else the refusal. */
export type StartApproval = (servers: string[]) => Promise<string | null>;

export { clean };

/**
 * Config env names a server may set while the flag is a trial: credential
 * shapes only. Any other name (PATH, NODE_OPTIONS, HOME ...) can change what
 * runs, so the card would not show what really runs.
 */
const CREDENTIAL_ENV = /^[A-Z][A-Z0-9_]*_(TOKEN|KEY|SECRET|PASSWORD|ID)$/;
export function isCredentialEnv(name: string): boolean {
	return CREDENTIAL_ENV.test(name);
}

const quote = (a: string) => (a === "" || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a);

/** One card line per server: what runs or is contacted, and env NAMES, never values. */
export function describeServer(cfg: ServerConfig): string {
	if (cfg.type === "stdio") {
		const env = Object.keys(cfg.env ?? {});
		const line = `${cfg.name}: ${[cfg.command, ...(cfg.args ?? [])].map((a) => quote(String(a))).join(" ")}${env.length ? ` (env: ${env.join(", ")})` : ""}`;
		return clean(line, line.length, true);
	}
	let where = String(cfg.url);
	try {
		const u = new URL(where);
		// Credentials in a URL are config secrets, not what the person decides on.
		where = `${u.protocol}//${u.host}${u.pathname}${u.search ? "?..." : ""}`;
	} catch {}
	const line = `${cfg.name}: ${where}`;
	return clean(line, line.length, true);
}

/** Why these servers may not be offered for approval at all, or null. */
function startRefusal(read: ServerConfig[]): string | null {
	const other = read.flatMap((c) =>
		c.type === "stdio"
			? Object.keys(c.env ?? {})
					.filter((k) => !isCredentialEnv(k))
					.map((k) => `${clean(c.name, 80, true)} sets ${clean(k, 80, true)}`)
			: [],
	);
	if (other.length)
		return `[BLOCKED] MCP servers were not started: ${other.join("; ")} in its config env. While EIGHT_MCP_LEAN is a trial, a server's config env may only set credential names (upper case, ending _TOKEN, _KEY, _SECRET, _PASSWORD or _ID): any other variable can change what program runs or what code it loads, so the approval card could not show what would really run. No server was started. Remove that variable from ~/.8gent/mcp.json, then restart the session to be asked again.`;
	return null;
}

interface StartState {
	tries: number;
	approved?: ServerConfig[];
	refused?: string;
	inflight?: Promise<string | null>;
	exitHook?: boolean;
}
const starts = new WeakMap<object, StartState>();

/** Start the configured servers once the person approved the exact list; null to go on, else the refusal. */
export async function ensureConnected(
	client: Client,
	mayStart: boolean,
	approve: StartApproval | undefined,
): Promise<string | null> {
	if (!mayStart || client.isConnected()) return null;
	let st = starts.get(client);
	if (!st) starts.set(client, (st = { tries: 0 }));
	if (st.inflight) return st.inflight;
	if (st.refused) return st.refused;
	if (st.tries >= 2) return null;
	const state = st;
	state.inflight = (async () => {
		try {
			let configs = state.approved;
			if (!configs) {
				const read = client.loadServerConfigs();
				if (read.length === 0) return null;
				const lines = read.map(describeServer);
				const refusal =
					startRefusal(read) ??
					(approve
						? await approve(lines)
						: "[BLOCKED] MCP servers cannot start: no approval path. No server was started. Restart the session to be asked again.");
				if (refusal) {
					state.refused = refusal;
					return refusal;
				}
				configs = state.approved = read;
			}
			state.tries++;
			if (!state.exitHook) {
				state.exitHook = true;
				process.once("exit", () => client.close());
			}
			await client.connect(configs);
			return null;
		} finally {
			state.inflight = undefined;
		}
	})();
	return state.inflight;
}

export function leanListTools(client: Client, args: Record<string, unknown>): string {
	const all = client
		.listTools()
		.slice(0, 5000)
		.filter((e) => e?.tool && typeof e.tool === "object");
	if (all.length === 0) return "No MCP tools available. Configure servers in ~/.8gent/mcp.json";
	const server = typeof args.server === "string" ? args.server : "";
	const pool = server ? all.filter((e) => e.server === server) : all;
	const label = (e: (typeof all)[number]) =>
		`${clean(e.server, 80, true)}/${clean(e.tool.name, 120, true)}`;

	if (typeof args.tool === "string" && args.tool) {
		const hits = pool.filter((e) => e.tool.name === args.tool);
		if (hits.length !== 1) {
			const where = hits.map(label).join(", ");
			return hits.length
				? `"${clean(args.tool, 120, true)}" is on several servers (${where}); pass server.`
				: `No MCP tool named "${clean(args.tool, 120, true)}". Search with mcp_list_tools {"query": "..."}.`;
		}
		let schema = "{}";
		try {
			schema = JSON.stringify(hits[0].tool.inputSchema ?? {}, null, 2) ?? "{}";
		} catch {}
		return `${label(hits[0])}\n${clean(hits[0].tool.description, 2000)}\ninputSchema:\n${clean(schema, 8000)}`;
	}

	const words = clean(args.query, 200)
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1)
		.slice(0, 10);
	if (words.length === 0 && !server) {
		const counts = new Map<string, number>();
		for (const e of all) counts.set(e.server, (counts.get(e.server) ?? 0) + 1);
		const list = [...counts].map(([s, n]) => `${clean(s, 80, true)} (${n} tools)`).join(", ");
		return `MCP servers: ${list}\nSearch with mcp_list_tools {"query": "what you need"}; fetch one schema with {"tool": "<name>", "server": "<server>"}.`;
	}
	const scored = pool.map((e) => {
		const name = clean(e.tool.name, 120, true).toLowerCase();
		const desc = clean(e.tool.description, 500, true).toLowerCase();
		const score = words.reduce(
			(n, w) => n + (name.includes(w) ? 3 : 0) + (desc.includes(w) ? 1 : 0),
			0,
		);
		return { e, score };
	});
	const top = scored
		.filter((s) => s.score > 0 || words.length === 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, words.length ? TOP : 50);
	if (top.length === 0)
		return `No MCP tools match "${clean(args.query, 200, true)}". ${all.length} tools on ${new Set(all.map((e) => e.server)).size} servers; try other words.`;
	const lines = top.map(
		({ e }) => `- ${label(e)}: ${clean(clean(e.tool.description, 500).split("\n")[0], 120, true)}`,
	);
	return `${lines.join("\n")}\nFetch one tool's input schema with mcp_list_tools {"tool": "<name>", "server": "<server>"}.`;
}

/** Keep only the requested dotted paths of a JSON answer. Own keys only; prototype keys refused. */
export function projectFields(text: string, fields: unknown): string {
	const list = (
		Array.isArray(fields) ? fields : typeof fields === "string" ? fields.split(",") : []
	)
		.filter((f): f is string => typeof f === "string")
		.map((f) => f.trim().slice(0, 200))
		.filter(Boolean)
		.slice(0, 20);
	if (list.length === 0) return text;
	if (text.length > PARSE_MAX)
		return `[fields ignored: result is ${text.length} chars, too large to parse]\n${text}`;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return `[fields ignored: result is not JSON]\n${text}`;
	}
	const out: Record<string, unknown> = Object.create(null);
	const missing: string[] = [];
	for (const f of list) {
		let cur: unknown = data;
		let found = true;
		for (const seg of f.split(".").slice(0, 12)) {
			if (
				BAD_KEYS.has(seg) ||
				cur === null ||
				typeof cur !== "object" ||
				!Object.hasOwn(cur, seg)
			) {
				found = false;
				break;
			}
			cur = (cur as Record<string, unknown>)[seg];
		}
		if (found) out[f] = cur;
		else missing.push(clean(f, 200, true));
	}
	const keys =
		data && typeof data === "object"
			? Object.keys(data)
					.slice(0, 40)
					.map((k) => clean(k, 60, true))
			: [];
	const note = missing.length
		? `\n[not found: ${missing.join(", ")}; top-level keys: ${keys.join(", ") || "none"}]`
		: "";
	return `${JSON.stringify(out, null, 2)}${note}`;
}

// Result store: a per-session 0700 dir under <dataDir>/tool-results, one 0600
// file per result, named by a harness-made handle (tool-agnostic, for #3477).
const sessionDirs = new Map<string, string>();
function sessionDir(dataDir: string): string {
	let dir = sessionDirs.get(dataDir);
	if (!dir) {
		const base = join(dataDir, "tool-results");
		mkdirSync(base, { recursive: true, mode: 0o700 });
		const st = lstatSync(base);
		if (st.isSymbolicLink() || !st.isDirectory())
			throw new Error(`${base} is not a plain directory`);
		dir = mkdtempSync(join(base, "s-")); // 0700, unique per session
		sessionDirs.set(dataDir, dir);
	}
	return dir;
}

/** Store a result; the handle and the file name are made here, never by the caller's data. */
export function storeResult(text: string, dataDir: string): { handle: string; path: string } {
	const handle = randomUUID();
	const path = join(sessionDir(dataDir), `${handle}.txt`);
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
	return { handle, path };
}

/** Cap, then spill to a file when over RESULT_CAP. Under the cap only control and bidi characters change. */
export function capResult(text: string, dataDir: string): string {
	if (text.length <= RESULT_CAP) return clean(text.replace(/\r\n/g, "\n"), RESULT_CAP);
	let where: string;
	try {
		where = `saved to ${storeResult(text, dataDir).path}`;
	} catch (err) {
		where = `could not be saved (${clean(err, 200, true)}); the rest was dropped`;
	}
	return `[MCP result: ${text.length} chars, over the ${RESULT_CAP}-char cap; ${where}]\nPreview (first ${PREVIEW} chars):\n${clean(text, PREVIEW)}\n[To read more: call again with fields: ["a.b"] to keep only what you need, or search the file with run_command (grep -n "term" <path>).]`;
}

export async function leanCallTool(
	client: Client,
	args: Record<string, unknown>,
	scrub: (text: string) => string,
	approveStart: StartApproval | undefined,
	dataDir = join(resolveHome(), ".8gent"),
): Promise<string> {
	try {
		const refused = await ensureConnected(client, true, approveStart);
		if (refused) return refused;
		const raw = (await client.callTool(
			String(args.server),
			String(args.tool),
			args.args as Record<string, unknown>,
		)) as MCPToolResult | undefined;
		const parts = Array.isArray(raw?.content)
			? raw.content.filter((p) => p && typeof p === "object")
			: [];
		const text = scrub(formatToolResult({ content: parts }).slice(0, HARD_MAX));
		const shaped = raw?.isError ? text : projectFields(text, args.fields);
		// Projection re-encodes JSON, which can unescape a secret: scrub what will be kept.
		return capResult(shaped === text ? text : scrub(shaped), dataDir);
	} catch (err) {
		return `MCP call tool failed: ${clean(err, 500)}`;
	}
}

export async function leanListToolsConnected(
	client: Client,
	args: Record<string, unknown>,
	mayStart: boolean,
	approveStart: StartApproval | undefined,
): Promise<string> {
	try {
		const refused = await ensureConnected(client, mayStart, approveStart);
		if (refused) return refused;
		if (!mayStart && !client.isConnected())
			return "MCP servers are not started in Plan mode. Leave Plan mode to list their tools.";
		return leanListTools(client, args);
	} catch (err) {
		return `MCP list tools failed: ${clean(err, 500)}`;
	}
}
