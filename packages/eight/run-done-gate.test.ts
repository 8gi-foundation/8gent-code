/**
 * Headless `8gent run` must not report success when the run left the project's own
 * build or tests worse than it found them (done gate). Drives runRunCommand end to end
 * against a fake OpenAI-compatible endpoint standing in for ollama; $HOME is faked.
 *
 * Practice exercise behind it: a tiny crate whose model-written src/lib.rs does not
 * compile. Before the gate, the run emitted `result/ok` and exited 0 while `cargo test`
 * failed with error[E0308]. The bun variant runs everywhere; the cargo variant runs
 * where cargo is installed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const GATE_NEEDLE = "[DONE GATE]";

type Event = {
	type?: string;
	subtype?: string;
	final_text?: string;
	project_check?: { status?: string; notice?: string | null };
};
type Body = { messages: Array<{ role: string; content: unknown }> };
type Lang = {
	name: string;
	available: boolean;
	/** Lays out the project; `start` is the source file's content before the run. */
	setup: (dir: string, start: string) => void;
	file: string;
	/** Source that passes the tests. */
	green: string;
	/** Source whose tests fail but which builds: the "already red" starting point. */
	red: string;
	/** Source the model writes that makes things worse. */
	broken: string;
};

const LANGS: Lang[] = [
	{
		name: "bun",
		available: true,
		setup: (dir, start) => {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "ex", scripts: { test: "bun test" } }),
			);
			writeFileSync(join(dir, "bun.lock"), "");
			writeFileSync(
				join(dir, "add.test.ts"),
				'import { expect, test } from "bun:test";\nimport { add } from "./add";\ntest("add", () => expect(add(2, 3)).toBe(5));\ntest("add zero", () => expect(add(0, 0)).toBe(0));\n',
			);
			writeFileSync(join(dir, "add.ts"), start);
		},
		file: "add.ts",
		green: "export const add = (a: number, b: number) => a + b;\n",
		// add(0, 0) passes, add(2, 3) fails.
		red: "export const add = (a: number, b: number) => a * b;\n",
		// Both tests fail: "add zero" is a new failure.
		broken: "export const add = (a: number, b: number) => a + b + 1;\n",
	},
	{
		name: "cargo",
		available: Bun.which("cargo") !== null,
		setup: (dir, start) => {
			writeFileSync(
				join(dir, "Cargo.toml"),
				'[package]\nname = "ex"\nversion = "0.1.0"\nedition = "2021"\n',
			);
			mkdirSync(join(dir, "src"));
			mkdirSync(join(dir, "tests"));
			writeFileSync(join(dir, "src", "lib.rs"), start);
			writeFileSync(
				join(dir, "tests", "add.rs"),
				"#[test]\nfn adds() { assert_eq!(ex::add(2, 3), 5); }\n",
			);
		},
		file: "src/lib.rs",
		green: "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
		// The exercise stub: builds, test panics.
		red: "pub fn add(_a: i32, _b: i32) -> i32 { todo!() }\n",
		// A compile error: i32 returned as a String.
		broken: "pub fn add(a: i32, b: i32) -> String { a + b }\n",
	},
];

type Plan = "break" | "break-then-fix" | "docs";

const saved: Record<string, string | undefined> = {};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let lang: Lang = LANGS[0];
let plan: Plan = "break";
let wrote = { first: false, fixed: false };

const reply = (content: string) =>
	Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});

const writeCall = (file: string, content: string) =>
	[
		"```tool_call",
		JSON.stringify({ name: "write_file", arguments: { path: join(repo, file), content } }),
		"```",
	].join("\n");

const sawGate = (b: Body) =>
	b.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(GATE_NEEDLE));

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "donegate-home-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const env: Record<string, string> = {
		// cargo and rustup find their toolchain under the real home.
		CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
		RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
		HOME: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TEXT_TOOLS: "1",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as Body;
			bodies.push(body);
			if (plan === "break-then-fix" && sawGate(body) && !wrote.fixed) {
				wrote.fixed = true;
				return reply(writeCall(lang.file, lang.green));
			}
			if (!wrote.first) {
				wrote.first = true;
				return reply(
					plan === "docs"
						? writeCall("README.md", "# ex\n\nAdds two numbers.\n")
						: writeCall(lang.file, lang.broken),
				);
			}
			return reply("DONE: done.");
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
	Reflect.deleteProperty(process.env, "EIGHT_DONE_GATE");
	rmSync(repo, { recursive: true, force: true });
});

/** Run `8gent run --yes` headless and collect its output and exit code. */
async function headless(
	start: string,
	format: "stream-json" | "text" = "stream-json",
	yes = true,
): Promise<{ code: number; events: Event[]; stdout: string }> {
	repo = mkdtempSync(join(tmpdir(), `donegate-${lang.name}-`));
	lang.setup(repo, start);
	bodies = [];
	wrote = { first: false, fixed: false };
	const { runRunCommand } = await import("./run");
	const out: string[] = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	let code: number;
	try {
		code = await runRunCommand([
			...(yes ? ["--yes"] : []),
			"--provider",
			"ollama",
			"--model",
			"m",
			"--cwd",
			repo,
			"--max-turns",
			"4",
			"--output-format",
			format,
			"Implement add in this project so its tests pass.",
		]);
	} finally {
		process.stdout.write = realWrite;
	}
	const stdout = out.join("");
	const events = stdout
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l) as Event);
	return { code, events, stdout };
}

