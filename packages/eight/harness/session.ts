/**
 * Append-Only JSONL Session with SHA-256 Checksum Chain
 *
 * Each entry is a single JSON line in the session file.
 * Every entry contains a `prevHash` (hash of the previous entry) and
 * its own `hash` (SHA-256 of id + timestamp + type + payload + prevHash).
 * This creates a tamper-evident chain: any modification breaks verification.
 *
 * File-based, no database. External to the harness process (survives crash).
 * The harness can restart and replay from this file to recover state.
 *
 * Issue: #1402
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditEntry, AuditEntryType, Session } from "./types";

const SESSIONS_DIR = path.join(process.env.HOME || "~", ".8gent", "audit");

/** Compute the SHA-256 hash of an audit entry's content fields. */
export function computeHash(
	id: string,
	timestamp: string,
	type: string,
	payload: Record<string, unknown>,
	prevHash: string,
): string {
	const data = JSON.stringify({ id, timestamp, type, payload, prevHash });
	return crypto.createHash("sha256").update(data).digest("hex");
}

/** Parse a single JSONL line into an AuditEntry. Throws on malformed input. */
function parseLine(line: string): AuditEntry {
	const entry = JSON.parse(line) as AuditEntry;
	if (!entry.id || !entry.timestamp || !entry.type || !entry.hash) {
		throw new Error("Malformed audit entry: missing required fields");
	}
	return entry;
}

/** Create a new append-only JSONL session. */
export function createSession(sessionId?: string): Session {
	const id = sessionId || crypto.randomUUID().slice(0, 12);
	const filePath = path.join(SESSIONS_DIR, `${id}.jsonl`);
	// SEC-H1: Restrict permissions — audit logs may contain sensitive tool results
	fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });

	// Track last hash in memory for fast appends (rebuilt from file on first use)
	let cachedLastHash: string | null = null;

	async function getLastHash(): Promise<string> {
		if (cachedLastHash !== null) return cachedLastHash;
		const entries = await readAllEntries();
		cachedLastHash = entries.length > 0 ? entries[entries.length - 1].hash : "";
		return cachedLastHash;
	}

	async function readAllEntries(): Promise<AuditEntry[]> {
		if (!fs.existsSync(filePath)) return [];
		const content = fs.readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		return content.split("\n").map(parseLine);
	}

	const session: Session = {
		id,
		filePath,

		async append(
			type: AuditEntryType,
			payload: Record<string, unknown>,
		): Promise<string> {
			const entryId = crypto.randomUUID().slice(0, 8);
			const timestamp = new Date().toISOString();
			const prevHash = await getLastHash();
			const hash = computeHash(entryId, timestamp, type, payload, prevHash);

			const entry: AuditEntry = {
				id: entryId,
				timestamp,
				type,
				payload,
				prevHash,
				hash,
			};
			const line = `${JSON.stringify(entry)}\n`;

			// Append-only write. O_APPEND ensures atomicity on POSIX.
			// SEC-H1: Owner-only permissions on session files (0o600)
			fs.appendFileSync(filePath, line, { encoding: "utf-8", mode: 0o600 });
			cachedLastHash = hash;

			return hash;
		},

		async readAll(): Promise<AuditEntry[]> {
			return readAllEntries();
		},

		async lastHash(): Promise<string> {
			return getLastHash();
		},

		async verify(): Promise<number> {
			const entries = await readAllEntries();
			let expectedPrev = "";

			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];

				// Check prev hash chain
				if (entry.prevHash !== expectedPrev) return i;

				// Recompute and verify hash
				const recomputed = computeHash(
					entry.id,
					entry.timestamp,
					entry.type,
					entry.payload,
					entry.prevHash,
				);
				if (entry.hash !== recomputed) return i;

				expectedPrev = entry.hash;
			}

			return -1; // All valid
		},
	};

	return session;
}

/** Open an existing session file for reading (and optional appending). */
export function openSession(sessionId: string): Session {
	const filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
	if (!fs.existsSync(filePath)) {
		throw new Error(`Session not found: ${sessionId}`);
	}
	// createSession handles both new and existing files
	return createSession(sessionId);
}

/** List all session IDs in the audit directory. */
export function listSessions(): string[] {
	if (!fs.existsSync(SESSIONS_DIR)) return [];
	return fs
		.readdirSync(SESSIONS_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => f.replace(".jsonl", ""))
		.sort();
}

/** Get the default sessions directory path. */
export function getSessionsDir(): string {
	return SESSIONS_DIR;
}
