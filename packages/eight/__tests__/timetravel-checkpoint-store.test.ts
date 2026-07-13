/**
 * TimeTravelStore tests.
 *
 * Issue: 8gi-foundation/8gent-code#2757 (session time-travel, step 1).
 * Covers the content-addressed checkpoint store: save/list/load roundtrip,
 * blob dedup across consecutive checkpoints, rewind(n), fork lineage, and
 * the EIGHT_CHECKPOINT_EVERY interval policy.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CheckpointMessage,
	DEFAULT_CHECKPOINT_EVERY,
	TimeTravelStore,
	checkpointEveryFromEnv,
} from "../timetravel/checkpoint-store";

let dataDir: string;
let store: TimeTravelStore;

function msg(role: string, content: string): CheckpointMessage {
	return { role, content };
}

function countBlobFiles(): number {
	const blobsRoot = path.join(dataDir, "blobs");
	let count = 0;
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".json")) count++;
		}
	};
	try {
		walk(blobsRoot);
	} catch {
		return 0;
	}
	return count;
}

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "timetravel-store-test-"));
	store = new TimeTravelStore({ dataDir });
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("TimeTravelStore save/list/load", () => {
	it("roundtrips a checkpoint through save and load", () => {
		const messages = [
			msg("system", "You are the agent."),
			msg("user", "fix the failing test"),
			msg("assistant", "Reading the test file."),
		];
		const meta = store.save("session_a", messages, { reason: "manual", toolCallCount: 3 });

		expect(meta.sessionId).toBe("session_a");
		expect(meta.parentId).toBeNull();
		expect(meta.messageCount).toBe(3);
		expect(meta.messageHashes).toHaveLength(3);
		expect(meta.newBlobs).toBe(3);

		const restored = store.load("session_a", meta.id);
		expect(restored.meta.id).toBe(meta.id);
		expect(restored.messages).toEqual(messages);
	});

	it("lists checkpoints oldest first and chains parentId", () => {
		const first = store.save("session_a", [msg("user", "one")], { reason: "interval" });
		const second = store.save("session_a", [msg("user", "one"), msg("assistant", "two")], {
			reason: "interval",
		});

		const metas = store.list("session_a");
		expect(metas.map((m) => m.id)).toEqual([first.id, second.id]);
		expect(metas[1].parentId).toBe(first.id);
		expect(store.latest("session_a")?.id).toBe(second.id);
	});

	it("returns an empty list for an unknown session", () => {
		expect(store.list("session_never_seen")).toEqual([]);
		expect(store.latest("session_never_seen")).toBeNull();
	});

	it("throws on loading a missing checkpoint", () => {
		expect(() => store.load("session_a", "cp_missing")).toThrow(/not found/);
	});

	it("rejects unsafe session ids", () => {
		expect(() => store.save("../escape", [msg("user", "x")], { reason: "manual" })).toThrow(
			/unsafe session id/,
		);
		expect(() => store.list("a/b")).toThrow(/unsafe session id/);
	});
});

describe("TimeTravelStore content addressing", () => {
	it("dedupes shared prefix blobs across consecutive checkpoints", () => {
		const prefix = [msg("system", "prompt"), msg("user", "task"), msg("assistant", "step 1")];
		store.save("session_a", prefix, { reason: "interval" });
		expect(countBlobFiles()).toBe(3);

		const second = store.save("session_a", [...prefix, msg("assistant", "step 2")], {
			reason: "interval",
		});
		// Only the one genuinely new message costs a blob write.
		expect(second.newBlobs).toBe(1);
		expect(countBlobFiles()).toBe(4);
	});

	it("dedupes identical messages across different sessions", () => {
		store.save("session_a", [msg("user", "same content")], { reason: "manual" });
		const other = store.save("session_b", [msg("user", "same content")], { reason: "manual" });
		expect(other.newBlobs).toBe(0);
		expect(countBlobFiles()).toBe(1);
	});
});

describe("TimeTravelStore rewind", () => {
	it("rewind(0) is the latest and rewind(n) walks back", () => {
		store.save("session_a", [msg("user", "v1")], { reason: "interval" });
		store.save("session_a", [msg("user", "v1"), msg("assistant", "v2")], { reason: "interval" });
		store.save("session_a", [msg("user", "v1"), msg("assistant", "v2"), msg("user", "v3")], {
			reason: "interval",
		});

		expect(store.rewind("session_a", 0)?.messages).toHaveLength(3);
		expect(store.rewind("session_a", 1)?.messages).toHaveLength(2);
		expect(store.rewind("session_a", 2)?.messages).toEqual([msg("user", "v1")]);
	});

	it("returns null past the beginning of history", () => {
		store.save("session_a", [msg("user", "only")], { reason: "manual" });
		expect(store.rewind("session_a", 1)).toBeNull();
		expect(store.rewind("session_empty", 0)).toBeNull();
	});

	it("rejects negative or fractional steps", () => {
		expect(() => store.rewind("session_a", -1)).toThrow(/non-negative integer/);
		expect(() => store.rewind("session_a", 1.5)).toThrow(/non-negative integer/);
	});
});

describe("TimeTravelStore fork", () => {
	it("forks a checkpoint into a new session without rewriting blobs", () => {
		const messages = [msg("system", "prompt"), msg("user", "task")];
		const source = store.save("session_a", messages, { reason: "interval", toolCallCount: 6 });
		const blobsBefore = countBlobFiles();

		const forked = store.fork("session_a", source.id, "session_b");

		expect(forked.sessionId).toBe("session_b");
		expect(forked.reason).toBe("fork");
		expect(forked.forkedFrom).toBe(source.id);
		expect(forked.parentId).toBeNull();
		expect(forked.newBlobs).toBe(0);
		expect(countBlobFiles()).toBe(blobsBefore);

		// The fork restores the exact same state.
		expect(store.load("session_b", forked.id).messages).toEqual(messages);
	});

	it("forked lineages diverge independently", () => {
		const shared = [msg("user", "shared root")];
		const source = store.save("session_a", shared, { reason: "interval" });
		const forked = store.fork("session_a", source.id, "session_b");

		store.save("session_a", [...shared, msg("assistant", "approach A")], { reason: "interval" });
		store.save("session_b", [...shared, msg("assistant", "approach B")], { reason: "interval" });

		const aLatest = store.rewind("session_a", 0);
		const bLatest = store.rewind("session_b", 0);
		expect(aLatest?.messages[1]).toEqual(msg("assistant", "approach A"));
		expect(bLatest?.messages[1]).toEqual(msg("assistant", "approach B"));
		expect(store.list("session_b")[1].parentId).toBe(forked.id);
	});

	it("throws when forking a missing checkpoint", () => {
		expect(() => store.fork("session_a", "cp_missing", "session_b")).toThrow(/not found/);
	});
});

describe("checkpointEveryFromEnv", () => {
	it("defaults when unset or invalid", () => {
		expect(checkpointEveryFromEnv({})).toBe(DEFAULT_CHECKPOINT_EVERY);
		expect(checkpointEveryFromEnv({ EIGHT_CHECKPOINT_EVERY: "" })).toBe(DEFAULT_CHECKPOINT_EVERY);
		expect(checkpointEveryFromEnv({ EIGHT_CHECKPOINT_EVERY: "nope" })).toBe(
			DEFAULT_CHECKPOINT_EVERY,
		);
		expect(checkpointEveryFromEnv({ EIGHT_CHECKPOINT_EVERY: "-3" })).toBe(DEFAULT_CHECKPOINT_EVERY);
	});

	it("honours an explicit interval and 0-disables", () => {
		expect(checkpointEveryFromEnv({ EIGHT_CHECKPOINT_EVERY: "12" })).toBe(12);
		expect(checkpointEveryFromEnv({ EIGHT_CHECKPOINT_EVERY: "0" })).toBe(0);
	});
});
