/**
 * Pi parity E5: one compaction path, and it never destroys history.
 *
 * compactHistory() is the only thing a turn calls (agent.compactIfNeeded, on
 * the native and the text-tool path alike). These tests drive it with a real
 * session store on disk and a mock summariser, and assert behaviour:
 *   - a long conversation crosses the threshold once and yields one summary
 *   - the session file still holds every original message
 *   - undo puts the originals back into the context
 *   - the next model request is the system prompt, the summary and the kept tail
 *   - a second crossing builds on the first summary (replaces the #3237 checkpoint test)
 *
 * Replaces TwoStageCompactor's acceptance tests (two-stage-compactor.test.ts)
 * and two-stage-agent-window.test.ts: that compactor is deleted. Its
 * threshold cases are covered by the stage-boundary tests below, its
 * "summary reaches the model" case by compaction-summary-reaches-model.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { rmRetry } from "../../../tests/rm-retry";
import { CompactionRecorder, ProactiveCompression, compactHistory } from "../compaction";
import { SessionStore } from "../session-store";

type Msg = { role: string; content: string };

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "compact-single-"));
});
afterAll(() => rmRetry(dir));

function mockModel(prompts: string[] = []) {
	let n = 0;
	return new MockLanguageModelV3({
		doGenerate: async (opts) => {
			prompts.push(JSON.stringify(opts.prompt));
			n++;
			return {
				content: [{ type: "text", text: `SUMMARY_${n}` }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
	});
}

const pad = "word ".repeat(150);
/** A system prompt then `turns` user/assistant exchanges, each message about 190 tokens. */
function conversation(turns: number, from = 0): Msg[] {
	const out: Msg[] = [];
	for (let i = from; i < from + turns; i++) {
		out.push({ role: "user", content: `question ${i}: ${pad}` });
		out.push({ role: "assistant", content: `answer ${i}: ${pad}` });
	}
	return out;
}
const tokens = (msgs: Msg[]) => msgs.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);

/** A window that puts `history` at `ratio` of it. */
function windowFor(history: Msg[], ratio: number) {
	return Math.floor(tokens(history) / ratio);
}

function freshStore() {
	return SessionStore.create({ cwd: dir, model: "m", provider: "p" }, dir);
}

const plain = (msgs: Array<{ role: string; content: unknown }>) =>
	msgs.map((m) => ({ role: m.role, content: String(m.content) }));

