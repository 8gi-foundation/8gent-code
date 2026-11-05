/**
 * #5100: a session's own key never goes to another provider's host.
 *
 * A minimax session handed an image its model cannot see falls back to the
 * VisionInterpreter, which calls openrouter.ai. The MiniMax session key must
 * not ride along; only an openrouter session's own key (or the OpenRouter env
 * key) may. Driven through Agent.chat() with a fetch spy; no real network.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetProviderManager } from "../providers";
import { resetKeyVault } from "../secrets/key-vault";

const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const MM_KEY = "mm-secret-5100";
const OR_KEY = "or-key-5100";
const OR_ENV_KEY = "or-env-5100";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string | undefined> = {
	OPENROUTER_API_KEY: OR_ENV_KEY,
	MINIMAX_API_KEY: undefined,
	// The host OS keychain can hold a real minimax key; read only the empty file vault.
	EIGHT_KEY_BACKEND: "file",
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "8000",
};
let dir: string;
let fetchSpy: { mockRestore: () => void } | undefined;
let Agent: typeof import("./agent").Agent;
const orAuth: Array<string | null> = [];

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "vision5100-"));
	for (const [k, v] of Object.entries({ ...ENV, EIGHT_DATA_DIR: dir })) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	// Other test files may have built these against another data dir or the real keychain.
	resetKeyVault();
	resetProviderManager();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "openrouter.ai") {
			const h = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined),
			);
			// Every request to openrouter.ai: the model list and the vision call both carry the key.
			orAuth.push(h.get("authorization"));
			if (url.pathname.endsWith("/models")) {
				return Response.json({
					data: [
						{
							id: "stub/vision-model:free",
							name: "stub vision",
							pricing: { prompt: "0", completion: "0" },
						},
					],
				});
			}
			return Response.json({
				id: "v1",
				model: "stub",
				choices: [
					{ index: 0, message: { role: "assistant", content: "a pixel" }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		throw new Error(`test blocks network to ${url.hostname}`);
	}) as typeof fetch);
	({ Agent } = await import("./agent"));
});

afterEach(() => {
	orAuth.length = 0;
});

afterAll(() => {
	fetchSpy?.mockRestore();
	resetKeyVault();
	resetProviderManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

async function imageTurn(runtime: string, apiKey: string): Promise<void> {
	const agent = new Agent({
		model: "text-only-model",
		runtime,
		apiKey,
		workingDirectory: dir,
		maxTurns: 1,
	});
	try {
		await agent.chat("what is in this image", PNG_B64, "image/png");
	} catch {
		// the main model call is blocked by the spy; only the vision request matters
	}
	// The vision call runs beside the turn; give it time to land.
	await new Promise((r) => setTimeout(r, 1500));
}

describe("vision path key isolation (#5100)", () => {
	test("a minimax session never sends its key to openrouter.ai", async () => {
		await imageTurn("minimax", MM_KEY);
		expect(orAuth.length).toBeGreaterThan(0);
		for (const a of orAuth) {
			expect(a ?? "").not.toContain(MM_KEY);
			expect(a).toBe(`Bearer ${OR_ENV_KEY}`);
		}
	}, 30000);

	test("an openrouter session's vision call still uses its own key", async () => {
		await imageTurn("openrouter", OR_KEY);
		expect(orAuth.length).toBeGreaterThan(0);
		for (const a of orAuth) expect(a).toBe(`Bearer ${OR_KEY}`);
	}, 30000);
});
