/**
 * Lean MCP tool access (#3474), behind EIGHT_MCP_LEAN=1 (exactly "1"; any
 * other value, unset included, leaves the old behaviour byte for byte).
 *
 * Concept from Uber's "Designing MCP Gateway" (search, schema on demand,
 * response projection, spill to file); no code taken from it.
 *
 *   mcp_list_tools {query?, server?}  -> top 8 matching tools, one line each
 *   mcp_list_tools {tool, server?}    -> that one tool's full input schema
 *   mcp_call_tool {..., fields?}      -> keep only those dotted paths
 *   any result over RESULT_CAP chars  -> written to a harness-named 0600 file
 *                                        (O_EXCL, O_NOFOLLOW) in a per-session
 *                                        0700 dir under <data dir>/tool-results;
 *                                        the model gets the path and a preview
 *
 * Before this, MCP was unreachable from a local model's turn: nothing in the
 * runtime called MCPClient.connect(), the stdio transport could not write
 * (fixed in packages/mcp/transport.ts), and the text-tool path never offered
 * the MCP tools. With the flag on, this path connects the configured servers
 * lazily on first use and serves them lean.
 *
 * Covered: the text-tool path (ToolExecutor in packages/eight/tools.ts, the
 * local-provider path the TUI uses with ollama / lmstudio / llama-server).
 * NOT covered: the native AI SDK tools (packages/ai/tools.ts), the bridged
 * per-tool ToolSet (client.getTools), the REPL /mcp-tools command. None of
 * them connects a server, so they still reach no MCP tool at all; the lean
 * path's connect happens to make them see this process's servers afterwards,
 * in full and untrimmed.
 *
 * Starting servers: the first lean mcp_list_tools or mcp_call_tool starts
 * every server in ~/.8gent/mcp.json (their processes, as configured). Listing
 * is ungated and allowed in Plan mode, so in Plan mode the lean path does not
 * start servers; it lists only servers already running. A failed connect is
 * retried once, on the next call.
 *
 * Secrets: callers pass the executor's secret scrubber; it runs on the answer
 * before projection, spill or preview, so nothing written to disk or shown
 * holds a secret the scanner knows (the #2464 "scrub before persist" order).
 *
 * Spill files: a per-session 0700 dir under <data dir>/tool-results; dirs of
 * earlier sessions older than 7 days are removed when a new one is made.
 * ArtifactStore (packages/eight/artifact-store.ts, #2463) still chips every
 * executor result over 50,000 bytes; #3477 should keep one of the two stores.
 *
 * Server output is untrusted: it is capped before any regex, parsed inside
 * try, never chooses a file name, and control / bidi characters are replaced
 * before anything is echoed.
 */

import { randomUUID } from "node:crypto";
import {
	constants,
	closeSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/home";
import type { MCPClient, MCPToolResult } from "./client";
import { formatToolResult } from "./index";

export const RESULT_CAP = 4000;
export const PREVIEW = 400;
const HARD_MAX = 10_000_000; // chars read from a server at all
const PARSE_MAX = 2_000_000; // chars handed to JSON.parse for projection
const TOP = 8;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type Client = Pick<MCPClient, "listTools" | "callTool" | "isConnected" | "connect">;

/** Replace control and bidi characters; keep newlines and tabs unless oneLine. */
export function clean(value: unknown, max: number, oneLine = false): string {
	const s = String(value ?? "").slice(0, max);
	const out = s.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
		"?",
	);
	return oneLine ? out.replace(/[\n\t]+/g, " ") : out;
}

const tries = new WeakMap<object, number>();
/** Connect the configured servers on first lean use (never at startup); one retry if none came up. */
export async function ensureConnected(client: Client, mayStart = true): Promise<void> {
	const n = tries.get(client) ?? 0;
	if (!mayStart || client.isConnected() || n >= 2) return;
	tries.set(client, n + 1);
	await client.connect();
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
// file per result, named by a harness-made handle. Kept tool-agnostic so the
// stale-output handles of #3477 can reuse it instead of building a second one.
const KEEP_MS = 7 * 24 * 3600_000;
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
		for (const name of readdirSync(base)) {
			const old = join(base, name);
			try {
				const o = lstatSync(old);
				if (
					name.startsWith("s-") &&
					old !== dir &&
					o.isDirectory() &&
					Date.now() - o.mtimeMs > KEEP_MS
				)
					rmSync(old, { recursive: true, force: true });
			} catch {}
		}
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

/** Cap, then spill to a file when over RESULT_CAP. Under the cap the text is returned as is. */
export function capResult(text: string, dataDir: string): string {
	if (text.length <= RESULT_CAP) return text;
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
	dataDir = join(resolveHome(), ".8gent"),
): Promise<string> {
	try {
		await ensureConnected(client);
		const raw = (await client.callTool(
			String(args.server),
			String(args.tool),
			args.args as Record<string, unknown>,
		)) as MCPToolResult | undefined;
		const parts = Array.isArray(raw?.content)
			? raw.content.filter((p) => p && typeof p === "object")
			: [];
		const text = scrub(formatToolResult({ content: parts }).slice(0, HARD_MAX));
		return capResult(raw?.isError ? text : projectFields(text, args.fields), dataDir);
	} catch (err) {
		return `MCP call tool failed: ${clean(err, 500)}`;
	}
}

export async function leanListToolsConnected(
	client: Client,
	args: Record<string, unknown>,
	mayStart: boolean,
): Promise<string> {
	try {
		await ensureConnected(client, mayStart);
		if (!mayStart && !client.isConnected())
			return "MCP servers are not started in Plan mode. Leave Plan mode to list their tools.";
		return leanListTools(client, args);
	} catch (err) {
		return `MCP list tools failed: ${clean(err, 500)}`;
	}
}
