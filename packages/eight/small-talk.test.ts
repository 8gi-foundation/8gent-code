/**
 * Small-talk gate (#4756): a greeting alone gets no tools, and a home folder
 * that is not a repo is not described to the model as a project.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainHome, workingProjectNote } from "./prompts/system-prompt";
import { isSmallTalk } from "./small-talk";

describe("isSmallTalk", () => {
	test("a greeting or pleasantry alone is small talk", () => {
		for (const t of [
			"hi",
			"Hi!",
			"hello",
			"hey there",
			"what upp",
			"what up",
			"what's up?",
			"whats up",
			"wassup",
			"sup",
			"yo",
			"hey, what's up",
			"good morning",
			"how are you",
			"thanks",
			"[Mode: Implementing] hi",
		])
			expect({ t, v: isSmallTalk(t) }).toEqual({ t, v: true });
	});

	test("anything that carries a task, or is not a greeting, is not", () => {
		for (const t of [
			"",
			"hi, run the tests",
			"what up with the build",
			"hello world program in rust",
			"what is in my home folder",
			"hey can you check git status",
			"thanks, now fix the bug",
			"ok go ahead and deploy",
			"ok",
			"okay",
			"cool",
			"great",
			"nice",
			"hi hi hi hi hi hi hi hi hi hi hi hi hi hi hi hi",
		])
			expect({ t, v: isSmallTalk(t) }).toEqual({ t, v: false });
	});
});

describe("home folder that is not a repo", () => {
	test("is named as not a project; a repo or another folder is not", () => {
		const saved = process.env.EIGHT_HOME;
		const home = mkdtempSync(join(tmpdir(), "home-"));
		process.env.EIGHT_HOME = home;
		try {
			expect(isPlainHome(home)).toBe(true);
			expect(workingProjectNote(home)).toContain("is the person's home folder, not a project");
			mkdirSync(join(home, "work"));
			expect(workingProjectNote(join(home, "work"))).not.toContain("home folder");
			mkdirSync(join(home, ".git"));
			expect(isPlainHome(home)).toBe(false);
			expect(workingProjectNote(home)).not.toContain("home folder");
		} finally {
			rmSync(home, { recursive: true, force: true });
			if (saved === undefined) {
				// biome-ignore lint/performance/noDelete: an env var set to undefined becomes the string "undefined"
				delete process.env.EIGHT_HOME;
			} else process.env.EIGHT_HOME = saved;
		}
	});
});

// The wiring in agent.ts: a greeting is sent with no tools on both shipping
// paths, extension tools included; a task keeps them. Fake OpenAI-compatible
// endpoint, $HOME faked, as in extensions-agent.test.ts.
type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

describe("agent wiring: a small-talk turn is sent with no tools", () => {
	let Agent: typeof import("./agent").Agent;
	const saved: Record<string, string | undefined> = {};
	let home = "";
	let repo = "";
	let server: ReturnType<typeof Bun.serve>;
	let bodies: Body[] = [];

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "smalltalk-home-"));
		repo = mkdtempSync(join(tmpdir(), "smalltalk-repo-"));
		mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
		mkdirSync(join(home, ".8gent", "extensions"), { recursive: true });
		writeFileSync(
			join(home, ".8gent", "extensions", "demo.ts"),
			`export default function (api: any) {
	api.registerTool({ name: "shout", description: "Upper-case text",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		execute: ({ text }: { text: string }) => String(text).toUpperCase() });
}
`,
		);
		for (const [k, v] of Object.entries({
			HOME: home,
			EIGHT_DATA_DIR: join(home, ".8gent"),
			EIGHT_TOOL_CAPABILITY_GATE: "0",
			"8GENT_TWO_STAGE_COMPACT": "0",
		})) {
			saved[k] = process.env[k];
			process.env[k] = v;
		}
		({ Agent } = await import("./agent"));
		(await import("../hooks")).resetHookManager();
		server = Bun.serve({
			hostname: "127.0.0.1",
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
						{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			},
		});
		process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
	});

	afterAll(async () => {
		server?.stop(true);
		(await import("../hooks")).resetHookManager();
		(await import("../memory/index")).resetMemoryManager();
		Reflect.deleteProperty(process.env, "OLLAMA_HOST");
		Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const build = () =>
		new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
			extensions: true,
			extensionsDir: join(home, ".8gent", "extensions"),
			attended: true,
		} as ConstructorParameters<typeof Agent>[0]);

	for (const [label, textTools] of [
		["text-tool", "1"],
		["native-tool", "0"],
	] as const) {
		test(`${label} path: "what upp" offers no tools, "ok" and a task keep them`, async () => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			bodies = [];
			await build().chat("what upp");
			expect(bodies.length).toBeGreaterThan(0);
			for (const b of bodies) {
				expect(b.tools ?? []).toEqual([]);
				expect(JSON.stringify(b)).not.toContain("shout");
			}
			expect(JSON.stringify(bodies[0].messages)).toContain("[SMALL TALK]");

			for (const keep of ["ok", "Shout hey, then list the files."]) {
				bodies = [];
				await build().chat(keep);
				expect(bodies.length).toBeGreaterThan(0);
				expect(JSON.stringify(bodies[0])).toContain("shout");
				expect(JSON.stringify(bodies[0].messages)).not.toContain("[SMALL TALK]");
			}
		});
	}
});