describe("one compaction, recorded in the session file", () => {
	test("crosses once, one summary, originals kept, undo restores them", async () => {
		const system: Msg = { role: "system", content: "SYSTEM PROMPT" };
		const originals = conversation(10);
		const history: Msg[] = [system, ...originals];
		const store = freshStore();
		const recorder = new CompactionRecorder(store);
		const engine = new ProactiveCompression({ contextWindow: windowFor(history, 0.85) });
		const prompts: string[] = [];

		const pass = await compactHistory({ engine, history, model: mockModel(prompts), recorder });
		if (!pass) throw new Error("expected a compaction");
		expect(pass.result.stage).toBe("summarize");

		// Exactly one summary: one note in the history, one compaction entry in the file.
		const notes = pass.messages.filter((m) => m.content.includes("[Proactive Compression"));
		expect(notes).toHaveLength(1);
		expect(pass.entryId).not.toBeNull();
		const lines = readFileSync(store.file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines.filter((l) => l.type === "compaction")).toHaveLength(1);

		// The history is system + summary + the kept tail (the last 8 messages).
		expect(pass.messages[0]).toBe(system);
		expect(pass.messages.slice(2)).toEqual(originals.slice(-8));
		expect(pass.messages.length).toBeLessThan(history.length);

		// The file still holds every original message, in order.
		expect(plain(store.messages())).toEqual(originals);
		const raw = readFileSync(store.file, "utf-8");
		for (const m of originals) expect(raw).toContain(JSON.stringify(m.content));

		// What the model would be sent after a resume: summary, then the same kept tail.
		const ctx = plain(store.context());
		expect(ctx.slice(1)).toEqual(originals.slice(-8));
		expect(ctx[0]?.content).toContain("SUMMARY_");
		expect(store.activeCompaction()?.tokensBefore).toBe(pass.result.tokensBefore);

		// Back under the line: the next turn does not compact again.
		const again = await compactHistory({ engine, history: pass.messages, model: mockModel(), recorder });
		expect(again).toBeNull();
		expect(lines.filter((l) => l.type === "compaction")).toHaveLength(1);

		// Undo: the context is the full conversation again, the file lost nothing.
		expect(store.undoCompaction()).toBe(pass.entryId);
		expect(plain(store.context())).toEqual(originals);
		expect(plain(store.messages())).toEqual(originals);
		expect(readFileSync(store.file, "utf-8")).toContain('"type":"uncompact"');
	});

	test("the next model request is system prompt + summary + kept tail + the new message", async () => {
		const system: Msg = { role: "system", content: "SYSTEM PROMPT" };
		const history: Msg[] = [system, ...conversation(10)];
		const engine = new ProactiveCompression({ contextWindow: windowFor(history, 0.85) });
		const pass = await compactHistory({
			engine,
			history,
			model: mockModel(),
			recorder: new CompactionRecorder(freshStore()),
		});
		if (!pass) throw new Error("expected a compaction");
		const next = [...pass.messages, { role: "user", content: "what now?" }];
		expect(next.map((m) => m.role)).toEqual(["system", "user", ...Array(8).fill(null).map((_, i) => history.slice(-8)[i].role), "user"]);
		expect(next[1].content).toContain("SUMMARY_1");
		expect(next.at(-1)?.content).toBe("what now?");
	});

	test("a second crossing is written on top of the first summary", async () => {
		const system: Msg = { role: "system", content: "SYSTEM PROMPT" };
		let history: Msg[] = [system, ...conversation(10)];
		const store = freshStore();
		const recorder = new CompactionRecorder(store);
		const engine = new ProactiveCompression({ contextWindow: windowFor(history, 0.85) });
		const first = await compactHistory({ engine, history, model: mockModel(), recorder });
		if (!first) throw new Error("expected a compaction");
		history = first.messages;

		// The conversation carries on until it crosses again.
		// (a message pair at a time, until the engine says summarize)
		let more: Msg[] = [];
		for (let t = 1; engine.getStage([...history, ...more]) !== "summarize"; t++) {
			more = conversation(t, 10);
			if (t > 40) throw new Error("never reached the summarize stage");
		}
		history = [...history, ...more];
		const prompts: string[] = [];
		const second = await compactHistory({ engine, history, model: mockModel(prompts), recorder });
		if (!second) throw new Error("expected a second compaction");
		expect(prompts[0]).toContain("SUMMARY_1"); // the first summary is the base
		expect(prompts[0]).toContain("previous-summary");

		const entries = readFileSync(store.file, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((l) => l.type === "compaction");
		expect(entries).toHaveLength(2);
		// Every original is in the file exactly once; the summaries are not messages.
		expect(plain(store.messages())).toEqual([...conversation(10), ...more]);
		// Undoing the latest one makes the first apply again.
		store.undoCompaction();
		expect(store.activeCompaction()?.id).toBe(entries[0].id);
	});
});

describe("thresholds are unchanged", () => {
	const history: Msg[] = [{ role: "system", content: "sys" }, ...conversation(10)];
	for (const [ratio, stage] of [
		[0.7, "none"],
		[0.76, "unwind"],
		[0.85, "summarize"],
		[0.93, "simplify"],
		[0.99, "nuke"],
	] as const) {
		test(`${ratio} of the window is the ${stage} stage`, () => {
			expect(new ProactiveCompression().getStage(history, windowFor(history, ratio))).toBe(stage);
		});
	}

	test("under the line nothing is summarised and the file is not touched", async () => {
		const store = freshStore();
		const before = readFileSync(store.file, "utf-8");
		const engine = new ProactiveCompression({ contextWindow: windowFor(history, 0.5) });
		let calls = 0;
		const model = mockModel();
		const orig = model.doGenerate.bind(model);
		model.doGenerate = (async (o: never) => (calls++, orig(o))) as typeof model.doGenerate;
		expect(await compactHistory({ engine, history, model, recorder: new CompactionRecorder(store) })).toBeNull();
		expect(calls).toBe(0);
		expect(readFileSync(store.file, "utf-8")).toBe(before);
	});

	test("a history with nothing older than the kept tail is left alone (no empty summary)", async () => {
		const tiny: Msg[] = [{ role: "system", content: "sys" }, ...conversation(2)];
		const store = freshStore();
		const engine = new ProactiveCompression({ contextWindow: windowFor(tiny, 0.85) });
		const pass = await compactHistory({ engine, history: tiny, model: mockModel(), recorder: new CompactionRecorder(store) });
		expect(pass?.messages).toEqual(tiny);
		expect(pass?.entryId ?? null).toBeNull();
		expect(readFileSync(store.file, "utf-8")).not.toContain('"type":"compaction"');
	});
});

describe("stages without a summary still keep the originals", () => {
	test("unwind drops old tool results from the context, not from the file", async () => {
		const history: Msg[] = [{ role: "system", content: "sys" }];
		for (let i = 0; i < 12; i++) {
			history.push({ role: "user", content: `u${i} ${pad}` });
			history.push({ role: "assistant", content: `a${i} ${pad}` });
		}
		// Tool results are not chat messages; the file holds the chat either way.
		history.splice(3, 0, { role: "tool", content: `big tool output ${pad}` });
		const store = freshStore();
		const engine = new ProactiveCompression({ contextWindow: windowFor(history, 0.77) });
		const pass = await compactHistory({ engine, history, model: mockModel(), recorder: new CompactionRecorder(store) });
		expect(pass?.result.stage).toBe("unwind");
		expect(pass?.messages.some((m) => m.role === "tool")).toBe(false);
		expect(pass?.entryId).toBeNull();
		expect(store.messages()).toHaveLength(24);
	});

	test("nuke is a recorded compaction: the context is cut, undo brings the chat back", async () => {
		const originals = conversation(10);
		const history: Msg[] = [{ role: "system", content: "sys" }, ...originals];
		const store = freshStore();
		const engine = new ProactiveCompression({ contextWindow: windowFor(history, 0.99) });
		const pass = await compactHistory({ engine, history, model: mockModel(), recorder: new CompactionRecorder(store) });
		expect(pass?.result.stage).toBe("nuke");
		expect(pass?.messages).toHaveLength(3);
		expect(pass?.entryId).not.toBeNull();
		expect(plain(store.messages())).toEqual(originals);
		expect(plain(store.context()).slice(1)).toEqual(originals.slice(-2));
		store.undoCompaction();
		expect(plain(store.context())).toEqual(originals);
	});
});
