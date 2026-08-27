/**
 * 8gent Table store (contract section 1.2 - 1.4).
 *
 * Backed by a NEW bun:sqlite DB at ~/.8gent/table/table.db (never the memory
 * DB). Mirrors packages/memory/store.ts for WAL + FTS5 patterns. Every
 * mutating method appends a signed entry to the hash-chained goal ledger
 * BEFORE returning: the SQLite row is the source of truth, the ledger is the
 * tamper-evident audit trail. If the append throws, the method throws and the
 * caller sees failure.
 *
 * Membership / authority is enforced in the store, not the caller:
 *   - write (post/edit/delete): members-only, always.
 *   - read (thread/list): members-only for PRIVATE channels when a viewer is
 *     supplied; open channels are readable by any known participant.
 *   - editMessage: original author only.
 *   - deleteMessage: author OR channel owner/admin.
 *   - duplicate channel name -> TableConflictError.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, canonical } from "../goal/ledger.js";
import { loadOrCreateKey } from "../permissions/goal-state-hmac.js";
import { newChannelId, newMessageId } from "./ids.js";
import {
	type Channel,
	type ChannelType,
	type Member,
	type MemberRole,
	type Message,
	type ParticipantId,
	type SearchHit,
	TableAuthError,
	TableConflictError,
	TableNotFoundError,
	TableValidationError,
	type ThreadView,
	type Visibility,
} from "./types.js";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

const WRITE_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>([
	"owner",
	"admin",
	"member",
	"bot",
]);
const ADMIN_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>(["owner", "admin"]);

export interface TableStoreOptions {
	/** default ~/.8gent/table/table.db */
	dbPath?: string;
	/** injected; default opens the shared Table ledger under ~/.8gent/table/ledger */
	ledger?: Ledger;
}

/** Default DB path honoring EIGHT_DATA_DIR. */
export function defaultTableDbPath(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "table", "table.db");
}

/**
 * Open the default persistent Table ledger. Reuses the same daemon-resident
 * state-hmac key path as the /goal ledger so verification is uniform.
 */
export function openDefaultTableLedger(): Ledger {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return Ledger.open({
		runId: "ledger",
		baseDir: path.join(base, "table"),
		key: loadOrCreateKey(),
	});
}

/** sha256 hex of content - what the ledger records instead of the mutable body. */
export function contentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Canonical signable payload for a message. The ed25519 per-message signature
 * (identity.signMessage) is computed over this exact string.
 */
export function canonicalMessage(input: {
	channelId: string;
	authorId: ParticipantId;
	content: string;
	replyTo?: string;
	createdAt: number;
}): string {
	return canonical({
		channelId: input.channelId,
		authorId: input.authorId,
		content: input.content,
		replyTo: input.replyTo ?? null,
		createdAt: input.createdAt,
	});
}

interface ChannelRow {
	id: string;
	name: string;
	type: string;
	visibility: string;
	topic: string | null;
	created_by: string;
	created_at: number;
	archived_at: number | null;
}

interface MemberRow {
	channel_id: string;
	participant_id: string;
	role: string;
	added_at: number;
}

interface MessageRow {
	id: string;
	channel_id: string;
	author_id: string;
	content: string;
	reply_to: string | null;
	sig: string | null;
	edited_at: number | null;
	deleted_at: number | null;
	created_at: number;
	audio_url: string | null;
	audio_duration_ms: number | null;
}

function rowToChannel(r: ChannelRow): Channel {
	return {
		id: r.id,
		name: r.name,
		type: r.type as ChannelType,
		visibility: r.visibility as Visibility,
		topic: r.topic ?? undefined,
		createdBy: r.created_by,
		createdAt: r.created_at,
		archivedAt: r.archived_at ?? undefined,
	};
}

function rowToMember(r: MemberRow): Member {
	return {
		channelId: r.channel_id,
		participantId: r.participant_id,
		role: r.role as MemberRole,
		addedAt: r.added_at,
	};
}

function rowToMessage(r: MessageRow): Message {
	return {
		id: r.id,
		channelId: r.channel_id,
		authorId: r.author_id,
		content: r.content,
		replyTo: r.reply_to ?? undefined,
		sig: r.sig ?? undefined,
		editedAt: r.edited_at ?? undefined,
		deletedAt: r.deleted_at ?? undefined,
		createdAt: r.created_at,
		audioUrl: r.audio_url ?? undefined,
		audioDurationMs: r.audio_duration_ms ?? undefined,
	};
}

