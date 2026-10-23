/**
 * Read-only memory server (#4867). `8gent memory serve` speaks MCP over stdio
 * (newline-delimited JSON-RPC) so any other tool the person runs on their own
 * machine can recall what their 8gent learned.
 *
 * Guarantees, each pinned by serve.test.ts:
 *  - no network listener, no write path: the SQLite file opens readonly;
 *  - private rows never leave the process: tagged secret/private, marked
 *    #PRIVATE, or matching the redact.ts secret detectors, in search AND get;
 *  - every call is logged beside the db (JSONL, 0600): time, tool, query,
 *    result count. Never the result text.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./redact.js";

const MAX_LIMIT = 20;
const LOG_NAME = "memory-access.jsonl";
const PRIVATE_TAGS = new Set(["secret", "private"]);

interface Row {
	id: string;
	type: string;
	scope: string;
	content_text: string;
	data: string;
	tags: string | null;
	created_at: number;
}

/** Deterministic filter. True means the row must never leave the process. */
export function isPrivate(row: Pick<Row, "content_text" | "data" | "tags">): boolean {
	let tags: unknown[] = [];
	try {
		const parsed = JSON.parse(row.tags ?? "[]");
		if (Array.isArray(parsed)) tags = parsed;
	} catch {
		return true; // unreadable tags: fail closed
	}
	if (tags.some((t) => PRIVATE_TAGS.has(String(t).trim().toLowerCase().replace(/^#/, "")))) {
		return true;
	}
	for (const text of [row.content_text, row.data, row.tags ?? ""]) {
		if (/#private/i.test(text) || redact(text) !== text) return true;
	}
	return false;
}

export function defaultDbPath(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "memory", "memory.db");
}

export class MemoryReader {
	private db: Database;
	private logPath: string;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { readonly: true }); // no create, no write
		this.logPath = path.join(path.dirname(dbPath), LOG_NAME);
	}

	/** Test hook: the connection, so a test can prove writes are refused. */
	get connection(): Database {
		return this.db;
	}

	private log(tool: string, query: string, count: number): void {
		const line = JSON.stringify({ ts: new Date().toISOString(), tool, query, count });
		try {
			const fd = fs.openSync(this.logPath, "a", 0o600);
			fs.fchmodSync(fd, 0o600);
			fs.writeSync(fd, `${line}\n`);
			fs.closeSync(fd);
		} catch {
			/* a log failure must not take recall down, but never falls back to stdout */
		}
	}

	private shape(r: Row) {
		return { id: r.id, type: r.type, scope: r.scope, text: r.content_text, created_at: r.created_at };
	}

	search(query: string, limit: number) {
		const n = Math.min(Math.max(Math.trunc(limit) || 10, 1), MAX_LIMIT);
		// Same term rules as MemoryStore._ftsSearch: quoted prefix terms, OR-joined.
		const fts = query
			.replace(/[^\p{L}\p{N}_\s]/gu, "")
			.split(/\s+/)
			.filter((t) => [...t].length > 2)
			.map((t) => `"${t}"*`)
			.join(" OR ");
		let out: ReturnType<MemoryReader["shape"]>[] = [];
		if (fts) {
			try {
				const rows = this.db
					.prepare(
						`SELECT m.id, m.type, m.scope, m.content_text, m.data, m.tags, m.created_at
						 FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
						 WHERE memories_fts MATCH ? AND m.deleted_at IS NULL
						 ORDER BY rank LIMIT ?`,
					)
					.all(fts, MAX_LIMIT * 5) as Row[];
				out = rows
					.filter((r) => !isPrivate(r))
					.slice(0, n)
					.map((r) => this.shape(r));
			} catch {
				out = [];
			}
		}
		this.log("memory_search", query, out.length);
		return out;
	}

	get(id: string) {
		const row = this.db
			.prepare(
				`SELECT id, type, scope, content_text, data, tags, created_at
				 FROM memories WHERE id = ? AND deleted_at IS NULL`,
			)
			.get(id) as Row | null;
		// A private row answers exactly like a missing one.
		const result = row && !isPrivate(row) ? this.shape(row) : null;
		this.log("memory_get", id, result ? 1 : 0);
		return result;
	}

	close(): void {
		this.db.close();
	}
}

const TOOLS = [
	{
		name: "memory_search",
		description:
			"Input: query (string), limit (1-20, default 10). Full-text search of the person's own 8gent memory. Read-only.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" }, limit: { type: "number" } },
			required: ["query"],
		},
	},
	{
		name: "memory_get",
		description: "Input: id (string). Fetch one memory by id. Read-only.",
		inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
	},
];

type Json = Record<string, unknown>;

/** One JSON-RPC message in, zero or one out. Pure over the reader, so tests can call it directly. */
export function handle(reader: MemoryReader, msg: Json): Json | null {
	const id = (msg.id ?? null) as string | number | null;
	const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
	const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
	if (msg.id === undefined) return null; // notification
	const params = (msg.params ?? {}) as Json;
	switch (msg.method) {
		case "initialize":
			return ok({
				protocolVersion: (params.protocolVersion as string) || "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "8gent-memory", version: "1" },
			});
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: TOOLS });
		case "tools/call": {
			const args = (params.arguments ?? {}) as Json;
			const text = (v: unknown, isError = false) => ({
				content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }],
				isError,
			});
			if (params.name === "memory_search") {
				if (typeof args.query !== "string" || !args.query.trim()) {
					return ok(text("query must be a non-empty string", true));
				}
				return ok(text(reader.search(args.query, Number(args.limit ?? 10))));
			}
			if (params.name === "memory_get") {
				if (typeof args.id !== "string" || !args.id) return ok(text("id must be a string", true));
				const r = reader.get(args.id);
				return ok(r ? text(r) : text("not found", true));
			}
			return err(-32602, `unknown tool: ${String(params.name)}`);
		}
		default:
			return err(-32601, `method not found: ${String(msg.method)}`);
	}
}

/** Serve stdio until stdin closes. Nothing but protocol goes to stdout. */
export async function serveStdio(dbPath = defaultDbPath()): Promise<number> {
	if (!fs.existsSync(dbPath)) {
		console.error(`8gent memory serve: no memory file at ${dbPath}`);
		return 1;
	}
	const reader = new MemoryReader(dbPath);
	console.error(`8gent memory serve: read-only, ${dbPath}, log ${path.dirname(dbPath)}/${LOG_NAME}`);
	let buf = "";
	for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
		buf += chunk.toString("utf8");
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			if (!line) continue;
			let out: Json | null;
			try {
				out = handle(reader, JSON.parse(line) as Json);
			} catch {
				out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
			}
			if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
		}
	}
	reader.close();
	return 0;
}
