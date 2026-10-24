/**
 * #4958 second read: /compact undo must not rewind the conversation. Compact,
 * run a turn, undo: the turn is still in the history, and so is everything the
 * compaction had summarised. Driven through the real Agent against a fake
 * OpenAI-compatible endpoint (the pattern of compaction-summary-reaches-model),
 * whose summary calls answer with a sentinel.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../../tests/rm-retry";
import type { Agent as AgentT } from "../agent";

let Agent: typeof import("../agent").Agent;
type Body = { messages: Array<{ role: string; content: unknown }> };

const SUMMARY = "SENTINEL_4958_summary";
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = { EIGHT_TOOL_CAPABILITY_GATE: "0" };
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;

const isSummaryRequest = (b: Body) =>
	!b.messages.some((m) => m.role === "system") &&
	JSON.stringify(b.messages).includes("<conversation>");

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "undo4958-home-"));
	repo = mkdtempSync(join(tmpdir(), "undo4958-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("../agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as Body;
			const content = isSummaryRequest(body) ? SUMMARY : "Done.";
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

function build(): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
	} as ConstructorParameters<typeof Agent>[0]);
}

const text = (a: AgentT) =>
	a
		.getMessageHistory()
		.map((m) => String(m.content))
		.join("\n----\n");

describe("/compact undo keeps the conversation moving", () => {
	test("compact, run a turn, undo: the new turn is still there, and so is what the summary replaced", async () => {
		const agent = build();
		for (let i = 1; i <= 6; i++) {
			await agent.chat(
				`Using typescript, describe step ${i} of the api release plan in two sentences.`,
			);
		}
		const sizeBefore = agent.getMessageHistory().length;
		const result = await agent.compactNow();
		expect(result).not.toBeNull();
		expect(text(agent)).toContain(SUMMARY);
		expect(agent.getMessageHistory().length).toBeLessThan(sizeBefore);
		expect(text(agent)).not.toContain("describe step 1 of");

		await agent.chat("Using typescript, what is the SECOND_ASK_MARKER for the release?");
		expect(text(agent)).toContain("SECOND_ASK_MARKER");

		const back = agent.undoCompaction();
		expect(back).not.toBeNull();
		const after = text(agent);
		// The turn run after the compaction survives...
		expect(after).toContain("SECOND_ASK_MARKER");
		// ...and what the compaction summarised is back.
		expect(after).toContain("describe step 1 of");
		expect(after).not.toContain(SUMMARY);
		// In order: the old conversation, then the new turn.
		expect(after.indexOf("describe step 1 of")).toBeLessThan(after.indexOf("SECOND_ASK_MARKER"));
		// One level: a second undo has nothing to do.
		expect(agent.undoCompaction()).toBeNull();
	}, 60000);

	test("a conversation too short to compact says so and changes nothing", async () => {
		const agent = build();
		await agent.chat("Using typescript, say hi.");
		const before = text(agent);
		expect(await agent.compactNow()).toBeNull();
		expect(text(agent)).toBe(before);
		expect(agent.undoCompaction()).toBeNull();
	}, 30000);
});
