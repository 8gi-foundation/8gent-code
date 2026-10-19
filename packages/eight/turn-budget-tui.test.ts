/**
 * #4431: the whole-turn budget notice (#4418/#4419) must also reach the TUI path. The TUI runs the
 * text-tool loop (Agent.runTextToolChat), not the native loop. This drives a real Agent turn against a
 * fake OpenAI-compatible endpoint: the model keeps calling a slow tool until it sees the notice, then
 * writes the output file. $HOME is faked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
	EIGHT_TURN_BUDGET_MS: "2000",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let bodies: string[] = [];
let modelDelayMs = 0;
let script: (call: number, body: string) => string = () => "ok";

const toolCall = (name: string, args: Record<string, unknown>) =>
	`\`\`\`tool_call\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "budget4431-home-"));
	repo = mkdtempSync(join(tmpdir(), "budget4431-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
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
			const body = JSON.stringify(await req.json());
			if (modelDelayMs > 0) await Bun.sleep(modelDelayMs);
			bodies.push(body);
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: script(bodies.length - 1, body) },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
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
	removeDir(home);
	removeDir(repo);
});

function build(maxTurns = 20): AgentT {
	return new Agent({
		model: "m",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		maxTurns,
	} as ConstructorParameters<typeof Agent>[0]);
}

const PROMPT = "Work out the answer and write it to answer.json in the working directory.";
const SLOW = toolCall("run_command", { command: "sleep 0.5" });

const noticeCount = () => bodies.filter((b) => b.includes("TIME BUDGET")).length;

describe("#4431 the TUI text-tool path gets the turn-budget notice", () => {
	test("a slow tool loop gets one notice and writes the output file before the budget ends", async () => {
		bodies = [];
		const out = join(repo, "answer.json");
		let wrote = false;
		script = (_n, body) => {
			if (wrote) return "DONE: wrote answer.json";
			if (body.includes("TIME BUDGET")) {
				wrote = true;
				return toolCall("write_file", { path: out, content: "[[1]]" });
			}
			return SLOW;
		};
		const t0 = Date.now();
		await build().chat(PROMPT);
		const elapsed = Date.now() - t0;
		expect(existsSync(out)).toBe(true);
		expect(readFileSync(out, "utf8")).toBe("[[1]]");
		expect(elapsed).toBeLessThan(2000); // written inside the 2000 ms budget
		// Once: the notice rides the history, so count the first request that carries it.
		const first = bodies.findIndex((b) => b.includes("TIME BUDGET"));
		expect(first).toBeGreaterThan(1);
		expect(bodies.slice(0, first).some((b) => b.includes("TIME BUDGET"))).toBe(false);
		expect((bodies[first].match(/\[SYSTEM NOTICE - TIME BUDGET\]/g) ?? []).length).toBe(1);
	}, 30_000);

	test("EIGHT_TURN_BUDGET_MS=0 sends no notice", async () => {
		bodies = [];
		process.env.EIGHT_TURN_BUDGET_MS = "0";
		try {
			let n = 0;
			script = () => (n++ < 4 ? SLOW : "DONE: nothing to write");
			await build().chat(PROMPT);
		} finally {
			process.env.EIGHT_TURN_BUDGET_MS = ENV.EIGHT_TURN_BUDGET_MS;
		}
		expect(bodies.length).toBeGreaterThanOrEqual(4);
		expect(noticeCount()).toBe(0);
	}, 30_000);

	// Live pilot 2026-10-19 (sigi-dev-arc1-b): model steps of 190-410 s under a 1500 s budget. The
	// notice fired at a boundary past 95%, with no step left to answer it. Same shape, scaled down:
	// 800 ms model steps under a 3000 ms budget. The write must land inside the budget.
	test("slow model steps: the notice fires early enough for a step to answer it", async () => {
		bodies = [];
		modelDelayMs = 800;
		process.env.EIGHT_TURN_BUDGET_MS = "3000";
		const out = join(repo, "answer-slow.json");
		let wrote = false;
		script = (_n, body) => {
			if (wrote) return "DONE: wrote answer-slow.json";
			if (body.includes("TIME BUDGET")) {
				wrote = true;
				return toolCall("write_file", { path: out, content: "[[2]]" });
			}
			return toolCall("run_command", { command: "true" });
		};
		const t0 = Date.now();
		let writtenAt = Number.POSITIVE_INFINITY;
		const poll = setInterval(() => {
			if (existsSync(out) && writtenAt === Number.POSITIVE_INFINITY) writtenAt = Date.now();
		}, 20);
		try {
			await build().chat(PROMPT);
		} finally {
			clearInterval(poll);
			modelDelayMs = 0;
			process.env.EIGHT_TURN_BUDGET_MS = ENV.EIGHT_TURN_BUDGET_MS;
		}
		expect(existsSync(out)).toBe(true);
		// the write must land inside the 3000 ms budget, not merely before the turn ends
		expect(writtenAt - t0).toBeLessThan(3000);
		expect(bodies.findIndex((b) => b.includes("TIME BUDGET"))).toBeGreaterThan(0);
	}, 30_000);
});
