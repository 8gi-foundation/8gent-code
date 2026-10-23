/**
 * Questions about 8gent itself and chat in a plain home folder (#4791): decided
 * by pattern, answered with no tools. Detection first, then the wiring in
 * agent.ts on both shipping paths with a fake OpenAI-compatible endpoint.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HOME_CHAT_NOTE,
	isHarnessSource,
	isHomeChat,
	isSelfQuestion,
	loadSlashFacts,
	selfQuestionNote,
} from "./self-questions";

describe("isSelfQuestion", () => {
	test("the message from the phone, typos and all, is a self question", () => {
		expect(isSelfQuestion("why theslah at3vnkt working")).toBe(true);
		expect(isSelfQuestion("why the slash ain't working")).toBe(true);
		expect(isSelfQuestion("whys the slsh not working")).toBe(true);
	});

	test("questions about commands, modes, keys and 8gent are self questions", () => {
		for (const t of [
			"how do I turn on yolo mode?",
			"what slash commands are there",
			"where do I put my API keys?",
			"what are the hotkeys",
			"why the slash aint working",
			"what is 8gent",
			"is yolo off by default",
		])
			expect({ t, v: isSelfQuestion(t) }).toEqual({ t, v: true });
	});

	test("a real /command counts only when the registry knows it", () => {
		const names = new Set(["mode", "privacy"]);
		expect(isSelfQuestion("why does /mode do nothing", names)).toBe(true);
		expect(isSelfQuestion("what does /privacy show", names)).toBe(true);
		expect(isSelfQuestion("why does /usr do nothing", names)).toBe(false);
		expect(isSelfQuestion("why does /mode do nothing")).toBe(false);
	});

	test("work, weak terms alone, and unrelated talk are not self questions", () => {
		for (const t of [
			"",
			"fix the slash command parser",
			"add a yolo mode toggle",
			"implement api key rotation",
			"why is my python script failing",
			"what is the best mode for sleeping",
			"how do I make a key in a map",
			"run the tests for 8gent",
			"hello",
			"why is my API key not loading in this project",
			"can you add slash command support to my discord bot",
			"how do i add a slash route to my express app?",
			"the slashes in my paths are wrong on windows, can you look?",
			"how do I set my openai api key in .env for my app",
			"how do I set up a slash menu",
			"why does src/slash/index.ts crash on yolo",
			"how do I make yolo mode",
		])
			expect({ t, v: isSelfQuestion(t) }).toEqual({ t, v: false });
		expect(isSelfQuestion(`why is the slash ${"x ".repeat(120)}`)).toBe(false);
		// "agent" is one edit from "8gent" and must not pass for it.
		expect(isSelfQuestion("why is my agent not working")).toBe(false);
	});
});

describe("selfQuestionNote and the live registry", () => {
	test("the registry loads, and the note carries the real help and the named command", async () => {
		const facts = await loadSlashFacts();
		expect(facts).not.toBeNull();
		expect(facts?.names.has("mode")).toBe(true);
		expect(facts?.names.has("apikey")).toBe(true);
		const note = selfQuestionNote("what does /mode do", facts);
		expect(note).toContain("[8GENT QUESTION]");
		expect(note).toContain("No tools this turn");
		expect(note).toContain("Commands they named:");
		expect(note).toContain("/mode <plan|ask|guarded|infinite|yolo [off]>");
		expect(note).toContain("Core commands:");
		expect(note).toContain("node_modules");
	});

	test("with no registry the note still points at /help", () => {
		expect(selfQuestionNote("why the slash", null)).toContain("Type /help");
	});
});

describe("isHarnessSource", () => {
	test("is true only where packages/eight/agent.ts exists", () => {
		const root = mkdtempSync(join(tmpdir(), "selfq-src-"));
		try {
			expect(isHarnessSource(root)).toBe(false);
			mkdirSync(join(root, "packages", "eight"), { recursive: true });
			writeFileSync(join(root, "packages", "eight", "agent.ts"), "");
			expect(isHarnessSource(root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("isHomeChat", () => {
	test("short talk that names no task or file is chat", () => {
		for (const t of [
			"what is the capital of france",
			"tell me a joke",
			"how do I learn rust?",
			"I'm bored",
		])
			expect({ t, v: isHomeChat(t) }).toEqual({ t, v: true });
	});

	test("a task, a file or folder, or a path is not", () => {
		for (const t of [
			"",
			"what's in my downloads folder",
			"list the files",
			"check git status",
			"read ~/notes.txt",
			"open /etc/hosts",
			"run the tests",
			"what is in readme.md",
			"make me a todo app",
			"convert this video to mp4",
			"summarise my notes",
			"summarize this",
			"update my resume",
			"x ".repeat(100),
		])
			expect({ t, v: isHomeChat(t) }).toEqual({ t, v: false });
	});
});

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

describe("agent wiring: no tools for a self question or first-turn home chat", () => {
	let Agent: typeof import("./agent").Agent;
	const saved: Record<string, string | undefined> = {};
	let home = "";
	let project = "";
	let source = "";
	let server: ReturnType<typeof Bun.serve>;
	let bodies: Body[] = [];

	beforeAll(async () => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "selfq-home-")));
		project = realpathSync(mkdtempSync(join(tmpdir(), "selfq-proj-")));
		source = realpathSync(mkdtempSync(join(tmpdir(), "selfq-src-")));
		mkdirSync(join(source, "packages", "eight"), { recursive: true });
		writeFileSync(join(source, "packages", "eight", "agent.ts"), "");
		mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
		mkdirSync(join(home, ".8gent", "extensions"), { recursive: true });
		for (const [k, v] of Object.entries({
			HOME: home,
			EIGHT_HOME: home,
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
						{ index: 0, message: { role: "assistant", content: "Answer." }, finish_reason: "stop" },
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
		for (const d of [home, project, source]) rmSync(d, { recursive: true, force: true });
	});

	const build = (dir: string) =>
		new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: dir,
			baseUrl: `http://127.0.0.1:${server.port}`,
			attended: true,
		} as ConstructorParameters<typeof Agent>[0]);

	const noTools = (note: string) => {
		expect(bodies.length).toBeGreaterThan(0);
		for (const b of bodies) expect(b.tools ?? []).toEqual([]);
		expect(JSON.stringify(bodies[0].messages)).toContain(note);
	};
	const keepsTools = (note: string) => {
		expect(bodies.length).toBeGreaterThan(0);
		expect((bodies[0].tools ?? []).length).toBeGreaterThan(0);
		expect(JSON.stringify(bodies[0].messages)).not.toContain(note);
	};

	for (const [label, textTools] of [
		["text-tool", "1"],
		["native-tool", "0"],
	] as const) {
		describe(label, () => {
			test("the phone message in a plain home folder: no tools, the registry in the note", async () => {
				process.env.EIGHT_TEXT_TOOLS = textTools;
				bodies = [];
				await build(home).chat("why theslah at3vnkt working");
				noTools("[8GENT QUESTION]");
				const sent = JSON.stringify(bodies[0].messages);
				expect(sent).toContain("Core commands:");
				expect(sent).toContain("/help all");
			});

			test("a self question in a project folder is answered the same way", async () => {
				process.env.EIGHT_TEXT_TOOLS = textTools;
				bodies = [];
				await build(project).chat("how do I turn on yolo mode?");
				noTools("[8GENT QUESTION]");
			});

			test("in the 8gent source checkout, and as a task, the turn keeps its tools", async () => {
				process.env.EIGHT_TEXT_TOOLS = textTools;
				bodies = [];
				await build(source).chat("why the slash ain't working");
				keepsTools("[8GENT QUESTION]");
				bodies = [];
				await build(project).chat("fix the slash command parser in src/slash.ts");
				keepsTools("[8GENT QUESTION]");
			});

			test("first-turn chat in a plain home folder: no tools; the next turn and a task keep them", async () => {
				process.env.EIGHT_TEXT_TOOLS = textTools;
				bodies = [];
				const agent = build(home);
				await agent.chat("tell me a joke");
				noTools("[HOME FOLDER CHAT]");
				bodies = [];
				await agent.chat("tell me another joke");
				// The first turn's note stays in this agent's history; the tools are what changed.
				expect((bodies[0].tools ?? []).length).toBeGreaterThan(0);
				bodies = [];
				await build(home).chat("what's in my downloads folder");
				keepsTools("[HOME FOLDER CHAT]");
				bodies = [];
				await build(project).chat("tell me a joke");
				keepsTools("[HOME FOLDER CHAT]");
			});
		});
	}

	test("the home chat note asks what to work on and forbids the repo tour", () => {
		expect(HOME_CHAT_NOTE).toContain("ask what they want to work on");
		expect(HOME_CHAT_NOTE).toContain("do not look for repos, run git or tests");
	});
});
