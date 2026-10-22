/**
 * `8gent -p` end to end against a fake model server: piped stdin reaches the
 * model, every JSON line validates against the exported event types, and
 * --continue resumes this folder's latest session. No real model is loaded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "../../tests/db-files";
import { removeDir } from "../../tests/temp-dirs";
import { validateRunEvent } from "./run-events";

type Body = { messages: Array<{ role: string; content: unknown }> };
const saved: Record<string, string | undefined> = {};
let home: string;
let work: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: Body[] = [];

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "headless-home-"));
	work = mkdtempSync(join(tmpdir(), "headless-work-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const env: Record<string, string> = {
		HOME: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TEXT_TOOLS: "1",
		EIGHT_DONE_GATE: "0",
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
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
					{
						index: 0,
						message: { role: "assistant", content: "DONE: reviewed." },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
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
	// The run keeps an in-process SQLite handle under home that Windows will not release until the
	// process ends; removeDir retries, then leaves it to the run-end sweep on win32 only.
	removeDir(home);
	removeDir(work);
});

async function headless(
	args: string[],
	piped = "",
): Promise<{ code: number; lines: Record<string, unknown>[] }> {
	const { runRunCommand } = await import("./run");
	const out: string[] = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((c: string | Uint8Array) => {
		out.push(String(c));
		return true;
	}) as typeof process.stdout.write;
	let code: number;
	try {
		code = await runRunCommand(
			[
				"-p",
				"--mode",
				"json",
				"--yes",
				"--provider",
				"ollama",
				"--model",
				"m",
				"--cwd",
				work,
				...args,
			],
			{ stdin: async () => piped },
		);
	} finally {
		process.stdout.write = realWrite;
	}
	const lines = out
		.join("")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	return { code, lines };
}

/** Sessions in the one tree store (sessions/tree/<id>.jsonl); the agent's own log lives one level up. */
const treeDir = () => join(home, ".8gent", "sessions", "tree");
const saved_ = () => {
	try {
		return readdirSync(treeDir()).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
};
const asText = (b: Body) => JSON.stringify(b.messages);

describe("8gent -p", () => {
	test("piped diff reaches the model; output validates; session is saved", async () => {
		bodies = [];
		const { code, lines } = await headless(["review"], "diff --git a/x b/x\n+SENTINEL_LINE\n");
		expect(code).toBe(0);
		expect(bodies.some((b) => asText(b).includes("SENTINEL_LINE"))).toBe(true);
		for (const l of lines) expect(validateRunEvent(l)).toEqual([]);
		expect(lines[0].type).toBe("session_start");
		expect(lines[0].resumed).toBe(false);
		expect(lines.at(-1)?.type).toBe("result");
		expect(saved_().length).toBe(1);
	}, 60_000);

	test("--continue resumes this folder's latest session", async () => {
		const before = saved_()[0].replace(/\.jsonl$/, "");
		bodies = [];
		const { code, lines } = await headless(["--continue", "and again"]);
		expect(code).toBe(0);
		expect(lines[0].session_id).toBe(before);
		expect(lines[0].resumed).toBe(true);
		expect(bodies.some((b) => asText(b).includes("SENTINEL_LINE"))).toBe(true);
		for (const l of lines) expect(validateRunEvent(l)).toEqual([]);
		expect(saved_().length).toBe(1);
	}, 60_000);

	test("--no-session saves nothing and --continue in a new folder starts fresh", async () => {
		const other = mkdtempSync(join(tmpdir(), "headless-other-"));
		try {
			const { code, lines } = await headless(["--no-session", "--cwd", other, "hello"]);
			expect(code).toBe(0);
			expect(lines[0].persisted).toBe(false);
			const fresh = await headless(["--continue", "--cwd", other, "hello"]);
			expect(fresh.lines[0].resumed).toBe(false);
		} finally {
			removeTree(other);
		}
	}, 60_000);

	test("a secret in piped input is not written to the saved session", async () => {
		const other = mkdtempSync(join(tmpdir(), "headless-secret-"));
		try {
			const secret = "AKIAIOSFODNN7EXAMPLE";
			const { code } = await headless(
				["--cwd", other, "summarise"],
				`# .env\nAWS_ACCESS_KEY_ID=${secret}\n`,
			);
			expect(code).toBe(0);
			const files = saved_().map((f) => readFileSync(join(treeDir(), f), "utf-8"));
			expect(files.some((t) => t.includes("AWS_ACCESS_KEY_ID"))).toBe(true);
			expect(files.some((t) => t.includes(secret))).toBe(false);
		} finally {
			removeTree(other);
		}
	}, 60_000);

	test("legacy run saves nothing unless --session or --continue is given", async () => {
		const other = mkdtempSync(join(tmpdir(), "headless-legacy-"));
		try {
			const n = saved_().length;
			const { runRunCommand } = await import("./run");
			const realWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (() => true) as typeof process.stdout.write;
			try {
				await runRunCommand([
					"--yes",
					"--provider",
					"ollama",
					"--model",
					"m",
					"--cwd",
					other,
					"hello",
				]);
			} finally {
				process.stdout.write = realWrite;
			}
			expect(saved_().length).toBe(n);
		} finally {
			removeTree(other);
		}
	}, 60_000);

	test("an unreachable model endpoint is result error and exit 1", async () => {
		const other = mkdtempSync(join(tmpdir(), "headless-down-"));
		const host = process.env.OLLAMA_HOST;
		process.env.OLLAMA_HOST = "http://127.0.0.1:9";
		try {
			const { code, lines } = await headless([
				"--no-session",
				"--cwd",
				other,
				"summarise this project",
			]);
			expect(code).toBe(1);
			const result = lines.at(-1);
			expect(result?.type).toBe("result");
			expect(result?.subtype).toBe("error");
			expect(String(result?.error)).toContain("not reachable");
			for (const l of lines) expect(validateRunEvent(l)).toEqual([]);
		} finally {
			process.env.OLLAMA_HOST = host;
			removeTree(other);
		}
	}, 60_000);
});
