/**
 * #3260: what the harness injects during a turn reaches the model.
 *
 * Vision interpretation, proactive questioning and the pre-tool router each
 * add context to the history. They used to add it as a `system` message, and
 * every request builder keeps only the first system message (the prompt), so
 * none of it ever left the process. They now travel as a harness context note
 * (the #3222 pattern), after the byte-stable prefix.
 *
 * Like prompt-byte-stability.test.ts this drives the shipping chat() path
 * against a fake OpenAI-compatible endpoint and asserts on the request bodies,
 * not on the agent's internals. $HOME is faked so the operator's memories,
 * sessions and config stay out of the test.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
let VisionInterpreter: typeof import("./vision-interpreter").VisionInterpreter;
let CONTEXT_NOTE_HEADER: string;

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

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "notes3260-home-"));
	repo = mkdtempSync(join(tmpdir(), "notes3260-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	mkdirSync(join(repo, "docs"), { recursive: true });
	writeFileSync(join(repo, "docs", "sentinel.md"), "SENTINEL_3260_prefetched_file_body\n");
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	({ VisionInterpreter } = await import("./vision-interpreter"));
	({ CONTEXT_NOTE_HEADER } = await import("./context-note"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			bodies.push((await req.json()) as Body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
});

afterAll(async () => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	// Close the memory databases the agents opened under the temp home first:
	// Windows refuses to delete a directory holding an open file.
	(await import("../memory")).resetMemoryManager();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
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

/** The first request body the model receives for one chat() turn. */
async function turn(agent: AgentT, text: string, image?: string): Promise<Body> {
	const start = bodies.length;
	await agent.chat(text, image, image ? "image/png" : undefined);
	const body = bodies[start];
	if (!body) throw new Error(`no model request for "${text}"`);
	return body;
}

/** Non-system messages whose text contains `needle`. */
function carrying(body: Body, needle: string): Msg[] {
	return body.messages.filter(
		(m) => m.role !== "system" && JSON.stringify(m.content).includes(needle),
	);
}

const system = (b: Body) => JSON.stringify(b.messages.filter((m) => m.role === "system"));

// Both shipping request builders dropped the notes: the text-tool path for
// local servers and the native-tool path.
for (const [label, textTools] of [
	["text-tool (local)", "1"],
	["native-tool (full prompt)", "0"],
] as const) {
	describe(`harness notes reach the request body, ${label} path`, () => {
		beforeAll(() => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
		});
		afterAll(() => {
			Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
			Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		});

		test("proactive questioning: the clarifying question is sent", async () => {
			// "fix it" is vague, so the gate asks where the bug is.
			const body = await turn(build(), "fix it");
			const notes = carrying(body, "[PROACTIVE QUESTIONING]");
			expect(notes.length).toBe(1);
			expect(JSON.stringify(notes[0]?.content)).toContain(CONTEXT_NOTE_HEADER);
		}, 60_000);

		test("pre-tool router: the prefetched file is sent", async () => {
			// Clear enough to skip the proactive gate, and names a file, so the
			// router reads docs/sentinel.md before the model call.
			const body = await turn(
				build(),
				"Using typescript, update the api notes: read docs/sentinel.md and summarise the three decisions it records for the release team.",
			);
			const notes = carrying(body, "SENTINEL_3260_prefetched_file_body");
			expect(notes.length).toBe(1);
			expect(JSON.stringify(notes[0]?.content)).toContain("[PRE-FETCHED CONTEXT]");
			expect(JSON.stringify(notes[0]?.content)).toContain(CONTEXT_NOTE_HEADER);
		}, 60_000);

		test("vision: the interpretation is sent, and the prefix does not move", async () => {
			// The vision model is a network call; stand it in with one that
			// reports a fixed description through the interpreter's own callback.
			const interpret = spyOn(VisionInterpreter.prototype, "interpret").mockImplementation(
				function (this: unknown) {
					const onResult = (this as { onResult?: (id: string, r: unknown) => void }).onResult;
					queueMicrotask(() =>
						onResult?.("vision-test", {
							description: "SENTINEL_3260_vision_description",
							model: "fake-vision",
							provider: "test",
							durationMs: 1,
							free: true,
						}),
					);
					return "vision-test";
				},
			);
			try {
				let interpreted!: () => void;
				const seen = new Promise<void>((resolve) => {
					interpreted = resolve;
				});
				const agent = build({
					onStepFinish: (s: { text?: string }) => {
						if (s.text?.startsWith("Image interpreted by")) interpreted();
					},
				});
				const t1 = await turn(agent, "What is in this screenshot?", "aGVsbG8=");
				await seen;
				const t2 = await turn(agent, "and the second one?");
				expect(system(t2)).toBe(system(t1));
				const notes = carrying(t2, "SENTINEL_3260_vision_description");
				expect(notes.length).toBe(1);
				expect(JSON.stringify(notes[0]?.content)).toContain(CONTEXT_NOTE_HEADER);
			} finally {
				interpret.mockRestore();
			}
		}, 60_000);
	});
}
