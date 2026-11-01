/**
 * #4283: `8gent run --provider <name>` for a provider declared only in
 * providers.json sends its requests to that provider's own baseUrl. Before the
 * fix the run built its session with no baseUrl, the native path had no base
 * for a name it did not compile in, and the run failed "Invalid URL" without
 * a single request. The declared endpoint here is a one-shot local server.
 * $HOME and the providers settings are faked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { resetProviderManager } from "../providers";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "declared4283-home-"));
	repo = mkdtempSync(join(tmpdir(), "declared4283-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ object: "list", data: [] });
			seen.push(new URL(req.url).pathname);
			const body = (await req.json()) as { model?: string };
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model ?? "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	const settings = join(home, ".8gent", "providers.json");
	writeFileSync(
		settings,
		JSON.stringify({
			activeProvider: "declaredtest",
			providers: {
				declaredtest: {
					displayName: "Declared test endpoint",
					compat: "openai",
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					apiKeyEnv: "",
					defaultModel: "m",
					models: ["m"],
					supportsTools: true,
					supportsStreaming: true,
				},
			},
		}),
	);
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	ENV.EIGHT_PROVIDERS_SETTINGS_PATH = settings;
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	resetProviderManager();
});

afterAll(() => {
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetProviderManager();
	rmRetry(home);
	rmRetry(repo);
});

describe("headless run with a declared provider (#4283)", () => {
	test("the request lands on the declared baseUrl and the run succeeds", async () => {
		const { runRunCommand } = await import("./run");
		const code = await runRunCommand([
			"--yes",
			"--no-session",
			"--provider",
			"declaredtest",
			"--model",
			"m",
			"--cwd",
			repo,
			"Say hello.",
		]);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((p) => p === "/v1/chat/completions")).toBe(true);
		expect(code).toBe(0);
	}, 60_000);
});
