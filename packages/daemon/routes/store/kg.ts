/**
 * kg.* JSON-RPC handlers - file ingestion + retrieval over MemoryStore.
 *
 * Files are chunked (~1000 char windows w/ 200 overlap) and written into
 * the global memory DB at `~/.8gent/memory/memory.db` as `working` memories
 * with `source = "file"` and `sourceId = "<filePath>"`. Per-conversation
 * scope writes use `scope = "session"` plus a `conversationId` tag in the
 * memory data; global scope writes use `scope = "global"`.
 *
 * Search reuses MemoryStore.recall() filtered by source/scope.
 *
 * Sensitive-file gate (8SO redline):
 *   - filename gate: env / pem / id_rsa / *_secret* / *_credential*
 *   - content gate: scrub() from packages/eight/secret-scanner.ts; if any
 *     redactedCount > 0, the add is blocked unless caller passes
 *     { confirmedNoSecrets: true }.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrub } from "../../../eight/secret-scanner";
import { getEmbeddingProvider } from "../../../memory/embeddings";
import { MemoryStore } from "../../../memory/store";
import type { Memory, MemoryScope, WorkingMemory } from "../../../memory/types";
import { logKgOp } from "./audit";
import { JSONRPC_BLOCKED, JsonRpcError, type JsonRpcContext, type JsonRpcHandler } from "./jsonrpc";
import { classifySensitivePath } from "./sensitive";

// ── Store ─────────────────────────────────────────────────────────────

let _store: MemoryStore | null = null;
let _storePath: string | null = null;

function defaultDbPath(): string {
	const dir = path.join(
		process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
		"memory",
	);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, "memory.db");
}

async function store(): Promise<MemoryStore> {
	const dbPath = _storePath ?? defaultDbPath();
	if (_store) return _store;
	_store = new MemoryStore(dbPath);
	try {
		const provider = await getEmbeddingProvider();
		if (provider.available) _store.setEmbeddingProvider(provider);
	} catch {
		// Embeddings are optional; FTS-only fallback is fine.
	}
	return _store;
}

/** Test hook: rebind the store to a fresh on-disk DB. */
export function _setKgStorePath(dbPath: string | null): void {
	if (_store) {
		try {
			_store.close();
		} catch {}
	}
	_store = null;
	_storePath = dbPath;
}

// ── Sensitive-file gates ──────────────────────────────────────────────

/**
 * Returns a reason string if the path is sensitive (or forbidden), null
 * otherwise. Uses the shared `classifySensitivePath` helper so the same
 * redlines apply to fs.write and kg.add.
 */
function looksSensitive(filePath: string): string | null {
	const check = classifySensitivePath(filePath);
	if (check.forbidden) return check.reason ?? "forbidden path";
	if (check.sensitive) return check.reason ?? "sensitive path";
	return null;
}

function contentHasSecrets(content: string): { detected: boolean; rules: string[] } {
	// Reuse the existing scrubber. If it would redact anything, the file
	// contains material we won't ingest without explicit confirmation.
	const result = scrub(content);
	return { detected: result.redactedCount > 0, rules: result.rules };
}

// ── Chunking ──────────────────────────────────────────────────────────

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

interface FileChunk {
	index: number;
	text: string;
	start: number;
	end: number;
}

function chunkText(text: string): FileChunk[] {
	const chunks: FileChunk[] = [];
	if (!text) return chunks;
	let start = 0;
	let index = 0;
	while (start < text.length) {
		const end = Math.min(text.length, start + CHUNK_SIZE);
		const slice = text.slice(start, end);
		chunks.push({ index, text: slice, start, end });
		index += 1;
		if (end === text.length) break;
		start = end - CHUNK_OVERLAP;
		if (start <= 0) start = end; // safety
	}
	return chunks;
}

// ── Helpers ───────────────────────────────────────────────────────────

interface ChunkData {
	parentFile: string;
	chunkIndex: number;
	chunkStart: number;
	chunkEnd: number;
	conversationId: string | null;
	contentHash: string;
}

