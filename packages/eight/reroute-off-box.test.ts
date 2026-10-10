/**
 * #3487: the system prompt is judged on-box once, for the session's runtime.
 * A turn can then be rerouted to another local provider (a "model not found"
 * reroute), whose endpoint can be on another host. Such a request must not
 * carry the board briefing or the operator's user-global instruction files;
 * a reroute that stays on this machine keeps them.
 *
 * Mirrors the 8SO repro: llama-server on 127.0.0.1 answers 404 model not
 * found, the turn reroutes to ollama, and the ollama endpoint captures the
 * request body. "localhost." (trailing dot) reaches this machine but is not a
 * loopback name to runsOnBox, so it stands in for another host. The installed
 * model list is fixed with a module mock so the reroute target does not depend
 * on what this machine runs; the real module is put back afterwards.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

const BOARD = "SENTINEL_3487_reroute_board";
const STANDING = "SENTINEL_3487_reroute_user_global";
const ENV_KEYS = [
	"HOME",
	"OLLAMA_BASE_URL",
	"OLLAMA_HOST",
	"LLAMA_SERVER_URL",
	"EIGHT_TEXT_TOOLS",
	"EIGHT_TOOL_CAPABILITY_GATE",
	"8GENT_TWO_STAGE_COMPACT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const DETECT_PATH = "../orchestration/local-model-detect";
let realDetect: Record<string, unknown>;
let Agent: typeof import("./agent").Agent;
let boardPath: string;
let home: string;
let repo: string;
let llama: ReturnType<typeof Bun.serve>;
let ollama: ReturnType<typeof Bun.serve>;
const ollamaBodies: string[] = [];
const llamaBodies: string[] = [];

beforeAll(async () => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	home = mkdtempSync(join(tmpdir(), "reroute3487-home-"));
	repo = mkdtempSync(join(tmpdir(), "reroute3487-repo-"));
	process.env.HOME = home;
	process.env.EIGHT_TEXT_TOOLS = "1";
	process.env.EIGHT_TOOL_CAPABILITY_GATE = "0";
	process.env["8GENT_TWO_STAGE_COMPACT"] = "0";
	delete process.env.OLLAMA_BASE_URL;

	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", "CLAUDE.md"), `- ${STANDING}\n`);
	writeFileSync(
		join(home, ".8gent", "user.json"),
		JSON.stringify({ identity: { name: "Pilot", language: "en", communicationStyle: "concise" }, onboardingComplete: true }),
	);

	llama = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.method === "POST") llamaBodies.push(await req.text());
			return Response.json({ error: { message: "model 'm' not found" } }, { status: 404 });
		},
	});
	ollama = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const u = new URL(req.url);
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			ollamaBodies.push(await req.text());
			if (u.pathname.endsWith("/chat/completions")) {
				return Response.json({
					id: "c1",
					object: "chat.completion",
					created: 0,
					model: "qwen3:14b",
					choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			}
			return Response.json({}, { status: 404 });
		},
	});
	process.env.LLAMA_SERVER_URL = `http://127.0.0.1:${llama.port}`;

	realDetect = { ...(await import(DETECT_PATH)) };
	mock.module(DETECT_PATH, () => ({
		...realDetect,
		detectLocalModels: async () => [{ provider: "ollama", model: "qwen3:14b", score: 10, toolCapable: true }],
	}));

	({ Agent } = await import("./agent"));
	({ BOARD_CONTEXT_PATH: boardPath } = await import("./prompts/system-prompt"));
	// Refuse to write anywhere but the run's temp home (test preload, #3240).
	const runHome = process.env.EIGHT_HOME ?? "";
	if (!(runHome.startsWith(tmpdir()) || runHome.startsWith(realpathSync(tmpdir())))) throw new Error("EIGHT_HOME is not a temp dir");
	if (!boardPath.startsWith(`${runHome}${sep}`)) throw new Error("board path is not under the run's temp home");
	mkdirSync(dirname(boardPath), { recursive: true });
	writeFileSync(boardPath, `${BOARD}\n`);
});

afterAll(() => {
	mock.module(DETECT_PATH, () => realDetect);
	llama?.stop(true);
	ollama?.stop(true);
	rmSync(boardPath, { force: true });
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

async function rerouteTurn(ollamaHost: string) {
	process.env.OLLAMA_HOST = ollamaHost;
	llamaBodies.length = 0;
	ollamaBodies.length = 0;
	const agent = new Agent({
		model: "m",
		runtime: "llama-server",
		workingDirectory: repo,
	} as ConstructorParameters<typeof Agent>[0]);
	const reply = await agent.chat("Say hi to the team in one short line, nothing else, no tools needed.");
	return { reply: String(reply) };
}

describe("a turn rerouted to another local provider", () => {
	test("off-box ollama: neither the board briefing nor user-global files are sent", async () => {
		await rerouteTurn(`localhost.:${ollama.port}`);
		// The first attempt went to the on-box llama-server with the full prompt.
		expect(llamaBodies.length).toBeGreaterThan(0);
		expect(llamaBodies[0]).toContain(BOARD);
		expect(llamaBodies[0]).toContain(STANDING);
		// The rerouted request reached the off-box ollama endpoint without them.
		expect(ollamaBodies.length).toBeGreaterThan(0);
		for (const body of ollamaBodies) {
			expect(body).not.toContain(BOARD);
			expect(body).not.toContain("## BOARD CONTEXT");
			expect(body).not.toContain(STANDING);
			// The rest of the user context still goes.
			expect(body).toContain("Communication style: **concise**.");
		}
	}, 60_000);

	test("on-box ollama (loopback): the reroute keeps them", async () => {
		await rerouteTurn(`127.0.0.1:${ollama.port}`);
		expect(ollamaBodies.length).toBeGreaterThan(0);
		for (const body of ollamaBodies) {
			expect(body).toContain(BOARD);
			expect(body).toContain(STANDING);
		}
	}, 60_000);
});