export class TableStore {
	readonly db: Database;
	private readonly ledger: Ledger;
	private readonly ownsLedger: boolean;

	constructor(opts: TableStoreOptions = {}) {
		const dbPath = opts.dbPath ?? defaultTableDbPath();
		if (dbPath !== ":memory:") {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		}
		this.db = new Database(dbPath, { create: true });

		try {
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA synchronous = NORMAL");
			this.db.exec("PRAGMA foreign_keys = ON");
		} catch (err) {
			console.warn("[table] PRAGMA init warning:", (err as Error).message);
		}

		const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
		this.db.exec(schema);
		this.migrate();

		if (opts.ledger) {
			this.ledger = opts.ledger;
			this.ownsLedger = false;
		} else {
			this.ledger = openDefaultTableLedger();
			this.ownsLedger = true;
		}
	}

	/** Expose the ledger for verification / inspection (e.g. tests, `ledger.verify()`). */
	getLedger(): Ledger {
		return this.ledger;
	}

	/**
	 * Read a single message by id, or null when it does not exist. Public,
	 * unlike getMessageRow (the private row-level accessor) - this is the seam
	 * a caller outside the store uses (e.g. the on-demand narration HTTP route,
	 * message-speak.ts) to fetch a message's content without reaching into row
	 * internals. Does NOT check delete/authority - callers that care (like
	 * message-speak.ts) check deletedAt and read-authority themselves, same
	 * split editMessage/attachAudio already use.
	 */
	getMessage(messageId: string): Message | null {
		const row = this.getMessageRow(messageId);
		return row ? rowToMessage(row) : null;
	}

	/**
	 * Additive, idempotent migrations for columns added after a database was
	 * first created. CREATE TABLE IF NOT EXISTS (schema.sql) never alters an
	 * EXISTING table, so a ~/.8gent/table/table.db from before 2026-08-21 needs
	 * these ALTER TABLEs to pick up audio_url/audio_duration_ms. Both columns
	 * are nullable, so every pre-existing row reads back with audioUrl/
	 * audioDurationMs simply absent - no behavior change for a message that
	 * never had narration. Safe to run on every open: "duplicate column name"
	 * is swallowed (already migrated), any other error is real and rethrown.
	 *
	 * channels.archived_at (2026-08-27) follows the identical shape and is
	 * non-lossy by construction: ADD COLUMN on a nullable column with no
	 * DEFAULT rewrites no rows and backfills NULL, so every channel that
	 * existed before the migration reads back as active. No channel row and no
	 * message is touched.
	 */
	private migrate(): void {
		const alters = [
			"ALTER TABLE messages ADD COLUMN audio_url TEXT",
			"ALTER TABLE messages ADD COLUMN audio_duration_ms INTEGER",
			"ALTER TABLE channels ADD COLUMN archived_at INTEGER",
		];
		for (const sql of alters) {
			try {
				this.db.exec(sql);
			} catch (err) {
				if (!/duplicate column name/i.test((err as Error).message ?? "")) throw err;
			}
		}
	}

	// ── channels ────────────────────────────────────────────────────────

	createChannel(input: {
		name: string;
		type: ChannelType;
		visibility: Visibility;
		topic?: string;
		createdBy: ParticipantId;
	}): Channel {
		const name = input.name.trim();
		if (!name) throw new TableValidationError("channel name must be non-empty");
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
			throw new TableValidationError(
				`channel name "${name}" is not slug-safe (allowed: alphanumerics . _ -)`,
			);
		}

		const channel: Channel = {
			id: newChannelId(),
			name,
			type: input.type,
			visibility: input.visibility,
			topic: input.topic,
			createdBy: input.createdBy,
			createdAt: Date.now(),
		};

		// Insert the channel and seed the creator as owner in one transaction so
		// authority (only owner/admin may add members) has a root from the start.
		const insert = this.db.transaction(() => {
			this.db
				.prepare(
					"INSERT INTO channels (id, name, type, visibility, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					channel.id,
					channel.name,
					channel.type,
					channel.visibility,
					channel.topic ?? null,
					channel.createdBy,
					channel.createdAt,
				);
			this.db
				.prepare(
					"INSERT INTO members (channel_id, participant_id, role, added_at) VALUES (?, ?, ?, ?)",
				)
				.run(channel.id, channel.createdBy, "owner", channel.createdAt);
		});

