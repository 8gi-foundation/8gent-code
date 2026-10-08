/**
 * Headless `8gent run` must not report success while the project's own build or
 * test fails (done gate). Drives runRunCommand end to end against a fake
 * OpenAI-compatible endpoint standing in for ollama; $HOME is faked.
 *
 * Practice exercise behind it: a tiny crate whose model-written src/lib.rs does
 * not compile. Before the gate, the run emitted `result/ok` and exited 0 while
 * `cargo test` failed with error[E0308]. The bun variant runs everywhere; the
 * cargo variant runs where cargo is installed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const GATE_NEEDLE = "[DONE GATE]";

type Event = {
	type?: string;
	subtype?: string;
	project_check?: { status?: string };
};
type Body = { messages: Array<{ role: string; content: unknown }> };
type Lang = {
	name: string;
	available: boolean;
	setup: (dir: string) => void;
	file: string;
	broken: string;
	fixed: string;
};

const LANGS: Lang[] = [
	{
		name: "bun",
		available: true,
		setup: (dir) => {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "ex", scripts: { test: "bun test" } }),
			);
			writeFileSync(join(dir, "bun.lock"), "");
			writeFileSync(
				join(dir, "add.test.ts"),
				'import { expect, test } from "bun:test";\nimport { add } from "./add";\ntest("add", () => expect(add(2, 3)).toBe(5));\n',
			);
			writeFileSync(join(dir, "add.ts"), "export const add = (a: number, b: number) => 0;\n");
		},
		file: "add.ts",
		broken: "export const add = (a: number, b: number) => a - b;\n",
		fixed: "export const add = (a: number, b: number) => a + b;\n",
	},
	{
		name: "cargo",
		available: Bun.which("cargo") !== null,
		setup: (dir) => {
			writeFileSync(
				join(dir, "Cargo.toml"),
				'[package]\nname = "ex"\nversion = "0.1.0"\nedition = "2021"\n',
			);
			mkdirSync(join(dir, "src"));
			mkdirSync(join(dir, "tests"));
			writeFileSync(join(dir, "src", "lib.rs"), "pub fn add(a: i32, b: i32) -> i32 { todo!() }\n");
			writeFileSync(
				join(dir, "tests", "add.rs"),
				"#[test]\nfn adds() { assert_eq!(ex::add(2, 3), 5); }\n",
			);
		},
		file: "src/lib.rs",
		// A compile error: i32 returned as a String.
		broken: "pub fn add(a: i32, b: i32) -> String { a + b }\n",
		fixed: "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
	},
];

const saved: Record<string, string | undefined> = {};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];
let lang: Lang = LANGS[0];
let modelFixes = false;
let wrote = { broken: false, fixed: false };

const reply = (content: string) =>
	Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});

const writeCall = (content: string) =>
	[
		"```tool_call",
		JSON.stringify({ name: "write_file", arguments: { path: join(repo, lang.file), content } }),
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
			if (modelFixes && sawGate(body) && !wrote.fixed) {
				wrote.fixed = true;
				return reply(writeCall(lang.fixed));
			}
			if (!wrote.broken) {
				wrote.broken = true;
				return reply(writeCall(lang.broken));
			}
			return reply("DONE: implemented add.");
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

/** Run `8gent run --yes` headless and collect its NDJSON events and exit code. */
async function headless(): Promise<{ code: number; events: Event[] }> {
	repo = mkdtempSync(join(tmpdir(), `donegate-${lang.name}-`));
	lang.setup(repo);
	bodies = [];
	wrote = { broken: false, fixed: false };
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
			"--yes",
			"--provider",
			"ollama",
			"--model",
			"m",
			"--cwd",
			repo,
			"--max-turns",
			"4",
			"--output-format",
			"stream-json",
			"Implement add in this project so its tests pass.",
		]);
	} finally {
		process.stdout.write = realWrite;
	}
	const events = out
		.join("")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l) as Event);
	return { code, events };
}

const resultOf = (events: Event[]) => events.find((e) => e.type === "result");

for (const l of LANGS) {
	describe.skipIf(!l.available)(`done gate, ${l.name} project`, () => {
		beforeAll(() => {
			lang = l;
		});

		test("model stops on a red build: run fails loud, not result/ok", async () => {
			modelFixes = false;
			const { code, events } = await headless();
			const result = resultOf(events);
			expect(result?.subtype).toBe("error");
			expect(result?.project_check?.status).toBe("fail");
			expect(code).not.toBe(0);
			// The failure went back to the model before giving up.
			expect(bodies.some(sawGate)).toBe(true);
		}, 180_000);

		test("model fixes after the failure is fed back: run succeeds", async () => {
			modelFixes = true;
			const { code, events } = await headless();
			const result = resultOf(events);
			expect(wrote.fixed).toBe(true);
			expect(result?.subtype).toBe("ok");
			expect(result?.project_check?.status).toBe("pass");
			expect(code).toBe(0);
		}, 180_000);

		test("EIGHT_DONE_GATE=0 restores the old unchecked behaviour", async () => {
			process.env.EIGHT_DONE_GATE = "0";
			modelFixes = false;
			const { code, events } = await headless();
			expect(resultOf(events)?.subtype).toBe("ok");
			expect(code).toBe(0);
			expect(bodies.some(sawGate)).toBe(false);
		}, 180_000);
	});
}
