/**
 * #4958: a compaction on request. compactHistoryNow() runs the same summary
 * pass auto-compaction uses, regardless of the threshold, and CompactionUndo
 * keeps the one level of undo that needs no session file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { rmRetry } from "../../../tests/rm-retry";
import {
	CompactionRecorder,
	CompactionUndo,
	ProactiveCompression,
	compactHistory,
	compactHistoryNow,
	estimateMessageTokens,
} from "../compaction";
import { SessionStore } from "../session-store";

type Msg = { role: string; content: string };

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "compact-now-"));
});
afterAll(() => rmRetry(dir));

function mockModel() {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			content: [{ type: "text", text: "SUMMARY_NOW" }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
			warnings: [],
		}),
	});
}

const pad = "word ".repeat(150);
function conversation(turns: number): Msg[] {
	const out: Msg[] = [{ role: "system", content: "SYSTEM PROMPT" }];
	for (let i = 0; i < turns; i++) {
		out.push({ role: "user", content: `question ${i}: ${pad}` });
		out.push({ role: "assistant", content: `answer ${i}: ${pad}` });
	}
	return out;
}

describe("compactHistoryNow", () => {
	test("compacts a history the threshold would leave alone, with real before and after numbers", async () => {
		const history = conversation(10);
		const engine = new ProactiveCompression();
		// The automatic path leaves a half-empty window alone...
		expect(await compactHistory({ engine, history, model: mockModel() })).toBeNull();
		// ...a request does not.
		const pass = await compactHistoryNow({ engine, history, model: mockModel() });
		expect(pass).not.toBeNull();
		expect(pass!.result.stage).toBe("summarize");
		expect(pass!.result.tokensBefore).toBe(estimateMessageTokens(history as never));
		expect(pass!.result.tokensAfter).toBe(estimateMessageTokens(pass!.messages));
		expect(pass!.result.tokensAfter).toBeLessThan(pass!.result.tokensBefore);
		expect(pass!.result.messagesRemoved).toBeGreaterThan(0);
		expect(pass!.result.summary).toContain("SUMMARY_NOW");
		// System prompt first, the summary next, the kept tail last.
		expect(pass!.messages[0]).toEqual(history[0] as never);
		expect(pass!.messages.at(-1)).toEqual(history.at(-1) as never);
	});

	test("a conversation shorter than the kept tail has nothing to compact: null, history untouched", async () => {
		const history = conversation(3);
		const pass = await compactHistoryNow({
			engine: new ProactiveCompression(),
			history,
			model: mockModel(),
		});
		expect(pass).toBeNull();
	});

	test("with a session file it records one entry, and the originals stay in the file", async () => {
		const store = SessionStore.create({ cwd: dir, model: "m", provider: "p" }, dir);
		const recorder = new CompactionRecorder(store);
		const history = conversation(10);
		const pass = await compactHistoryNow({
			engine: new ProactiveCompression(),
			history,
			model: mockModel(),
			recorder,
		});
		expect(pass?.entryId).toBeTruthy();
		expect(store.activeCompaction()?.id).toBe(pass!.entryId as string);
		expect(store.undoCompaction()).toBe(pass!.entryId as string);
	});
});

describe("CompactionUndo", () => {
	const m = (role: string, content: string) => ({ role, content });
	const before = [m("system", "s"), m("user", "one"), m("assistant", "A1"), m("user", "two")];
	// A compaction replaced the 3 messages after the prompt with one summary.
	const after = [m("system", "s"), m("user", "SUMMARY"), m("user", "two")];

	test("nothing to undo before a compaction", () => {
		const u = new CompactionUndo();
		expect(u.available).toBe(false);
		expect(u.take(after as never)).toBeNull();
	});

	test("undo straight after: exactly the history that was remembered, once", () => {
		const u = new CompactionUndo();
		u.remember(before as never, "e1", after.length);
		expect(u.available).toBe(true);
		const back = u.take(after as never);
		expect(back?.messages).toEqual(before as never);
		expect(back?.entryId).toBe("e1");
		expect(u.available).toBe(false);
		expect(u.take(after as never)).toBeNull();
	});

	test("turns added after the compaction survive the undo, in order", () => {
		const u = new CompactionUndo();
		u.remember(before as never, null, after.length);
		const live = [...after, m("assistant", "A2"), m("user", "three"), m("assistant", "A3")];
		const back = u.take(live as never);
		expect(back?.messages).toEqual([
			...before,
			m("assistant", "A2"),
			m("user", "three"),
			m("assistant", "A3"),
		] as never);
	});

	test("remembers a copy: later edits to the live array do not change what comes back", () => {
		const live = [...before];
		const u = new CompactionUndo();
		u.remember(live as never, null, after.length);
		live.push(m("user", "later"));
		expect(u.take(after as never)?.messages.length).toBe(before.length);
	});

	test("a history cleared since the compaction is not merged: nothing to undo", () => {
		const u = new CompactionUndo();
		u.remember(before as never, "e1", after.length);
		expect(u.take([m("system", "s")] as never)).toBeNull();
		expect(u.available).toBe(false);
	});

	test("a newer compaction replaces the older one: one level", () => {
		const u = new CompactionUndo();
		u.remember(before as never, "e1", after.length);
		u.remember([...before, m("assistant", "x")] as never, "e2", after.length);
		expect(u.take(after as never)?.entryId).toBe("e2");
		expect(u.take(after as never)).toBeNull();
	});
});
