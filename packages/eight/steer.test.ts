/**
 * D1 steering, engine side: Agent.steer() sent while a turn runs lands after
 * the current tool call and before the next model call. Drives the shipping
 * chat() path (local text-tools) against a fake OpenAI-compatible endpoint and
 * asserts on the request bodies the model receives. $HOME is faked so the
 * operator's memories, sessions and config stay out of the test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;

type Msg = { role: string; content: unknown };
type Body = { messages: Msg[] };

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Body[] = [];
/** Called with the request index before the fake model answers. */
let onRequest: (index: number) => void = () => {};

const TOOL_CALL = [
	"Reading the notes.",
	"```tool_call",
	'{"name": "read_file", "arguments": {"path": "notes.txt"}}',
	"```",
].join("\n");

function reply(content: string): Response {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "steer-home-"));
	repo = mkdtempSync(join(tmpdir(), "steer-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "notes.txt"), "NOTES_BODY_D1\n");
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			if (new URL(req.url).pathname === "/api/show") {
				return Response.json({ capabilities: ["completion", "tools"] });
			}
			const index = bodies.length;
			bodies.push((await req.json()) as Body);
			onRequest(index);
			return reply(index === 0 ? TOOL_CALL : "DONE: read notes.txt, then did what you asked.");
		},
	});
});

afterAll(async () => {
	server?.stop(true);
	(await import("../memory/index")).resetMemoryManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

function build(events?: Record<string, unknown>): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		events,
	} as ConstructorParameters<typeof Agent>[0]);
}

const userTexts = (b: Body) =>
	b.messages.filter((m) => m.role === "user").map((m) => String(m.content));

describe("Agent.steer (D1 engine)", () => {
	test("a steer sent mid-run lands after the current tool call, before the next model call", async () => {
		bodies.length = 0;
		const steered: string[] = [];
		const agent = build({ onSteer: (e: { text: string }) => steered.push(e.text) });
		// The person types while the model's first reply (a tool call) is in flight.
		onRequest = (i) => {
			if (i === 0) agent.steer("STEER_D1 also count the lines");
		};
		await agent.chat("read notes.txt");
		onRequest = () => {};

		expect(bodies.length).toBeGreaterThanOrEqual(2);
		// The first model call never saw it.
		expect(userTexts(bodies[0]).some((t) => t.includes("STEER_D1"))).toBe(false);
		// The second did: as the last user message, after the tool result.
		const second = userTexts(bodies[1]);
		const steerAt = second.findIndex((t) => t.includes("STEER_D1"));
		const resultAt = second.findIndex((t) => t.includes("NOTES_BODY_D1"));
		expect(resultAt).toBeGreaterThanOrEqual(0);
		expect(steerAt).toBe(second.length - 1);
		expect(steerAt).toBeGreaterThan(resultAt);
		// Delivered once: event fired, queue empty, kept in the session history.
		expect(steered).toEqual(["STEER_D1 also count the lines"]);
		expect(agent.queuedSteers()).toEqual([]);
		expect(
			agent.getMessageHistory().filter((m) => m.role === "user" && m.content.includes("STEER_D1")),
		).toHaveLength(1);
	});

	test("a steer with no model call left stays queued for the caller to send next", async () => {
		const agent = build();
		agent.steer("   ");
		agent.steer("FOLLOW_UP_D1");
		expect(agent.queuedSteers()).toEqual(["FOLLOW_UP_D1"]);
		expect(agent.takeQueuedSteers()).toEqual(["FOLLOW_UP_D1"]);
		expect(agent.queuedSteers()).toEqual([]);
	});

	test("the queue is capped: 8 steers, 16 KB each", () => {
		const agent = build();
		for (let i = 0; i < 8; i++) expect(agent.steer(`s${i}`)).toBe(true);
		expect(agent.steer("ninth")).toBe(false);
		agent.takeQueuedSteers();
		expect(agent.steer("x".repeat(16 * 1024))).toBe(true);
		expect(agent.steer("x".repeat(16 * 1024 + 1))).toBe(false);
		expect(agent.steer("é".repeat(8 * 1024 + 1))).toBe(false);
	});

	test("a steer left from before a turn is never delivered into it", async () => {
		bodies.length = 0;
		const agent = build();
		agent.steer("STALE_D1");
		await agent.chat("read notes.txt");
		for (const b of bodies) expect(JSON.stringify(b).includes("STALE_D1")).toBe(false);
		expect(agent.queuedSteers()).toEqual([]);
	});

	test("nothing is delivered into an aborted turn", () => {
		const agent = build();
		const internals = agent as unknown as {
			abortController: AbortController | null;
			activeTurn: number | null;
			drainSteers: () => string[];
		};
		internals.activeTurn = 7;
		agent.steer("AFTER_ESC");
		// steer() stamped it with turn 7; the turn is then aborted.
		const controller = new AbortController();
		internals.abortController = controller;
		controller.abort();
		expect(internals.drainSteers()).toEqual([]);
		internals.abortController = null;
		expect(internals.drainSteers()).toEqual([]);
		// Still there for the caller to hand back.
		expect(agent.takeQueuedSteers()).toEqual(["AFTER_ESC"]);
	});
});
