/**
 * #4362 on the path that ships. `8gent run` with NO --provider and a saved
 * choice in providers.json sends its request to the saved provider's endpoint
 * with the saved model, not to Ollama. The saved provider is a declared one
 * whose endpoint is a local one-shot server (as in #4283). The CLI test runs
 * `8gent chat` as a real process with an unreachable saved LM Studio and
 * checks the stated reason on stderr.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { resetProviderManager } from "../providers";

const BIN = join(import.meta.dir, "..", "..", "bin", "8gent.ts");
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
const seen: Array<{ path: string; model?: string }> = [];

function writeSettings(body: unknown): string {
	const file = join(home, ".8gent", "providers.json");
	writeFileSync(file, JSON.stringify(body));
	return file;
}

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "choice4362-home-"));
	repo = mkdtempSync(join(tmpdir(), "choice4362-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ object: "list", data: [] });
			const body = (await req.json()) as { model?: string };
			seen.push({ path: new URL(req.url).pathname, model: body.model });
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model ?? "m",
				choices: [
					{ index: 0, message: { role: "assistant", content: "Four." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	const settings = writeSettings({
		activeProvider: "savedtest",
		activeModel: "saved-model-x",
		providers: {
			savedtest: {
				displayName: "Saved test endpoint",
				compat: "openai",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				apiKeyEnv: "",
				defaultModel: "other-model",
				models: ["saved-model-x"],
				supportsTools: true,
				supportsStreaming: true,
			},
		},
	});
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

describe("saved provider choice (#4362)", () => {
	test("run with no --provider sends its request to the saved provider and model", async () => {
		const { runRunCommand } = await import("./run");
		seen.length = 0;
		const code = await runRunCommand([
			"--yes",
			"--no-session",
			"--cwd",
			repo,
			"What is two plus two?",
		]);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((s) => s.path === "/v1/chat/completions")).toBe(true);
		expect(seen.every((s) => s.model === "saved-model-x")).toBe(true);
		expect(code).toBe(0);
	}, 60_000);

	test("chat names an unreachable saved LM Studio on stderr before falling back", async () => {
		writeSettings({ activeProvider: "lmstudio", activeModel: "gemma-4-26b-a4b-it" });
		// Stop the process once the notice lands: what answers after the
		// fallback depends on the machine and is not under test.
		const proc = Bun.spawn(["bun", BIN, "chat", "What is two plus two"], {
			env: {
				...process.env,
				LMSTUDIO_BASE_URL: "http://127.0.0.1:1/v1",
				EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		let err = "";
		const reader = proc.stderr.getReader();
		const dec = new TextDecoder();
		while (!err.includes("not reachable, using ")) {
			const { value, done } = await reader.read();
			if (done) break;
			err += dec.decode(value);
		}
		proc.kill();
		expect(err).toContain("LM Studio not reachable, using ");
	}, 60_000);
});
