/**
 * Channel archive: the Chair ruled archive-not-delete (issue #2889), so these
 * tests exist to prove the three properties that ruling depends on.
 *
 *   1. NON-DESTRUCTIVE - no channel row and no message is lost by archiving.
 *   2. REVERSIBLE      - unarchive restores the channel to the default listing.
 *   3. STILL READABLE  - an archived channel's messages read back in full.
 *
 * Plus the migration proof: a database created BEFORE archived_at existed opens
 * cleanly, keeps every row, and reads every channel back as active. That one is
 * asserted against a real pre-migration schema rather than taken on trust,
 * because it is the case that runs against James's live 48-channel table.db.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDatabase as Database } from "../../core/sqlite";
import { Ledger } from "../../goal/ledger.js";
import { TableStore } from "../store.js";
import { TableAuthError, TableNotFoundError } from "../types.js";

const TEST_KEY = Buffer.from("a".repeat(64), "hex");

let tmpDir: string;
let store: TableStore;
let ledger: Ledger;

const JAMES = "human:james";
const NESSA = "human:nessa";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "table-archive-"));
	ledger = Ledger.open({ runId: "ledger", baseDir: tmpDir, key: TEST_KEY });
	store = new TableStore({ dbPath: path.join(tmpDir, "table.db"), ledger });
});

afterEach(() => {
	store.close();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function makeChannel(name = "ws-8gi--probe") {
	return store.createChannel({
		name,
		type: "stream",
		visibility: "open",
		topic: "probe",
		createdBy: JAMES,
	});
}

describe("channel archive", () => {
	it("creates channels active by default", () => {
		expect(makeChannel().archivedAt).toBeUndefined();
	});

	it("hides an archived channel from the default listing and returns it with includeArchived", () => {
		const keep = makeChannel("ws-8gi--keep");
		const drop = makeChannel("ws-8gi--drop");

		store.archiveChannel(drop.id, JAMES);

		const active = store.listChannels().map((c) => c.name);
		expect(active).toContain("ws-8gi--keep");
		expect(active).not.toContain("ws-8gi--drop");

		const all = store.listChannels({ includeArchived: true }).map((c) => c.name);
		expect(all).toContain("ws-8gi--keep");
		expect(all).toContain("ws-8gi--drop");
		expect(keep.id).not.toBe(drop.id);
	});

	// The property the whole ruling turns on. If this ever fails, archive has
	// become a delete and must not ship.
	it("destroys nothing: the channel row and every message survive archiving", () => {
		const c = makeChannel();
		const a = store.postMessage({ channelId: c.id, authorId: JAMES, content: "first" });
		const b = store.postMessage({ channelId: c.id, authorId: JAMES, content: "second" });

		const rowsBefore = store.db.query("SELECT count(*) AS n FROM channels").get() as { n: number };
		const msgsBefore = store.db.query("SELECT count(*) AS n FROM messages").get() as { n: number };

		store.archiveChannel(c.id, JAMES);

		const rowsAfter = store.db.query("SELECT count(*) AS n FROM channels").get() as { n: number };
		const msgsAfter = store.db.query("SELECT count(*) AS n FROM messages").get() as { n: number };
		expect(rowsAfter.n).toBe(rowsBefore.n);
		expect(msgsAfter.n).toBe(msgsBefore.n);

		expect(store.getChannel(c.id)).not.toBeNull();
		expect(store.getMessage(a.id)?.content).toBe("first");
		expect(store.getMessage(b.id)?.content).toBe("second");
	});

	it("keeps an archived channel readable: thread and search still work", () => {
		const c = makeChannel();
		const root = store.postMessage({
			channelId: c.id,
			authorId: JAMES,
			content: "the record must stay readable",
		});

		store.archiveChannel(c.id, JAMES);

		const thread = store.getThread(root.id, { viewerId: JAMES });
		expect(thread?.root.content).toBe("the record must stay readable");

		const listed = store.listMessages(c.id, { viewerId: JAMES });
		expect(listed.map((m) => m.id)).toContain(root.id);

		const hits = store.search("readable", { channelId: c.id });
		expect(hits.map((h) => h.message.id)).toContain(root.id);
	});

	it("is reversible: unarchive returns the channel to the default listing", () => {
		const c = makeChannel();
		store.archiveChannel(c.id, JAMES);
		expect(store.listChannels().map((x) => x.id)).not.toContain(c.id);

		const back = store.unarchiveChannel(c.id, JAMES);
		expect(back.archivedAt).toBeUndefined();
		expect(store.listChannels().map((x) => x.id)).toContain(c.id);
		expect(store.getChannel(c.id)?.archivedAt).toBeUndefined();
	});

	it("is idempotent in both directions and does not move the archive timestamp on retry", () => {
		const c = makeChannel();
		const first = store.archiveChannel(c.id, JAMES);
		const second = store.archiveChannel(c.id, JAMES);
		expect(second.archivedAt).toBe(first.archivedAt);

		store.unarchiveChannel(c.id, JAMES);
		const again = store.unarchiveChannel(c.id, JAMES);
		expect(again.archivedAt).toBeUndefined();
	});

	it("requires owner/admin, matching removeMember", () => {
		const c = makeChannel();
		store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES });
		expect(() => store.archiveChannel(c.id, NESSA)).toThrow(TableAuthError);

		store.archiveChannel(c.id, JAMES);
		expect(() => store.unarchiveChannel(c.id, NESSA)).toThrow(TableAuthError);
	});

	it("rejects an unknown channel id", () => {
		expect(() => store.archiveChannel("chan_deadbeef", JAMES)).toThrow(TableNotFoundError);
	});

	it("appends archive/unarchive to the ledger and the chain still verifies", () => {
		const c = makeChannel();
		store.archiveChannel(c.id, JAMES);
		store.unarchiveChannel(c.id, JAMES);

		const kinds = ledger.readAll().map((e) => e.kind);
		expect(kinds).toContain("table.channel.archive");
		expect(kinds).toContain("table.channel.unarchive");
		expect(ledger.verify().ok).toBe(true);
	});
});

describe("archived_at migration", () => {
	/**
	 * Build a database with the EXACT pre-archive channels schema, seed it, then
	 * open it with the current TableStore. This is the shape of James's live
	 * ~/.8gent/table/table.db, so the migration is proved rather than asserted.
	 */
	it("opens a pre-archive database without losing a channel or a message", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "table-migrate-"));
		const dbPath = path.join(dir, "legacy.db");

		const legacy = new Database(dbPath, { create: true });
		legacy.exec(`
			CREATE TABLE channels (
				id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
				visibility TEXT NOT NULL, topic TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE members (
				channel_id TEXT NOT NULL, participant_id TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL,
				PRIMARY KEY (channel_id, participant_id)
			);
			CREATE TABLE messages (
				id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL,
				content TEXT NOT NULL, reply_to TEXT, sig TEXT, edited_at INTEGER, deleted_at INTEGER,
				created_at INTEGER NOT NULL
			);
		`);
		legacy
			.prepare(
				"INSERT INTO channels (id, name, type, visibility, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("chan_legacy0000000000000001", "ws-8gi--legacy", "stream", "open", null, JAMES, 1);
		legacy
			.prepare(
				"INSERT INTO members (channel_id, participant_id, role, added_at) VALUES (?, ?, ?, ?)",
			)
			.run("chan_legacy0000000000000001", JAMES, "owner", 1);
		legacy
			.prepare(
				"INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run("msg_legacy00000000000000001", "chan_legacy0000000000000001", JAMES, "pre-migration", 2);
		legacy.close();

		const migLedger = Ledger.open({ runId: "ledger", baseDir: dir, key: TEST_KEY });
		const migrated = new TableStore({ dbPath, ledger: migLedger });
		try {
			// Nothing lost.
			const channels = migrated.listChannels();
			expect(channels.length).toBe(1);
			expect(channels[0]?.name).toBe("ws-8gi--legacy");

			// Every pre-existing channel defaults to ACTIVE, not archived.
			expect(channels[0]?.archivedAt).toBeUndefined();

			// The message survived the migration intact.
			expect(migrated.getMessage("msg_legacy00000000000000001")?.content).toBe("pre-migration");

			// And the new column is genuinely there and usable.
			const archived = migrated.archiveChannel("chan_legacy0000000000000001", JAMES);
			expect(typeof archived.archivedAt).toBe("number");
			expect(migrated.listChannels().length).toBe(0);
			expect(migrated.listChannels({ includeArchived: true }).length).toBe(1);
		} finally {
			migrated.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is safe to run twice: reopening an already-migrated database is a no-op", () => {
		const c = makeChannel();
		store.archiveChannel(c.id, JAMES);
		const dbPath = store.db.filename;
		store.close();

		const reopened = new TableStore({ dbPath, ledger });
		try {
			expect(reopened.listChannels({ includeArchived: true }).length).toBe(1);
			expect(reopened.getChannel(c.id)?.archivedAt).toBeDefined();
		} finally {
			reopened.close();
			// beforeEach's store is already closed; give afterEach something valid.
			store = new TableStore({ dbPath, ledger });
		}
	});
});