const resultOf = (events: Event[]) => events.find((e) => e.type === "result");

for (const l of LANGS) {
	describe.skipIf(!l.available)(`done gate, ${l.name} project`, () => {
		beforeAll(() => {
			lang = l;
		});

		test("run breaks a green project and stops: fails loud, failure was fed back", async () => {
			plan = "break";
			const { code, events } = await headless(l.green);
			const result = resultOf(events);
			expect(result?.subtype).toBe("error");
			expect(result?.project_check?.status).toBe("fail");
			expect(result?.final_text).toContain("[DONE GATE] FAILED");
			expect(code).not.toBe(0);
			expect(bodies.some(sawGate)).toBe(true);
		}, 180_000);

		test("run adds new failures to an already red project: still caught", async () => {
			plan = "break";
			const { code, events } = await headless(l.red);
			expect(resultOf(events)?.project_check?.status).toBe("fail");
			expect(code).not.toBe(0);
			expect(bodies.some(sawGate)).toBe(true);
		}, 180_000);

		test("model fixes after the failure is fed back: run succeeds", async () => {
			plan = "break-then-fix";
			const { code, events } = await headless(l.green);
			const result = resultOf(events);
			expect(wrote.fixed).toBe(true);
			expect(result?.subtype).toBe("ok");
			expect(result?.project_check?.status).toBe("pass");
			expect(code).toBe(0);
		}, 180_000);

		test("docs-only edit in an already red project: exit 0, pre-existing, not sent back", async () => {
			plan = "docs";
			const { code, events } = await headless(l.red);
			const result = resultOf(events);
			expect(result?.subtype).toBe("ok");
			expect(result?.project_check?.status).toBe("pre-existing");
			expect(result?.final_text).toContain("pre-existing failures, not caused by this run");
			expect(code).toBe(0);
			expect(bodies.some(sawGate)).toBe(false);
		}, 180_000);

		test("plain-text mode shows the verdict in the final message", async () => {
			plan = "break";
			const { code, stdout } = await headless(l.green, "text");
			expect(stdout).toContain("[DONE GATE] FAILED");
			expect(code).not.toBe(0);
		}, 180_000);

		test("EIGHT_DONE_GATE=0 restores the old unchecked behaviour", async () => {
			process.env.EIGHT_DONE_GATE = "0";
			plan = "break";
			const { code, events } = await headless(l.green);
			expect(resultOf(events)?.subtype).toBe("ok");
			expect(code).toBe(0);
			expect(bodies.some(sawGate)).toBe(false);
		}, 180_000);
	});
}

describe("done gate, unrecognised test runner", () => {
	test("red before and after with free-text output: NOT VERIFIED, exit 0, not sent back", async () => {
		lang = {
			name: "freetext",
			available: true,
			setup: (dir, start) => {
				writeFileSync(
					join(dir, "package.json"),
					JSON.stringify({
						name: "ex",
						scripts: { test: "echo 'Some specs did not pass, see report' && exit 1" },
					}),
				);
				writeFileSync(join(dir, "index.js"), start);
			},
			file: "index.js",
			green: "",
			red: "module.exports = 1;\n",
			broken: "module.exports = 2;\n",
		};
		plan = "break";
		const { code, events } = await headless(lang.red);
		const result = resultOf(events);
		expect(result?.subtype).toBe("ok");
		expect(result?.project_check?.status).toBe("unverified");
		expect(result?.project_check?.notice).toContain("NOT VERIFIED");
		expect(result?.final_text).toContain("could not tell whether this run added failures");
		expect(result?.final_text).not.toContain("pre-existing");
		expect(code).toBe(0);
		expect(bodies.some(sawGate)).toBe(false);
	}, 180_000);
});

describe("done gate, hardening", () => {
	const envOut = () => join(home, `env-${Date.now()}-${Math.random()}.txt`);
	const envLang = (out: string): Lang => ({
		name: "envdump",
		available: true,
		setup: (dir, start) => {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "ex", scripts: { test: `env > '${out}'` } }),
			);
			writeFileSync(join(dir, "index.js"), start);
		},
		file: "index.js",
		green: "module.exports = 1;\n",
		red: "",
		broken: "module.exports = 2;\n",
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, "FAKE_SVC_TOKEN");
	});

	test("a secret in the parent environment is not visible to the check command", async () => {
		process.env.FAKE_SVC_TOKEN = "do-not-leak-3693";
		const out = envOut();
		lang = envLang(out);
		plan = "break";
		const { events } = await headless(lang.green);
		expect(resultOf(events)?.project_check?.status).toBe("pass");
		const dumped = await Bun.file(out).text();
		expect(dumped).toContain("PATH=");
		expect(dumped).not.toContain("do-not-leak-3693");
	}, 180_000);

	test("without --yes the gate does not run and says so", async () => {
		const out = envOut();
		lang = envLang(out);
		plan = "break";
		const { code, events } = await headless(lang.green, "stream-json", false);
		const result = resultOf(events);
		expect(result?.project_check?.status).toBe("skipped");
		expect(result?.project_check?.notice).toContain("done gate skipped (needs --yes)");
		expect(result?.final_text).toContain("done gate skipped (needs --yes)");
		expect(code).toBe(0);
		expect(await Bun.file(out).exists()).toBe(false);
	}, 180_000);
});
