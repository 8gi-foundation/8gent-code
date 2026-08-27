/**
 * 8gent Table - domain types + typed error classes.
 *
 * Phase 1 interface contract, section 1.1 + error taxonomy (section 1.2 / 3.9).
 *
 * A Table is a set of named channels whose members are humans and agents.
 * Every identity carries a namespace prefix:
 *   human members -> "human:<handle>"    (custodied key on disk)
 *   agent members -> "agent:<agentId>"   (daemon-minted key)
 * authorId / participantId always carry the prefix.
 */

export type ChannelType = "stream" | "forum";
export type Visibility = "open" | "private";
export type MemberRole = "owner" | "admin" | "member" | "bot";

/** Prefixed participant id: "human:james" | "agent:8EO". */
export type ParticipantId = string;

export interface Channel {
	/** "chan_" + 24 hex. */
	id: string;
	/** Unique, slug-safe display name. */
	name: string;
	type: ChannelType;
	visibility: Visibility;
	topic?: string;
	createdBy: ParticipantId;
	/** epoch ms */
	createdAt: number;
	/**
	 * Archive tombstone, epoch ms; undefined = active. Archiving is a flag, not
	 * a delete: the channel row and every message it holds survive untouched,
	 * and an archived channel still reads back in full. It is hidden from a
	 * default listChannels() and returned again with includeArchived. Reversible
	 * via unarchiveChannel.
	 */
	archivedAt?: number;
}

export interface Member {
	channelId: string;
	participantId: ParticipantId;
	role: MemberRole;
	/** epoch ms */
	addedAt: number;
}

export interface Message {
	/** "msg_" + 24 hex. */
	id: string;
	channelId: string;
	authorId: ParticipantId;
	content: string;
	/** message id (thread parent); undefined = root. */
	replyTo?: string;
	/** ed25519 signature over the canonical message payload (base64), if signed. */
	sig?: string;
	/** set by editMessage */
	editedAt?: number;
	/** soft-delete tombstone; content blanked to "" on delete. */
	deletedAt?: number;
	/** epoch ms */
	createdAt: number;
	/**
	 * Daemon-local narration path, e.g. "/table/audio/<messageId>/<file>",
	 * served loopback-only by handleTableAudioHttp and proxied for the phone at
	 * the relay's identical public path (no rewrite needed - the two paths are
	 * the same string by design, mirroring the huddle audio pattern). Nullable
	 * and additive: a message with no narration simply omits this field.
	 */
	audioUrl?: string;
	/** Real duration of the narration wav, ms. Present only alongside audioUrl. */
	audioDurationMs?: number;
}

export interface ThreadView {
	root: Message;
	/** ordered by createdAt asc; excludes deleted unless includeDeleted. */
	replies: Message[];
}

export interface SearchHit {
	message: Message;
	channelId: string;
	/** FTS5 snippet() with <mark> highlights. */
	snippet: string;
	/** bm25 rank, lower = better. */
	rank: number;
}

// ── Error taxonomy ────────────────────────────────────────────────────
//
// Each subclass carries a stable `.code` string used verbatim in the WS
// error frame (section 3.9). Never leak secrets in `.message`.

export type TableErrorCode =
	| "TABLE_AUTH"
	| "TABLE_VALIDATION"
	| "TABLE_CONFLICT"
	| "TABLE_NOT_FOUND"
	| "TABLE_INTERNAL";

export class TableError extends Error {
	readonly code: TableErrorCode;
	constructor(code: TableErrorCode, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		// Restore prototype chain for instanceof across transpile targets.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Caller lacks authority for the requested mutation/read (membership/role). */
export class TableAuthError extends TableError {
	constructor(message: string) {
		super("TABLE_AUTH", message);
	}
}

/** Malformed input (bad replyTo target, empty content, unknown role, ...). */
export class TableValidationError extends TableError {
	constructor(message: string) {
		super("TABLE_VALIDATION", message);
	}
}

/** Uniqueness violation (duplicate channel name, duplicate membership). */
export class TableConflictError extends TableError {
	constructor(message: string) {
		super("TABLE_CONFLICT", message);
	}
}

/** Referenced channel / message / member does not exist. */
export class TableNotFoundError extends TableError {
	constructor(message: string) {
		super("TABLE_NOT_FOUND", message);
	}
}
