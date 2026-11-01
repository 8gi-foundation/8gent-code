/**
 * The tool-end event carries the whole result (capped) beside the 200 character preview (#4954),
 * so the TUI can show why a call failed. Drives chat() on the text-tool path against a fake
 * OpenAI-compatible endpoint; $HOME is faked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;

const COMMAND = "sh fail.sh";

function completion(message: Record<string, unknown>, finish: string) {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model: "m",
		choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "toolout-home-"));
	repo = mkdtempSync(join(tmpdir(), "toolout-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(
		join(repo, "fail.sh"),
		"seq 1 60 | sed s/^/out-line-/\necho boom-on-stderr 1>&2\nexit 3\n",
	);
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	(await import("../hooks")).resetHookManager();
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			calls++;
			if (calls === 1) {
				const block = [
					"```tool_call",
					JSON.stringify({ name: "run_command", arguments: { command: COMMAND } }),
					"```",
				];
				return completion({ content: block.join("\n") }, "stop");
			}
			return completion({ content: "DONE." }, "stop");
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	server?.stop(true);
	(await import("../hooks")).resetHookManager();
	(await import("../memory/index")).resetMemoryManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	rmRetry(home);
	rmRetry(repo);
});

describe("tool-end event carries the whole result", () => {
	test("a failing command: exit code, every line, the stderr tail; the preview stays 200 chars", async () => {
		const ends: Array<{
			toolName: string;
			success: boolean;
			resultPreview?: string;
			resultFull?: string;
		}> = [];
		const agent = new Agent({
			model: "m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${server.port}`,
			events: { onToolEnd: (e: (typeof ends)[number]) => ends.push(e) },
		} as ConstructorParameters<typeof Agent>[0]);
		await agent.chat("Run the loop command and report.");
		const run = ends.find((e) => e.toolName === "run_command");
		expect(run).toBeDefined();
		expect(run?.resultFull).toBeDefined();
		expect(run?.resultFull?.startsWith("Exit code 3")).toBe(true);
		expect(run?.resultFull).toContain("out-line-1\n");
		expect(run?.resultFull).toContain("out-line-60");
		// stderr comes after stdout, so the tail of the output holds the cause (a harness note may follow it).
		const full = run?.resultFull ?? "";
		expect(full.indexOf("boom-on-stderr")).toBeGreaterThan(full.indexOf("out-line-60"));
		expect((run?.resultPreview ?? "").length).toBeLessThanOrEqual(200);
		expect((run?.resultFull ?? "").length).toBeGreaterThan(200);
	});
});
