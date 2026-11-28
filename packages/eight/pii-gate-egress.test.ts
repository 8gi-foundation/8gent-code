/**
 * One gated exit (#276): every request a turn sends to a hosted endpoint passes
 * the PII gate, whichever tool path the turn takes.
 *
 * #275 gated the AI-SDK path. A read of it showed the text-tool path open: an
 * Agent on openrouter with a hosted baseUrl and EIGHT_TEXT_TOOLS=1 sent a raw
 * email to openrouter.ai, and every scoped agent takes that path.
 *
 * This drives the real Agent.chat() loop three ways (native tools, text tools,
 * a scoped agent) with globalThis.fetch intercepted. Every request to a host
 * that is not loopback is recorded and answered by a fake model on 127.0.0.1;
 * any other host is refused. A turn plants a name, email and phone in the user
 * message, the system prompt and a tool result. No hosted request may carry
 * one raw. A new call path that reaches the cloud without the gate fails here.
 *
 * The last test is the ratchet for paths a turn does not reach: a source file
 * that calls a model API directly must be in KNOWN_DIRECT_MODEL_CALLS (each one
 * is listed on #276). A new one fails until it goes through modelFetch.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;

const RAW = [
	"sarah.connor@example.com",
	"555-0182",
	"Sarah Connor",
	"dana.scully@fbi.example",
	"Dana Scully",
	"bob.marley@contoso.org",
	"123 4567",
	"Bob Marley",
];
const USER =
	"Email sarah.connor@example.com, call +1 (415) 555-0182, then read contacts.txt for Sarah Connor.";
const SYSTEM =
	"You are a test assistant. Escalations go to Dana Scully at dana.scully@fbi.example.";
// The marker is not personal data, so it survives the gate: it tells the fake
// model the tool result is in the conversation.
const FILE = "MARKER-7731 Bob Marley, bob.marley@contoso.org, +353 87 123 4567\n";
const HOSTED = "https://openrouter.ai/api/v1";

/** Every request that left for a non-loopback host: url and raw body. */
const hosted: { url: string; body: string }[] = [];
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	EIGHT_KEY_BACKEND: "file",
	OPENROUTER_API_KEY: "test-openrouter-key",
	EIGHT_ALLOW_HOSTED: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let fetchSpy: { mockRestore: () => void } | undefined;
let chainSpy: { mockRestore: () => void } | undefined;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function reply(model: string, message: Record<string, unknown>, finish: string): Response {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model,
		choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
		usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "pii-egress-home-"));
	repo = mkdtempSync(join(tmpdir(), "pii-egress-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "contacts.txt"), FILE);

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ data: [] });
			const body = JSON.parse(await req.text()) as { model: string };
			const text = JSON.stringify(body);
			if (!text.includes("MARKER-7731")) {
				return reply(
					body.model,
					{
						content: "",
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: {
									name: "read_file",
									arguments: JSON.stringify({ path: "contacts.txt" }),
								},
							},
						],
					},
					"tool_calls",
				);
			}
			return reply(body.model, { content: "Done." }, "stop");
		},
	});

	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.port === String(server.port) && LOOPBACK.has(url.hostname)) {
			return realFetch(input, init);
		}
		if (url.hostname === "openrouter.ai") {
			hosted.push({ url: url.href, body: typeof init?.body === "string" ? init.body : "" });
			const path = url.pathname.replace(/^\/api/, "");
			return realFetch(`http://127.0.0.1:${server.port}${path}${url.search}`, init);
		}
		// No real local model, no real network: any other host is refused.
		return Promise.reject(new Error(`test blocks network to ${url.host}`));
	}) as typeof fetch);

	const { ModelFailover } = await import("../providers/failover");
	chainSpy = spyOn(
		ModelFailover.prototype as unknown as { loadChains: () => unknown },
		"loadChains",
	).mockReturnValue({
		text: {
			"minimax/minimax-m2": { models: [{ model: "minimax/minimax-m2", provider: "openrouter" }] },
		},
		computer: {},
	});

	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	fetchSpy?.mockRestore();
	chainSpy?.mockRestore();
	server.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

