/**
 * Small-talk gate (#4756): a greeting alone gets no tools, and a home folder
 * that is not a repo is not described to the model as a project.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { isPlainHome, workingProjectNote } from "./prompts/system-prompt";
import { isGreeting, isSmallTalk } from "./small-talk";
import { buildWelcome, gatherWelcomeFacts, pathOutsideFolder, safeModelLabel } from "./welcome";

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
			"what good",
			"what's good",
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
			"was good",
			"what good is this function",
		])
			expect({ t, v: isSmallTalk(t) }).toEqual({ t, v: false });
	});
});

describe("greeting welcome (#4767)", () => {
	test("a hello is a greeting; a thank-you is small talk but not a greeting", () => {
		for (const t of ["what good", "hi", "yo", "what's up"])
			expect({ t, v: isGreeting(t) }).toEqual({ t, v: true });
		for (const t of ["thanks", "cheers", "hi, run the tests"])
			expect({ t, v: isGreeting(t) }).toEqual({ t, v: false });
	});

	test("an installed preset is offered, a missing one never is; facts come from PATH and .git only", async () => {
		const root = mkdtempSync(join(tmpdir(), "welcome-"));
		try {
			const bin = join(root, "bin");
			const repo = join(root, "proj");
			const plain = join(root, "notes");
			mkdirSync(bin);
			mkdirSync(join(repo, ".git"), { recursive: true });
			mkdirSync(plain);
			writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
			chmodSync(join(bin, "pi"), 0o755);
			const presets = [
				{ id: "claude", command: "claude" },
				{ id: "pi", command: "pi" },
				{ id: "8gent", command: "8gent" },
			];
			const facts = await gatherWelcomeFacts({
				model: "MiniMax-M3.1-Flash",
				provider: "openrouter",
				cwd: repo,
				env: { PATH: bin, TERMUX_VERSION: "0.118" },
				platform: "linux",
				arch: "arm64",
				presets,
			});
			expect(facts.installed).toEqual(["pi"]);
			const block = buildWelcome(facts);
			expect(block.split("\n")[0]).toBe(
				`Hi, I'm 8gent v${pkg.version} on Android (Termux, arm64), using MiniMax-M3.1-Flash via openrouter.`,
			);
			expect(block).toContain('"run pi"');
			expect(block).not.toContain("claude");
			expect(block).not.toContain("run 8gent");
			expect(block).toContain("(proj) is a git repo");
			expect(block.split("\n").length).toBeLessThanOrEqual(8);

			const bare = buildWelcome(
				await gatherWelcomeFacts({
					model: "m1",
					provider: "ollama",
					cwd: plain,
					env: { PATH: "" },
					platform: "darwin",
					arch: "arm64",
					presets,
				}),
			);
			expect(bare).toContain("macOS arm64");
			expect(bare).toContain("none installed");
			expect(bare).not.toContain('"run ');
			expect(bare).toContain("(notes) is not a git repo");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("welcome hardening (8SO)", () => {
	test("a binary planted inside the folder is never offered", async () => {
		const root = mkdtempSync(join(tmpdir(), "welcome-plant-"));
		try {
			const planted = join(root, "node_modules", ".bin");
			mkdirSync(planted, { recursive: true });
			writeFileSync(join(planted, "pi"), "#!/bin/sh\n");
			chmodSync(join(planted, "pi"), 0o755);
			const facts = await gatherWelcomeFacts({
				model: "m1",
				provider: "ollama",
				cwd: root,
				env: { PATH: [planted, "node_modules/.bin", "."].join(":") },
				platform: "darwin",
				arch: "arm64",
				presets: [{ id: "pi", command: "pi" }],
			});
			expect(facts.installed).toEqual([]);
			expect(pathOutsideFolder(`/usr/bin:.:bin:${planted}`, root)).toBe("/usr/bin");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("launched from home, ~/.npm-global/bin presets are installed; '.' is still dropped (#4783)", async () => {
		const home = mkdtempSync(join(tmpdir(), "welcome-home-"));
		try {
			const npmBin = join(home, ".npm-global", "bin");
			mkdirSync(npmBin, { recursive: true });
			writeFileSync(join(npmBin, "pi"), "#!/bin/sh\n");
			chmodSync(join(npmBin, "pi"), 0o755);
			writeFileSync(join(home, "claude"), "#!/bin/sh\n");
			chmodSync(join(home, "claude"), 0o755);
			const facts = await gatherWelcomeFacts({
				model: "m1",
				provider: "ollama",
				cwd: home,
				env: { PATH: [".", npmBin].join(":"), HOME: home },
				platform: "android",
				arch: "arm64",
				presets: [
					{ id: "pi", command: "pi" },
					{ id: "claude", command: "claude" },
				],
			});
			expect(facts.installed).toEqual(["pi"]);
			expect(pathOutsideFolder(`.:bin:${npmBin}`, home, home)).toBe(npmBin);
			expect(pathOutsideFolder(npmBin, join(home, "proj"), home)).toBe(npmBin);
			expect(pathOutsideFolder(npmBin, join(home, ".npm-global"), home)).toBe("");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a symlinked project folder cannot slip an in-folder PATH entry past the check (#4783)", () => {
		const base = mkdtempSync(join(tmpdir(), "welcome-link-"));
		try {
			const home = join(base, "home");
			const real = join(base, "real", "proj");
			mkdirSync(join(real, "bin"), { recursive: true });
			mkdirSync(home);
			const link = join(base, "link");
			symlinkSync(real, link);
			const planted = join(base, "planted");
			symlinkSync(join(real, "bin"), planted);
			// cwd is the link, the PATH entry names the real folder, and the reverse.
			expect(pathOutsideFolder(join(real, "bin"), link, home)).toBe("");
			expect(pathOutsideFolder(join(link, "bin"), real, home)).toBe("");
			// A PATH entry that is itself a symlink into the folder.
			expect(pathOutsideFolder(planted, real, home)).toBe("");
			// /tmp vs /private/tmp style: the same folder spelled through a resolved parent.
			expect(pathOutsideFolder(join(realpathSync(real), "bin"), real, home)).toBe("");
			// A folder that does not exist yet resolves through its existing parent.
			expect(pathOutsideFolder(join(real, "new", "bin"), join(link, "new"), home)).toBe("");
			// A home reached through a symlink still counts as home.
			const homeLink = join(base, "home-link");
			symlinkSync(home, homeLink);
			expect(pathOutsideFolder("/usr/bin", homeLink, home)).toBe("/usr/bin");
			expect(pathOutsideFolder(`.:${join(real, "bin")}`, join(home, "proj"), homeLink)).toBe(
				join(real, "bin"),
			);
			// Entries really outside the folder are kept.
			expect(pathOutsideFolder(`/usr/bin:${join(real, "bin")}`, link, home)).toBe("/usr/bin");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("a model value with a URL or credentials is not echoed; home shows as ~", async () => {
		expect(safeModelLabel("https://user:tok@host/v1")).toBe("a custom model");
		expect(safeModelLabel("key@model")).toBe("a custom model");
		expect(safeModelLabel("qwen3:14b")).toBe("qwen3:14b");
		const facts = await gatherWelcomeFacts({
			model: "m1",
			provider: "ollama",
			cwd: "/home/someone/",
			env: { PATH: "", HOME: "/home/someone" },
			platform: "linux",
			arch: "x64",
			presets: [],
		});
		expect(facts.folder).toBe("~");
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

	for (const t of ["what good", "hi", "yo"]) {
		test(`"${t}" is answered by the welcome block: no model call, no tools, version and model named`, async () => {
			process.env.EIGHT_TEXT_TOOLS = "1";
			bodies = [];
			const reply = await build().chat(t);
			expect(bodies).toEqual([]);
			expect(reply).toContain(`8gent v${pkg.version}`);
			expect(reply).toContain("using m via ollama");
			expect(reply).toContain("Try:");
		});
	}

	test('"hi, run the tests" is not a welcome: the model is called with tools', async () => {
		process.env.EIGHT_TEXT_TOOLS = "0";
		bodies = [];
		const reply = await build().chat("hi, run the tests");
		expect(reply).not.toContain("Try:");
		expect(bodies.length).toBeGreaterThan(0);
		expect(JSON.stringify(bodies[0])).toContain("shout");
	});

	for (const [label, textTools] of [
		["text-tool", "1"],
		["native-tool", "0"],
	] as const) {
		test(`${label} path: "what upp" offers no tools, "ok" and a task keep them`, async () => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			// The first hello is the welcome (#4767); a later one is the plain small-talk turn.
			const agent = build();
			await agent.chat("hi");
			bodies = [];
			await agent.chat("what upp");
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