function isChunkData(value: unknown): value is ChunkData {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { parentFile?: unknown }).parentFile === "string" &&
		typeof (value as { chunkIndex?: unknown }).chunkIndex === "number"
	);
}

function memoryToHit(mem: Memory, score: number) {
	const value = (mem as { value?: unknown }).value;
	const valueStr = typeof value === "string" ? value : JSON.stringify(value ?? "");
	const meta = chunkDataFromMemory(mem);
	const parentFile = meta?.parentFile ?? (mem.sourceId ?? "").replace(/^file:/, "");
	const chunkIndex = meta?.chunkIndex ?? -1;
	return {
		chunkId: mem.id,
		source: parentFile,
		snippet: valueStr.slice(0, 280),
		score,
		chunkIndex,
	};
}

function chunkDataFromMemory(mem: Memory): ChunkData | null {
	// We stored the chunk data inside `value` for `working` memories.
	if (mem.type !== "working") return null;
	const value = (mem as { value?: unknown }).value;
	if (typeof value !== "string") return null;
	// Working memory key holds the JSON-encoded ChunkData; value holds the text.
	const key = (mem as { key?: string }).key;
	if (!key) return null;
	try {
		const parsed = JSON.parse(key) as unknown;
		return isChunkData(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

// ── Handlers ──────────────────────────────────────────────────────────

interface KgAddParams {
	filePath: string;
	scope?: "conversation" | "global";
	conversationId?: string | null;
	confirmedNoSecrets?: boolean;
}

interface KgSearchParams {
	query: string;
	scope?: "conversation" | "global";
	conversationId?: string | null;
	k?: number;
}

interface KgInspectParams {
	filePath: string;
	conversationId?: string | null;
}

interface KgDeleteParams {
	filePath?: string;
	chunkId?: string;
	conversationId?: string | null;
}

interface KgStatusParams {
	filePath: string;
	conversationId?: string | null;
}

function ensureScopeOk(scope: "conversation" | "global", conversationId?: string | null): string | null {
	if (scope === "conversation" && !conversationId) {
		throw new Error("kg: scope=conversation requires conversationId");
	}
	return scope === "conversation" ? conversationId ?? null : null;
}

export const kgAdd: JsonRpcHandler = async (raw, ctx: JsonRpcContext) => {
	const params = raw as KgAddParams;
	if (!params?.filePath) throw new Error("kg.add: missing filePath");
	const scope = params.scope ?? "conversation";
	const convId = ensureScopeOk(scope, params.conversationId);
	const filePath = path.resolve(params.filePath);

	// Filename gate (cheap, runs before reading content).
	const nameReason = looksSensitive(filePath);
	if (nameReason && !params.confirmedNoSecrets) {
		logKgOp({
			op: "blocked",
			file: filePath,
			scope,
			conversationId: convId,
			initiator: ctx.initiator,
			reason: nameReason,
		});
		throw new JsonRpcError(JSONRPC_BLOCKED, "blocked: sensitive file", {
			blocked: true,
			reason: nameReason,
		});
	}

	if (!fs.existsSync(filePath)) {
		throw new Error(`kg.add: file not found: ${filePath}`);
	}
	const stat = fs.statSync(filePath);
	if (!stat.isFile()) {
		throw new Error(`kg.add: not a regular file: ${filePath}`);
	}
	if (stat.size > 5 * 1024 * 1024) {
		throw new Error(`kg.add: file too large (>5MB): ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");

	// Content gate.
	const { detected, rules } = contentHasSecrets(content);
	if (detected && !params.confirmedNoSecrets) {
		const reason = `content matches credential pattern(s): ${rules.join(", ")}`;
		logKgOp({
			op: "blocked",
			file: filePath,
			scope,
			conversationId: convId,
			initiator: ctx.initiator,
			reason,
		});
		throw new JsonRpcError(JSONRPC_BLOCKED, "blocked: content contains secrets", {
			blocked: true,
			reason,
			rules,
		});
	}

	// Idempotency: if the same content hash for the same scope+convId+file is
	// already ingested, return the existing chunk ids without re-writing.
	const contentHash = crypto.createHash("sha256").update(content).digest("hex");

	const existingForFile = await listChunksForFile(filePath, convId);
	if (existingForFile.length > 0) {
		const sameHash = existingForFile.every((c) => {
			const meta = chunkDataFromMemory(c);
			return meta?.contentHash === contentHash;
		});
		if (sameHash) {
			return {
				chunkIds: existingForFile.map((c) => c.id),
				chunkCount: existingForFile.length,
				idempotent: true,
				contentHash,
			};
		}
		// Content changed: blow the old chunks away first.
		const s = await store();
		for (const c of existingForFile) s.forget(c.id, "kg.add: content changed");
	}

	// Chunk + write.
	const chunks = chunkText(content);
	const s = await store();
	const memoryScope: MemoryScope = scope === "global" ? "global" : "session";
	const now = Date.now();
	const ids: string[] = [];
	for (const chunk of chunks) {
		const meta: ChunkData = {
			parentFile: filePath,
			chunkIndex: chunk.index,
			chunkStart: chunk.start,
			chunkEnd: chunk.end,
			conversationId: convId,
			contentHash,
		};
		// Build a real WorkingMemory value. Every required field is populated
		// even if we don't surface it over the wire. The previous
		// `as unknown as Memory` cast hid this from the type checker. `tags`
		// is added on top via index access since extractTags reads it at
		// runtime; WorkingMemory itself doesn't declare a tags field.
		const memory: WorkingMemory = {
			id: "",
			type: "working",
			scope: memoryScope,
			sessionId: convId ?? "kg",
			key: JSON.stringify(meta),
			value: chunk.text,
			priority: 1,
			ttlMs: 0,
			expiresAt: 0,
			importance: 0.5,
			decayFactor: 1.0,
			accessCount: 0,
			lastAccessed: now,
			version: 1,
			source: "import",
			sourceId: `file:${filePath}`,
			createdAt: now,
			updatedAt: now,
		};
		// Attach tags out-of-band so extractTags can pick them up. The runtime
		// code reads `memory.tags`; the static type doesn't declare it, so we
		// stash it via a typed extension instead of `as any`.
		(memory as WorkingMemory & { tags: string[] }).tags = [
			`file:${path.basename(filePath)}`,
			"kg",
			scope,
		];
		const id = s.write(memory);
		ids.push(id);
	}

	logKgOp({
		op: "add",
		file: filePath,
		chunks: ids.length,
		embeddingModel: getEmbeddingModel(),
		scope,
		conversationId: convId,
		initiator: ctx.initiator,
	});

	return { chunkIds: ids, chunkCount: ids.length, idempotent: false, contentHash };
};

export const kgSearch: JsonRpcHandler = async (raw, _ctx) => {
	const params = raw as KgSearchParams;
	if (!params?.query) throw new Error("kg.search: missing query");
	const scope = params.scope ?? "conversation";
	const convId = ensureScopeOk(scope, params.conversationId);
	const k = Math.min(Math.max(params.k ?? 8, 1), 50);

	const s = await store();
	const memoryScope: MemoryScope = scope === "global" ? "global" : "session";
	const results = await s.recall(params.query, {
		limit: k * 3,
		scope: memoryScope,
		types: ["working"],
	});

	const filtered = results.filter((r) => {
		if (r.memory.source !== "import") return false;
		if (!(r.memory.sourceId ?? "").startsWith("file:")) return false;
		const meta = chunkDataFromMemory(r.memory);
		if (!meta) return false;
		if (scope === "conversation" && meta.conversationId !== convId) return false;
		if (scope === "global" && meta.conversationId !== null) return false;
		return true;
	});

	return {
		hits: filtered.slice(0, k).map((r) => memoryToHit(r.memory, r.score)),
	};
};

export const kgInspect: JsonRpcHandler = async (raw, _ctx) => {
	const params = raw as KgInspectParams;
	if (!params?.filePath) throw new Error("kg.inspect: missing filePath");
	const filePath = path.resolve(params.filePath);
	const convId = params.conversationId ?? null;
	const chunks = await listChunksForFile(filePath, convId);

	let lastReindex = 0;
	const exposed = chunks.map((c) => {
		const meta = chunkDataFromMemory(c);
		if (c.updatedAt > lastReindex) lastReindex = c.updatedAt;
		return {
			chunkId: c.id,
			chunkIndex: meta?.chunkIndex ?? -1,
			chunkStart: meta?.chunkStart ?? 0,
			chunkEnd: meta?.chunkEnd ?? 0,
			conversationId: meta?.conversationId ?? null,
			contentHash: meta?.contentHash ?? null,
		};
	});

	return {
		chunks: exposed,
		embeddingModel: getEmbeddingModel(),
		lastReindex: lastReindex || null,
	};
};

export const kgDelete: JsonRpcHandler = async (raw, ctx: JsonRpcContext) => {
	const params = raw as KgDeleteParams;
	if (!params?.filePath && !params?.chunkId) {
		throw new Error("kg.delete: requires filePath or chunkId");
	}
	const s = await store();
	let deleted = 0;
	if (params.chunkId) {
		const ok = s.forget(params.chunkId, "kg.delete by chunkId");
		deleted = ok ? 1 : 0;
		logKgOp({
			op: "delete",
			chunkId: params.chunkId,
			initiator: ctx.initiator,
		});
	} else if (params.filePath) {
		const filePath = path.resolve(params.filePath);
		const convId = params.conversationId ?? null;
		const chunks = await listChunksForFile(filePath, convId);
		for (const c of chunks) {
			if (s.forget(c.id, "kg.delete by filePath")) deleted += 1;
		}
		logKgOp({
			op: "delete",
			file: filePath,
			chunks: deleted,
			conversationId: convId,
			initiator: ctx.initiator,
		});
	}
	return { deleted };
};

export const kgStatus: JsonRpcHandler = async (raw, _ctx) => {
	const params = raw as KgStatusParams;
	if (!params?.filePath) throw new Error("kg.status: missing filePath");
	const filePath = path.resolve(params.filePath);
	const convId = params.conversationId ?? null;
	const chunks = await listChunksForFile(filePath, convId);
	let lastReindex = 0;
	for (const c of chunks) if (c.updatedAt > lastReindex) lastReindex = c.updatedAt;
	return {
		ingested: chunks.length > 0,
		chunkCount: chunks.length,
		lastReindex: lastReindex || null,
	};
};

// ── Internal ──────────────────────────────────────────────────────────

async function listChunksForFile(filePath: string, conversationId: string | null): Promise<Memory[]> {
	const s = await store();
	const rows = s
		.getDb()
		.prepare(
			`SELECT data FROM memories
			 WHERE deleted_at IS NULL
			   AND source = 'import'
			   AND source_id = ?
			   AND type = 'working'`,
		)
		.all(`file:${filePath}`) as Array<{ data: string }>;
	const memories: Memory[] = [];
	for (const row of rows) {
		try {
			const mem = JSON.parse(row.data) as Memory;
			const meta = chunkDataFromMemory(mem);
			if (!meta) continue;
			if (conversationId === null) {
				if (meta.conversationId !== null) continue;
			} else if (meta.conversationId !== conversationId) {
				continue;
			}
			memories.push(mem);
		} catch {
			// Skip corrupt rows.
		}
	}
	memories.sort((a, b) => {
		const ai = chunkDataFromMemory(a)?.chunkIndex ?? 0;
		const bi = chunkDataFromMemory(b)?.chunkIndex ?? 0;
		return ai - bi;
	});
	return memories;
}

function getEmbeddingModel(): string {
	if (!_store) return "none";
	try {
		// MemoryStore exposes the provider through hasNativeVectorSearch only.
		// We track the model name through the embeddings row when present;
		// for the audit log, "auto" is a fine placeholder if we can't resolve.
		const row = _store
			.getDb()
			.prepare("SELECT model FROM embeddings ORDER BY created_at DESC LIMIT 1")
			.get() as { model?: string } | null;
		return row?.model ?? "none";
	} catch {
		return "none";
	}
}