describe("every hosted request in a turn passes the PII gate (#276)", () => {
	const paths: [string, string, boolean][] = [
		["native tools (AI SDK)", "0", false],
		["text tools (EIGHT_TEXT_TOOLS=1)", "1", false],
		["scoped agent (text tools forced)", "0", true],
	];
	for (const [name, textTools, scoped] of paths) {
		test(name, async () => {
			process.env.EIGHT_TEXT_TOOLS = textTools;
			const start = hosted.length;
			const agent = new Agent({
				model: "minimax/minimax-m2",
				runtime: "openrouter",
				baseUrl: HOSTED,
				workingDirectory: repo,
				systemPrompt: SYSTEM,
				...(scoped ? { allowedPaths: [repo] } : {}),
			} as ConstructorParameters<typeof import("./agent").Agent>[0]);
			await agent.chat(USER);
			const sent = hosted.slice(start).filter((r) => r.body);
			// The turn reached the cloud, and read the file there: two calls at least.
			expect(sent.length).toBeGreaterThanOrEqual(2);
			expect(sent.some((r) => r.body.includes("MARKER-7731"))).toBe(true);
			for (const r of sent) for (const raw of RAW) expect(r.body).not.toContain(raw);
			expect(sent.map((r) => r.body).join("\n")).toMatch(/\[EMAIL_\d+\]/);
		}, 60000);
	}
});

/**
 * Files that call fetch or open a websocket directly AND name a model API (a
 * hosted model host, or a chat, completion, transcription, image or TTS path).
 * Each was reviewed for #276: gated by its own check, local only, carrying no
 * personal data, or listed on #276 as open with its line. This list may only
 * shrink. A new file here must send through modelFetch instead.
 */
const KNOWN_DIRECT_MODEL_CALLS = new Set<string>([
	"apps/8gent-bot/src/vessel-client.ts",
	"apps/lil-eight/generate-parts.ts",
	"apps/linkedin-vessel/src/hyperagent.ts",
	"apps/linkedin-vessel/src/telegram-notify.ts",
	"apps/tui/src/app.tsx",
	"packages/ai/eyes-vision-provider.ts",
	"packages/ai/providers.ts",
	"packages/board-vessel/inference.ts",
	"packages/ci/review.ts",
	"packages/daemon/model-resolver.ts",
	"packages/daemon/slack.ts",
	"packages/daemon/telegram-bridge.ts",
	"packages/decide/backends/jev.ts",
	"packages/decide/backends/ollama.ts",
	"packages/eight/clients/anthropic.ts",
	"packages/eight/clients/apfel.ts",
	"packages/eight/clients/deepseek.ts",
	"packages/eight/clients/lmstudio.ts",
	"packages/eight/clients/ollama.ts",
	"packages/eight/clients/openrouter.ts",
	"packages/eight/clui-bridge.ts",
	"packages/eight/providers/openrouter.ts",
	"packages/eight/vision-interpreter.ts",
	"packages/eight/vision-router.ts",
	"packages/executor/autonomous.ts",
	"packages/gamedev/harness.ts",
	"packages/kernel/judge.ts",
	"packages/kernel/proxy.ts",
	"packages/kernel/version-manager.ts",
	"packages/music/replicate.ts",
	"packages/orchestration/adaptive-pipeline.ts",
	"packages/orchestration/local-model-detect.ts",
	"packages/orchestration/sequential-pipeline.ts",
	"packages/permissions/output-filter.ts",
	"packages/proactive/autoresearch.ts",
	"packages/providers/declared.ts",
	"packages/providers/index.ts",
	"packages/providers/local-judge.ts",
	"packages/secrets/index.ts",
	"packages/self-autonomy/onboarding.ts",
	"packages/self-autonomy/selfimprove.ts",
	"packages/table/huddle-demo.ts",
	"packages/tools/image.ts",
	"packages/voice/cloud-transcriber.ts",
]);

test("no new direct model call outside the gated exit (ratchet)", () => {
	const root = join(import.meta.dir, "..", "..");
	const files = Bun.spawnSync(["git", "ls-files", "packages", "apps", "bin"], { cwd: root })
		.stdout.toString()
		.split("\n")
		.filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f))
		.filter((f) => !/(\.test\.|\.spec\.|\/tests?\/|__tests__|\/fixtures?\/|\.d\.ts$)/.test(f));
	const call = /(^|[^.A-Za-z])fetch\(|new WebSocket\(/m;
	const modelApi =
		/chat\/completions|\/v1\/messages|audio\/transcriptions|images\/generations|\/api\/generate|\/api\/chat|\/predictions|text-to-speech|\/invoke|openrouter\.ai|api\.openai\.com|api\.anthropic\.com|api\.minimax\.io|ai-gateway\.vercel\.sh|api\.elevenlabs\.io|fal\.run/;
	const found = files.filter((f) => {
		const src = readFileSync(join(root, f), "utf8");
		return call.test(src) && modelApi.test(src);
	});
	expect(found.filter((f) => !KNOWN_DIRECT_MODEL_CALLS.has(f))).toEqual([]);
});
