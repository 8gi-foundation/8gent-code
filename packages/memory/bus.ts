/**
 * Shared Memory Bus — unified conversation + knowledge store for external consumers.
 *
 * Wraps MemoryStore + KnowledgeGraph on a shared SQLite database.
 * Adds a `conversation_messages` table for structured conversation storage
 * (separate from the memories table which is for semantic knowledge).
 *
 * Consumers: control plane (discord), telegram bot, CLI, API.
 */

import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeGraph } from "./graph.js";
import { type MemoryHealth, memoryHealth } from "./health.js";
import { MemoryStore } from "./store.js";
import { generateId } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export type MemorySource = "cli" | "discord" | "telegram" | "api" | "system";

export interface ScopedMemoryOptions {
	source: MemorySource;
	scope: string; // e.g., "discord:channel-123:8EO" or "telegram:chat-456"
	authorId?: string;
	authorName?: string;
}

export interface ConversationEntry {
	role: "user" | "assistant";
	content: string;
	authorId?: string;
	authorName?: string;
	source: MemorySource;
	timestamp: number;
}

export interface SharedMemoryBus {
	/** Store a conversation message with source/scope metadata */
	storeMessage(
		content: string,
		role: "user" | "assistant",
		options: ScopedMemoryOptions,
	): string;

	/** Recall recent conversation for a scope */
	getConversation(scope: string, limit?: number): ConversationEntry[];

	/** Recall cross-scope conversation (e.g., all messages in a channel regardless of member) */
	getChannelConversation(
		channelPrefix: string,
		limit?: number,
	): ConversationEntry[];

	/** Store a semantic memory (fact, preference, decision) */
	remember(
		content: string,
		type: "core" | "episodic" | "semantic" | "procedural",
		options: ScopedMemoryOptions & { importance?: number; tags?: string[] },
	): string;

	/** Search memories with scope filtering */
	recall(
		query: string,
		options?: {
			scope?: string;
			source?: MemorySource;
			limit?: number;
		},
	): Promise<
		Array<{
			id: string;
			content: string;
			score: number;
			source: string;
			scope: string;
		}>
	>;

	/** Get the knowledge graph instance for direct queries */
	graph(): KnowledgeGraph;

	/** Get health status */
	health(): MemoryHealth;

	/** Get the underlying database (for advanced queries) */
	database(): Database;
}

// ── Schema ───────────────────────────────────────────────────────────

const CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_messages (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  channel_prefix TEXT NOT NULL,
  role           TEXT NOT NULL,
  content        TEXT NOT NULL,
  author_id      TEXT,
  author_name    TEXT,
  source         TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_scope ON conversation_messages(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_channel ON conversation_messages(channel_prefix, created_at);
`;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract channel prefix from a scope string.
 * "discord:channel-123:8EO" -> "discord:channel-123"
 * "telegram:chat-456" -> "telegram:chat-456"
 */
function extractChannelPrefix(scope: string): string {
	const parts = scope.split(":");
	if (parts.length <= 2) return scope;
	return parts.slice(0, -1).join(":");
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSharedMemoryBus(dbPath: string): SharedMemoryBus {
	// Ensure parent directory exists
	const dir = path.dirname(dbPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const store = new MemoryStore(dbPath);
	const db = store.getDb();
	const kg = new KnowledgeGraph(db);

	// Create conversation_messages table
	db.exec(CONVERSATION_SCHEMA);

	// ── Prepared statements ──────────────────────────────────────────

	const insertMsg = db.prepare(`
    INSERT INTO conversation_messages
      (id, scope, channel_prefix, role, content, author_id, author_name, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	const selectByScope = db.prepare(`
    SELECT role, content, author_id, author_name, source, created_at
    FROM conversation_messages
    WHERE scope = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

	const selectByChannel = db.prepare(`
    SELECT role, content, author_id, author_name, source, created_at
    FROM conversation_messages
    WHERE channel_prefix = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

	// ── Bus implementation ───────────────────────────────────────────

	return {
		storeMessage(
			content: string,
			role: "user" | "assistant",
			options: ScopedMemoryOptions,
		): string {
			const id = generateId("mem");
			const now = Date.now();
			const channelPrefix = extractChannelPrefix(options.scope);

			insertMsg.run(
				id,
				options.scope,
				channelPrefix,
				role,
				content,
				options.authorId ?? null,
				options.authorName ?? null,
				options.source,
				now,
			);

			return id;
		},

		getConversation(scope: string, limit = 50): ConversationEntry[] {
			const rows = selectByScope.all(scope, limit) as Array<{
				role: string;
				content: string;
				author_id: string | null;
				author_name: string | null;
				source: string;
				created_at: number;
			}>;

			// Reverse so oldest-first (natural reading order)
			return rows.reverse().map((r) => ({
				role: r.role as "user" | "assistant",
				content: r.content,
				authorId: r.author_id ?? undefined,
				authorName: r.author_name ?? undefined,
				source: r.source as MemorySource,
				timestamp: r.created_at,
			}));
		},

		getChannelConversation(
			channelPrefix: string,
			limit = 50,
		): ConversationEntry[] {
			const rows = selectByChannel.all(channelPrefix, limit) as Array<{
				role: string;
				content: string;
				author_id: string | null;
				author_name: string | null;
				source: string;
				created_at: number;
			}>;

			return rows.reverse().map((r) => ({
				role: r.role as "user" | "assistant",
				content: r.content,
				authorId: r.author_id ?? undefined,
				authorName: r.author_name ?? undefined,
				source: r.source as MemorySource,
				timestamp: r.created_at,
			}));
		},

		remember(
			content: string,
			type: "core" | "episodic" | "semantic" | "procedural",
			options: ScopedMemoryOptions & { importance?: number; tags?: string[] },
		): string {
			const now = Date.now();
			const id = generateId("mem");
			const importance = options.importance ?? 0.5;
			const tags = options.tags ?? [];

			// Build memory data with bus metadata embedded
			const data: Record<string, unknown> = {
				id,
				type,
				scope: "global",
				importance,
				decayFactor: 1.0,
				accessCount: 0,
				lastAccessed: now,
				createdAt: now,
				updatedAt: now,
				version: 1,
				source: "observation",
				// Bus-specific metadata
				busSource: options.source,
				busScope: options.scope,
				busAuthorId: options.authorId,
				busAuthorName: options.authorName,
			};

			// Type-specific fields
			if (type === "core") {
				Object.assign(data, {
					category: "convention",
					key: id,
					title: content.slice(0, 80),
					content,
					confidence: 0.7,
					evidenceCount: 1,
					tags,
				});
			} else if (type === "episodic") {
				Object.assign(data, {
					content,
					context: `via ${options.source}:${options.scope}`,
					tags,
					entities: [],
					occurredAt: now,
				});
			} else if (type === "semantic") {
				Object.assign(data, {
					category: "fact",
					key: id,
					value: content,
					confidence: 0.7,
					evidenceCount: 1,
					tags,
					relatedKeys: [],
					learnedAt: now,
					lastConfirmed: now,
				});
			} else if (type === "procedural") {
				Object.assign(data, {
					name: id,
					description: content,
					steps: [],
					preconditions: [],
					successRate: 0.5,
					executionCount: 0,
					tags,
				});
			}

			// Write directly to the memories table via MemoryStore
			store.write(data as any);
			return id;
		},

		async recall(
			query: string,
			options?: {
				scope?: string;
				source?: MemorySource;
				limit?: number;
			},
		) {
			const limit = options?.limit ?? 10;
			const results = await store.recall(query, { limit: limit * 3 }); // Over-fetch for post-filter

			const mapped = results
				.map((r) => {
					const raw = r.memory as any;
					return {
						id: raw.id,
						content:
							raw.content ?? raw.value ?? raw.description ?? raw.title ?? "",
						score: r.score,
						source: raw.busSource ?? raw.source ?? "",
						scope: raw.busScope ?? "",
					};
				})
				.filter((m) => {
					if (options?.scope && m.scope && !m.scope.startsWith(options.scope))
						return false;
					if (options?.source && m.source && m.source !== options.source)
						return false;
					return true;
				});

			return mapped.slice(0, limit);
		},

		graph(): KnowledgeGraph {
			return kg;
		},

		health(): MemoryHealth {
			return memoryHealth(db);
		},

		database(): Database {
			return db;
		},
	};
}

// ── Singleton ────────────────────────────────────────────────────────

let _bus: SharedMemoryBus | null = null;

export function getSharedMemoryBus(dbPath?: string): SharedMemoryBus {
	if (!_bus) {
		const resolvedPath =
			dbPath || path.join(os.homedir(), ".8gent", "memory", "shared-memory.db");
		_bus = createSharedMemoryBus(resolvedPath);
	}
	return _bus;
}

export function resetSharedMemoryBus(): void {
	_bus = null;
}