		try {
			insert();
		} catch (err) {
			const msg = (err as Error).message ?? String(err);
			if (/UNIQUE/i.test(msg) && /name/i.test(msg)) {
				throw new TableConflictError(`channel name "${name}" already exists`);
			}
			throw err;
		}

		this.ledger.append({
			kind: "table.channel.create",
			payload: {
				channelId: channel.id,
				name: channel.name,
				type: channel.type,
				visibility: channel.visibility,
				createdBy: channel.createdBy,
				createdAt: channel.createdAt,
			},
		});

		return channel;
	}

	/**
	 * Active channels, oldest first. Archived channels are omitted by default -
	 * the default listing is the WORKING SET, which is the entire point of
	 * archiving. Pass includeArchived to get everything; the archive is always
	 * one flag away, never gone.
	 */
	listChannels(opts: { visibleTo?: ParticipantId; includeArchived?: boolean } = {}): Channel[] {
		const rows = this.db
			.prepare(
				opts.includeArchived
					? "SELECT * FROM channels ORDER BY created_at ASC"
					: "SELECT * FROM channels WHERE archived_at IS NULL ORDER BY created_at ASC",
			)
			.all() as ChannelRow[];
		const channels = rows.map(rowToChannel);
		if (!opts.visibleTo) return channels;
		const viewer = opts.visibleTo;
		return channels.filter((c) => c.visibility === "open" || this.isMember(c.id, viewer));
	}

	/**
	 * Flag a channel archived. NON-DESTRUCTIVE and REVERSIBLE: this writes one
	 * nullable timestamp and touches nothing else. The channel row survives,
	 * every message survives, and reads (thread / subscribe / search) keep
	 * working exactly as before - hiding the channel from a default
	 * listChannels() is the only behavior that changes. Idempotent: archiving
	 * an already-archived channel returns it unchanged rather than moving the
	 * timestamp, so a retry cannot rewrite when it was archived.
	 *
	 * Authority: owner/admin of the channel, matching removeMember. Archiving
	 * is a state change on the shared record, so it takes more than mere
	 * membership.
	 */
	archiveChannel(channelId: string, archivedBy: ParticipantId): Channel {
		const channel = this.requireChannel(channelId);
		if (!this.hasRole(channelId, archivedBy, ADMIN_ROLES)) {
			throw new TableAuthError(
				`${archivedBy} is not owner/admin of ${channelId} and cannot archive it`,
			);
		}
		if (channel.archivedAt !== undefined) return channel;

		const archivedAt = Date.now();
		this.db.prepare("UPDATE channels SET archived_at = ? WHERE id = ?").run(archivedAt, channelId);

		this.ledger.append({
			kind: "table.channel.archive",
			payload: { channelId, name: channel.name, archivedBy, archivedAt },
		});

		return { ...channel, archivedAt };
	}

	/**
	 * Clear the archive flag, returning the channel to the default listing. The
	 * counterpart that keeps archive from being a delete in disguise. Idempotent
	 * on an already-active channel.
	 */
	unarchiveChannel(channelId: string, unarchivedBy: ParticipantId): Channel {
		const channel = this.requireChannel(channelId);
		if (!this.hasRole(channelId, unarchivedBy, ADMIN_ROLES)) {
			throw new TableAuthError(
				`${unarchivedBy} is not owner/admin of ${channelId} and cannot unarchive it`,
			);
		}
		if (channel.archivedAt === undefined) return channel;

		this.db.prepare("UPDATE channels SET archived_at = NULL WHERE id = ?").run(channelId);

		this.ledger.append({
			kind: "table.channel.unarchive",
			payload: {
				channelId,
				name: channel.name,
				unarchivedBy,
				wasArchivedAt: channel.archivedAt,
				ts: Date.now(),
			},
		});

		return { ...channel, archivedAt: undefined };
	}

	getChannel(channelId: string): Channel | null {
		const row = this.db
			.prepare("SELECT * FROM channels WHERE id = ?")
			.get(channelId) as ChannelRow | null;
		return row ? rowToChannel(row) : null;
	}

	private requireChannel(channelId: string): Channel {
		const c = this.getChannel(channelId);
		if (!c) throw new TableNotFoundError(`channel ${channelId} not found`);
		return c;
	}

	// ── members ─────────────────────────────────────────────────────────

	addMember(input: {
		channelId: string;
		participantId: ParticipantId;
		role: MemberRole;
		addedBy: ParticipantId;
	}): Member {
		this.requireChannel(input.channelId);
		if (!WRITE_ROLES.has(input.role)) {
			throw new TableValidationError(`unknown member role "${input.role}"`);
		}
		if (!this.hasRole(input.channelId, input.addedBy, ADMIN_ROLES)) {
			throw new TableAuthError(
				`${input.addedBy} is not owner/admin of ${input.channelId} and cannot add members`,
			);
		}

		const member: Member = {
			channelId: input.channelId,
			participantId: input.participantId,
			role: input.role,
			addedAt: Date.now(),
		};

		try {
			this.db
				.prepare(
					"INSERT INTO members (channel_id, participant_id, role, added_at) VALUES (?, ?, ?, ?)",
				)
				.run(member.channelId, member.participantId, member.role, member.addedAt);
		} catch (err) {
			if (/UNIQUE|PRIMARY KEY/i.test((err as Error).message ?? "")) {
				throw new TableConflictError(
					`${input.participantId} is already a member of ${input.channelId}`,
				);
			}
			throw err;
		}

		this.ledger.append({
			kind: "table.member.add",
			payload: {
				channelId: member.channelId,
				participantId: member.participantId,
				role: member.role,
				addedBy: input.addedBy,
				addedAt: member.addedAt,
			},
		});

		return member;
	}

	removeMember(channelId: string, participantId: ParticipantId, removedBy: ParticipantId): void {
		this.requireChannel(channelId);
		if (!this.hasRole(channelId, removedBy, ADMIN_ROLES)) {
			throw new TableAuthError(
				`${removedBy} is not owner/admin of ${channelId} and cannot remove members`,
			);
		}
		if (!this.isMember(channelId, participantId)) {
			throw new TableNotFoundError(`${participantId} is not a member of ${channelId}`);
		}

		this.db
			.prepare("DELETE FROM members WHERE channel_id = ? AND participant_id = ?")
			.run(channelId, participantId);

		this.ledger.append({
			kind: "table.member.remove",
			payload: { channelId, participantId, removedBy, ts: Date.now() },
		});
	}

	listMembers(channelId: string): Member[] {
		const rows = this.db
			.prepare("SELECT * FROM members WHERE channel_id = ? ORDER BY added_at ASC")
			.all(channelId) as MemberRow[];
		return rows.map(rowToMember);
	}

	isMember(channelId: string, participantId: ParticipantId): boolean {
		const row = this.db
			.prepare("SELECT 1 AS ok FROM members WHERE channel_id = ? AND participant_id = ?")
			.get(channelId, participantId) as { ok: number } | null;
		return !!row;
	}

	private roleOf(channelId: string, participantId: ParticipantId): MemberRole | null {
		const row = this.db
			.prepare("SELECT role FROM members WHERE channel_id = ? AND participant_id = ?")
			.get(channelId, participantId) as { role: string } | null;
		return row ? (row.role as MemberRole) : null;
	}

	private hasRole(
		channelId: string,
		participantId: ParticipantId,
		roles: ReadonlySet<MemberRole>,
	): boolean {
		const role = this.roleOf(channelId, participantId);
		return role !== null && roles.has(role);
	}

	/** Read authority: private channels require membership when a viewer is supplied. */
	private assertCanRead(channel: Channel, viewer?: ParticipantId): void {
		if (channel.visibility === "open") return;
		if (!viewer) return; // trusted / unauthenticated read path (gateway enforces upstream)
		if (!this.isMember(channel.id, viewer)) {
			throw new TableAuthError(`${viewer} is not a member of private channel ${channel.id}`);
		}
	}

	// ── messages (soft-delete throughout) ───────────────────────────────

	postMessage(input: {
		channelId: string;
		authorId: ParticipantId;
		content: string;
		replyTo?: string;
		/** optional precomputed ed25519 signature (base64) over canonicalMessage(). */
		sig?: string;
		/** Narration already synthesised at post time; nullable/additive - most
		 *  posts carry neither field. See attachAudio() for adding it later. */
		audioUrl?: string;
		audioDurationMs?: number;
	}): Message {
		this.requireChannel(input.channelId);
		if (input.content.length === 0) {
			throw new TableValidationError("message content must be non-empty");
		}
		// Writable only by members, regardless of open/private visibility.
		if (!this.isMember(input.channelId, input.authorId)) {
			throw new TableAuthError(
				`${input.authorId} is not a member of ${input.channelId} and cannot post`,
			);
		}
		if (input.replyTo !== undefined) {
			const parent = this.getMessageRow(input.replyTo);
			if (!parent) {
				throw new TableValidationError(`replyTo target ${input.replyTo} not found`);
			}
			if (parent.channel_id !== input.channelId) {
				throw new TableValidationError(
					`replyTo target ${input.replyTo} belongs to a different channel`,
				);
			}
		}

		const message: Message = {
			id: newMessageId(),
			channelId: input.channelId,
			authorId: input.authorId,
			content: input.content,
			replyTo: input.replyTo,
			sig: input.sig,
			createdAt: Date.now(),
			audioUrl: input.audioUrl,
			audioDurationMs: input.audioDurationMs,
		};

		this.db
			.prepare(
				"INSERT INTO messages (id, channel_id, author_id, content, reply_to, sig, edited_at, deleted_at, created_at, audio_url, audio_duration_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
			)
			.run(
				message.id,
				message.channelId,
				message.authorId,
				message.content,
				message.replyTo ?? null,
				message.sig ?? null,
				message.createdAt,
				message.audioUrl ?? null,
				message.audioDurationMs ?? null,
			);

		this.ledger.append({
			kind: "table.message.post",
			payload: {
				messageId: message.id,
				channelId: message.channelId,
				authorId: message.authorId,
				replyTo: message.replyTo ?? null,
				contentHash: contentHash(message.content),
				createdAt: message.createdAt,
			},
		});

		return message;
	}

	editMessage(input: {
		messageId: string;
		editorId: ParticipantId;
		content: string;
	}): Message {
		const row = this.getMessageRow(input.messageId);
		if (!row || row.deleted_at !== null) {
			throw new TableNotFoundError(`message ${input.messageId} not found`);
		}
		if (row.author_id !== input.editorId) {
			throw new TableAuthError(
				`${input.editorId} is not the author of ${input.messageId} and cannot edit it`,
			);
		}
		if (input.content.length === 0) {
			throw new TableValidationError("message content must be non-empty");
		}

		const editedAt = Date.now();
		this.db
			.prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?")
			.run(input.content, editedAt, input.messageId);

		this.ledger.append({
			kind: "table.message.edit",
			payload: {
				messageId: input.messageId,
				editorId: input.editorId,
				contentHash: contentHash(input.content),
				editedAt,
			},
		});

		return rowToMessage(this.getMessageRow(input.messageId) as MessageRow);
	}

	/**
	 * Attach (or replace) narration on an already-posted message. Same author-
	 * only authority as editMessage - narration is content, just spoken rather
	 * than written, so the same person who could edit the text is the one who
	 * can attach what speaks it. Shape validation of audioUrl (the daemon-local
	 * /table/audio/<messageId>/<file> form) is the caller's job (table-routes.ts),
	 * same split as editMessage's content non-empty check living one layer up
	 * from here for messageId/actor resolution.
	 */
	attachAudio(input: {
		messageId: string;
		actorId: ParticipantId;
		audioUrl: string;
		audioDurationMs: number;
	}): Message {
		const row = this.getMessageRow(input.messageId);
		if (!row || row.deleted_at !== null) {
			throw new TableNotFoundError(`message ${input.messageId} not found`);
		}
		if (row.author_id !== input.actorId) {
			throw new TableAuthError(
				`${input.actorId} is not the author of ${input.messageId} and cannot attach audio to it`,
			);
		}
		if (input.audioUrl.length === 0) {
			throw new TableValidationError("audioUrl must be non-empty");
		}

		this.db
			.prepare("UPDATE messages SET audio_url = ?, audio_duration_ms = ? WHERE id = ?")
			.run(input.audioUrl, input.audioDurationMs, input.messageId);

		this.ledger.append({
			kind: "table.message.attachAudio",
			payload: {
				messageId: input.messageId,
				actorId: input.actorId,
				audioUrl: input.audioUrl,
				audioDurationMs: input.audioDurationMs,
				at: Date.now(),
			},
		});

		return rowToMessage(this.getMessageRow(input.messageId) as MessageRow);
	}

	deleteMessage(input: { messageId: string; deleterId: ParticipantId }): Message {
		const row = this.getMessageRow(input.messageId);
		if (!row || row.deleted_at !== null) {
			throw new TableNotFoundError(`message ${input.messageId} not found`);
		}
		const isAuthor = row.author_id === input.deleterId;
		const isAdmin = this.hasRole(row.channel_id, input.deleterId, ADMIN_ROLES);
		if (!isAuthor && !isAdmin) {
			throw new TableAuthError(
				`${input.deleterId} may not delete ${input.messageId} (not author, not owner/admin)`,
			);
		}

		const deletedAt = Date.now();
		// Blank the content tombstone-style; the FTS update trigger drops the term.
		this.db
			.prepare("UPDATE messages SET content = '', deleted_at = ? WHERE id = ?")
			.run(deletedAt, input.messageId);

		this.ledger.append({
			kind: "table.message.delete",
			payload: { messageId: input.messageId, deleterId: input.deleterId, deletedAt },
		});

		return rowToMessage(this.getMessageRow(input.messageId) as MessageRow);
	}

	getThread(
		messageId: string,
		opts: { includeDeleted?: boolean; viewerId?: ParticipantId } = {},
	): ThreadView | null {
		const rootRow = this.getMessageRow(messageId);
		if (!rootRow) return null;
		const channel = this.requireChannel(rootRow.channel_id);
		this.assertCanRead(channel, opts.viewerId);

		const includeDeleted = opts.includeDeleted ?? false;
		const where = includeDeleted ? "" : " AND deleted_at IS NULL";
		const replyRows = this.db
			.prepare(`SELECT * FROM messages WHERE reply_to = ?${where} ORDER BY created_at ASC`)
			.all(messageId) as MessageRow[];

		return {
			root: rowToMessage(rootRow),
			replies: replyRows.map(rowToMessage),
		};
	}

	listMessages(
		channelId: string,
		opts: {
			limit?: number;
			before?: number;
			includeDeleted?: boolean;
			viewerId?: ParticipantId;
		} = {},
	): Message[] {
		const channel = this.requireChannel(channelId);
		this.assertCanRead(channel, opts.viewerId);

		const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
		const includeDeleted = opts.includeDeleted ?? false;

		const clauses = ["channel_id = ?"];
		const params: (string | number)[] = [channelId];
		if (opts.before !== undefined) {
			clauses.push("created_at < ?");
			params.push(opts.before);
		}
		if (!includeDeleted) {
			clauses.push("deleted_at IS NULL");
		}
		params.push(limit);

		// Keyset pagination: newest-first fetch, then reverse to ascending.
		const rows = this.db
			.prepare(
				`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
			)
			.all(...params) as MessageRow[];

		return rows.reverse().map(rowToMessage);
	}

	search(query: string, opts: { channelId?: string; limit?: number } = {}): SearchHit[] {
		const match = buildFtsMatch(query);
		if (!match) return [];
		const limit = Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT);

		const clauses = ["messages_fts MATCH ?", "m.deleted_at IS NULL"];
		const params: (string | number)[] = [match];
		if (opts.channelId) {
			clauses.push("m.channel_id = ?");
			params.push(opts.channelId);
		}
		params.push(limit);

		let rows: Array<MessageRow & { snippet: string; rank: number }>;
		try {
			rows = this.db
				.prepare(
					`SELECT m.*,
					        snippet(messages_fts, 0, '<mark>', '</mark>', '...', 12) AS snippet,
					        bm25(messages_fts) AS rank
					 FROM messages_fts
					 JOIN messages m ON m.rowid = messages_fts.rowid
					 WHERE ${clauses.join(" AND ")}
					 ORDER BY rank ASC
					 LIMIT ?`,
				)
				.all(...params) as typeof rows;
		} catch {
			// Malformed FTS expression - return no hits rather than throwing.
			return [];
		}

		return rows.map((r) => ({
			message: rowToMessage(r),
			channelId: r.channel_id,
			snippet: r.snippet,
			rank: r.rank,
		}));
	}

	close(): void {
		this.db.close();
		if (this.ownsLedger) this.ledger.close();
	}

	// ── private ─────────────────────────────────────────────────────────

	private getMessageRow(messageId: string): MessageRow | null {
		return this.db
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(messageId) as MessageRow | null;
	}
}

/**
 * Build a safe FTS5 MATCH expression from free user text. Each alphanumeric
 * term is double-quoted (so FTS operators in the input can't inject) and
 * joined with implicit AND. Returns "" when nothing usable remains.
 */
function buildFtsMatch(query: string): string {
	const terms = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0)
		.map((t) => `"${t}"`);
	return terms.join(" ");
}
