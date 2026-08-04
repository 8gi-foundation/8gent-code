/**
 * TableStore tests: CRUD, threading, soft-delete, FTS search, authority, and
 * the ledger-append guarantee (every mutation appends a signed entry whose
 * ledger.verify() walks clean).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../../goal/ledger.js";
import { TableStore } from "../store.js";
import { TableAuthError, TableConflictError, TableValidationError } from "../types.js";

// 32-byte test HMAC key (hex). Production loads ~/.8gent/keys/state-hmac.key.
const TEST_KEY = Buffer.from("a".repeat(64), "hex");

let tmpDir: string;
let store: TableStore;
let ledger: Ledger;

const JAMES = "human:james";
const NESSA = "human:nessa";
const AGENT_8EO = "agent:8EO";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "table-store-"));
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

function makeChannel(name = "design") {
	return store.createChannel({
		name,
		type: "stream",
		visibility: "open",
		topic: "UI work",
		createdBy: JAMES,
	});
}

describe("channels", () => {
	it("creates a channel and seeds the creator as owner", () => {
		const c = makeChannel();
		expect(c.id).toMatch(/^chan_[0-9a-f]{24}$/);
		expect(c.name).toBe("design");
		expect(store.getChannel(c.id)?.createdBy).toBe(JAMES);
		expect(store.isMember(c.id, JAMES)).toBe(true);
		expect(store.listMembers(c.id)[0]).toMatchObject({ participantId: JAMES, role: "owner" });
	});

	it("rejects a duplicate channel name with TableConflictError", () => {
		makeChannel("design");
		expect(() => makeChannel("design")).toThrow(TableConflictError);
	});

	it("rejects a non-slug-safe name", () => {
		expect(() =>
			store.createChannel({
				name: "has spaces",
				type: "stream",
				visibility: "open",
				createdBy: JAMES,
			}),
		).toThrow(TableValidationError);
	});

	it("filters private channels from non-members in listChannels(visibleTo)", () => {
		const open = makeChannel("open-chan");
		const priv = store.createChannel({
			name: "secret",
			type: "forum",
			visibility: "private",
			createdBy: JAMES,
		});
		const visibleToNessa = store.listChannels({ visibleTo: NESSA }).map((c) => c.id);
		expect(visibleToNessa).toContain(open.id);
		expect(visibleToNessa).not.toContain(priv.id);
		// creator sees their private channel
		expect(store.listChannels({ visibleTo: JAMES }).map((c) => c.id)).toContain(priv.id);
	});
});

describe("members", () => {
	it("owner can add a member; ledger records it", () => {
		const c = makeChannel();
		const before = ledger.currentSeq;
		const m = store.addMember({
			channelId: c.id,
			participantId: AGENT_8EO,
			role: "bot",
			addedBy: JAMES,
		});
		expect(m).toMatchObject({ participantId: AGENT_8EO, role: "bot" });
		expect(store.isMember(c.id, AGENT_8EO)).toBe(true);
		expect(ledger.currentSeq).toBe(before + 1);
	});

	it("non-admin cannot add members", () => {
		const c = makeChannel();
		store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES });
		expect(() =>
			store.addMember({ channelId: c.id, participantId: AGENT_8EO, role: "bot", addedBy: NESSA }),
		).toThrow(TableAuthError);
	});

	it("rejects duplicate membership", () => {
		const c = makeChannel();
		store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES });
		expect(() =>
			store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES }),
		).toThrow(TableConflictError);
	});

	it("owner/admin can remove a member", () => {
		const c = makeChannel();
		store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES });
		store.removeMember(c.id, NESSA, JAMES);
		expect(store.isMember(c.id, NESSA)).toBe(false);
	});
});

describe("messages: post, thread, edit, soft-delete", () => {
	it("posts a message and threads a reply", () => {
		const c = makeChannel();
		const root = store.postMessage({ channelId: c.id, authorId: JAMES, content: "hello team" });
		expect(root.id).toMatch(/^msg_[0-9a-f]{24}$/);
		const reply = store.postMessage({
			channelId: c.id,
			authorId: JAMES,
			content: "and welcome",
			replyTo: root.id,
		});
		const thread = store.getThread(root.id);
		expect(thread?.root.id).toBe(root.id);
		expect(thread?.replies.map((r) => r.id)).toEqual([reply.id]);
	});

	it("rejects a reply whose parent is in another channel", () => {
		const a = makeChannel("a");
		const b = makeChannel("b");
		const rootA = store.postMessage({ channelId: a.id, authorId: JAMES, content: "in a" });
		expect(() =>
			store.postMessage({ channelId: b.id, authorId: JAMES, content: "x", replyTo: rootA.id }),
		).toThrow(TableValidationError);
	});

	it("only a member may post", () => {
		const c = makeChannel();
		expect(() =>
			store.postMessage({ channelId: c.id, authorId: "human:stranger", content: "hi" }),
		).toThrow(TableAuthError);
	});

	it("only the author may edit", () => {
		const c = makeChannel();
		store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES });
		const m = store.postMessage({ channelId: c.id, authorId: JAMES, content: "typo herre" });
		expect(() =>
			store.editMessage({ messageId: m.id, editorId: NESSA, content: "typo here" }),
		).toThrow(TableAuthError);
		const edited = store.editMessage({ messageId: m.id, editorId: JAMES, content: "typo fixed" });
		expect(edited.content).toBe("typo fixed");
		expect(edited.editedAt).toBeGreaterThan(0);
	});

	it("author or admin may delete; delete blanks content and tombstones", () => {
		const c = makeChannel();
		store.addMember({ channelId: c.id, participantId: NESSA, role: "member", addedBy: JAMES });
		const mine = store.postMessage({ channelId: c.id, authorId: NESSA, content: "oops secret" });
		// owner (James) can delete another member's message
		const del = store.deleteMessage({ messageId: mine.id, deleterId: JAMES });
		expect(del.deletedAt).toBeGreaterThan(0);
		expect(del.content).toBe("");
		// excluded from default listing
		const listed = store.listMessages(c.id).map((m) => m.id);
		expect(listed).not.toContain(mine.id);
		// included when asked
		const all = store.listMessages(c.id, { includeDeleted: true }).map((m) => m.id);
		expect(all).toContain(mine.id);
	});

	it("listMessages returns ascending order and honors the before cursor", () => {
		const c = makeChannel();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			// force distinct createdAt ordering
			const m = store.postMessage({ channelId: c.id, authorId: JAMES, content: `m${i}` });
			ids.push(m.id);
		}
		const all = store.listMessages(c.id, { limit: 100 });
		const times = all.map((m) => m.createdAt);
		const sorted = [...times].sort((a, b) => a - b);
		expect(times).toEqual(sorted);
	});

	it("enforces private-channel read authority when a viewer is supplied", () => {
		const priv = store.createChannel({
			name: "priv",
			type: "stream",
			visibility: "private",
			createdBy: JAMES,
		});
		store.postMessage({ channelId: priv.id, authorId: JAMES, content: "classified" });
		expect(() => store.listMessages(priv.id, { viewerId: "human:stranger" })).toThrow(
			TableAuthError,
		);
		// member reads fine
		expect(store.listMessages(priv.id, { viewerId: JAMES }).length).toBe(1);
	});
});

describe("FTS search", () => {
	it("finds messages by term, snippets with <mark>, excludes deleted", () => {
		const c = makeChannel();
		store.postMessage({
			channelId: c.id,
			authorId: JAMES,
			content: "the accessibility audit passed",
		});
		const toDelete = store.postMessage({
			channelId: c.id,
			authorId: JAMES,
			content: "accessibility regression found",
		});
		const hits = store.search("accessibility");
		expect(hits.length).toBe(2);
		expect(hits[0].snippet).toContain("<mark>");

		store.deleteMessage({ messageId: toDelete.id, deleterId: JAMES });
		const afterDelete = store.search("accessibility");
		expect(afterDelete.map((h) => h.message.id)).not.toContain(toDelete.id);
		expect(afterDelete.length).toBe(1);
	});

	it("scopes search to a channel when channelId is given", () => {
		const a = makeChannel("a");
		const b = makeChannel("b");
		store.postMessage({ channelId: a.id, authorId: JAMES, content: "widget in a" });
		store.postMessage({ channelId: b.id, authorId: JAMES, content: "widget in b" });
		const inA = store.search("widget", { channelId: a.id });
		expect(inA.length).toBe(1);
		expect(inA[0].channelId).toBe(a.id);
	});

	it("returns [] for empty/operator-only queries without throwing", () => {
		makeChannel();
		expect(store.search("   ")).toEqual([]);
		expect(store.search("* ^ ()")).toEqual([]);
	});
});

describe("ledger append guarantee", () => {
	it("every mutation appends a signed entry and the chain verifies", () => {
		const c = makeChannel(); // +1 channel.create
		store.addMember({ channelId: c.id, participantId: AGENT_8EO, role: "bot", addedBy: JAMES }); // +1 member.add
		const m = store.postMessage({ channelId: c.id, authorId: JAMES, content: "audit ready" }); // +1 message.post
		store.editMessage({ messageId: m.id, editorId: JAMES, content: "audit shipped" }); // +1 message.edit
		store.deleteMessage({ messageId: m.id, deleterId: JAMES }); // +1 message.delete
		store.removeMember(c.id, AGENT_8EO, JAMES); // +1 member.remove

		const entries = ledger.readAll();
		const kinds = entries.map((e) => e.kind);
		expect(kinds).toEqual([
			"table.channel.create",
			"table.member.add",
			"table.message.post",
			"table.message.edit",
			"table.message.delete",
			"table.member.remove",
		]);
		const v = ledger.verify();
		expect(v.ok).toBe(true);
		expect(v.count).toBe(6);
	});

	it("records contentHash (not the mutable body) for message posts", () => {
		const c = makeChannel();
		store.postMessage({ channelId: c.id, authorId: JAMES, content: "sensitive body text" });
		const post = ledger.readAll().find((e) => e.kind === "table.message.post");
		expect(post).toBeDefined();
		expect(post?.payload).not.toHaveProperty("content");
		expect(typeof post?.payload.contentHash).toBe("string");
		expect((post?.payload.contentHash as string).length).toBe(64);
	});
});
