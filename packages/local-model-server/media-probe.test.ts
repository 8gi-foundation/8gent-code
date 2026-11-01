/**
 * Local media capability probe (#3422). Real HTTP fakes on 127.0.0.1 serving
 * recorded `/v1/models` shapes from Ollama, LM Studio and mlx-serve; nothing
 * leaves the machine and no real server is asked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	MAX_MODELS_BODY_BYTES,
	capabilitiesFromName,
	classifyModel,
	configuredLocalEndpoints,
	isLoopbackUrl,
	pickLocalModel,
	probeLocalMediaCapabilities,
	readCapped,
	safeForLog,
	serverRoot,
} from "./media-probe";

// Shapes as each server returns GET /v1/models.
const OLLAMA_MODELS = {
	object: "list",
	data: [
		{ id: "qwen3:14b", object: "model", created: 1759000000, owned_by: "library" },
		{ id: "nomic-embed-text:latest", object: "model", created: 1759000000, owned_by: "library" },
	],
};
const LMSTUDIO_MODELS = {
	data: [
		{ id: "qwen2.5-vl-7b-instruct", object: "model", owned_by: "organization_owner" },
		{ id: "text-embedding-nomic-embed-text-v1.5", object: "model", owned_by: "organization_owner" },
	],
	object: "list",
};
const MLX_SERVE_MODELS = {
	object: "list",
	data: [
		{
			id: "mlx-community/Qwen3-8B-4bit",
			capabilities: ["chat"],
			state: "ready",
			context_length: 32768,
		},
		{
			id: "black-forest-labs/FLUX.1-schnell",
			capabilities: ["image"],
			state: "unloaded",
			context_length: 0,
		},
		{
			id: "ACE-Step/ACE-Step-v1-3.5B",
			capabilities: ["music", "audio"],
			state: "remote",
			context_length: 0,
		},
	],
};

let hits: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
let OLLAMA = "";
let LMSTUDIO = "";
let MLX = "";
let SLOW = "";
let REDIRECT = "";
let CLOSED = "";
let HUGE = "";
let MANY_CAPS = "";

function fake(body: unknown, opts: { delayMs?: number; redirectTo?: string } = {}): string {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			hits.push(`${s.port}${new URL(req.url).pathname}`);
			if (opts.delayMs) await Bun.sleep(opts.delayMs);
			if (opts.redirectTo)
				return new Response(null, { status: 302, headers: { location: opts.redirectTo } });
			return Response.json(body);
		},
	});
	servers.push(s);
	return `http://127.0.0.1:${s.port}`;
}

beforeAll(() => {
	OLLAMA = fake(OLLAMA_MODELS);
	LMSTUDIO = fake(LMSTUDIO_MODELS);
	MLX = fake(MLX_SERVE_MODELS);
	SLOW = fake(MLX_SERVE_MODELS, { delayMs: 2000 });
	REDIRECT = fake(MLX_SERVE_MODELS, { redirectTo: `${MLX}/v1/models` });
	// A /v1/models body that streams past the cap with no Content-Length.
	const huge = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			let sent = 0;
			const chunk = new Uint8Array(256 * 1024).fill(0x20);
			return new Response(
				new ReadableStream({
					pull(c) {
						if (sent > MAX_MODELS_BODY_BYTES * 4) return c.close();
						sent += chunk.byteLength;
						c.enqueue(chunk);
					},
				}),
			);
		},
	});
	servers.push(huge);
	HUGE = `http://127.0.0.1:${huge.port}`;
	// "image" listed only after 40 filler capabilities: past the per-model cap.
	MANY_CAPS = fake({
		data: [
			{
				id: "padded/model",
				capabilities: [...Array.from({ length: 40 }, (_, i) => `c${i}`), "image"],
			},
		],
	});
	const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	CLOSED = `http://127.0.0.1:${closed.port}`;
	closed.stop(true);
});

afterAll(() => {
	for (const s of servers) s.stop(true);
});

describe("isLoopbackUrl", () => {
	test("accepts this machine only", () => {
		for (const u of [
			"http://localhost:1234",
			"http://127.0.0.1:11434",
			"http://127.9.9.9",
			"http://[::1]:8080",
			"https://localhost",
		]) {
			expect(isLoopbackUrl(u)).toBe(true);
		}
	});
	test("refuses LAN, public, look-alike and non-http hosts", () => {
		for (const u of [
			"http://192.168.1.20:11434",
			"http://10.0.0.5:1234",
			"http://gpu-box:11434",
			"http://127.0.0.1.evil.com",
			"http://localhost.evil.com",
			"http://1270.0.0.1",
			"http://user:pw@127.0.0.1",
			"https://api.openai.com/v1",
			"file:///etc/passwd",
			"not a url",
		]) {
			expect(isLoopbackUrl(u)).toBe(false);
		}
	});
});

describe("classification", () => {
	test("a declared capabilities list wins over the name", () => {
		const m = classifyModel({ id: "some/flux-lookalike-chat", capabilities: ["chat"] }, MLX);
		expect(m).toEqual({
			id: "some/flux-lookalike-chat",
			baseUrl: MLX,
			capabilities: ["chat"],
			source: "declared",
			state: undefined,
		});
	});
	test("known media names are classed, chat and vision models are not", () => {
		expect(capabilitiesFromName("black-forest-labs/FLUX.1-schnell")).toEqual(["image"]);
		expect(capabilitiesFromName("x/z-image-turbo")).toEqual(["image"]);
		expect(capabilitiesFromName("Qwen/Qwen-Image-Edit")).toEqual(["image"]);
		expect(capabilitiesFromName("facebook/musicgen-small")).toEqual(["music"]);
		expect(capabilitiesFromName("tencent/Hunyuan3D-2")).toEqual(["3d"]);
		expect(capabilitiesFromName("qwen2.5-vl-7b-instruct")).toEqual([]);
		expect(capabilitiesFromName("qwen3:14b")).toEqual([]);
		expect(capabilitiesFromName("llava:13b")).toEqual([]);
	});
	test("entries without a usable id are dropped", () => {
		expect(classifyModel({ capabilities: ["image"] }, MLX)).toBeNull();
		expect(classifyModel({ id: "" }, MLX)).toBeNull();
		expect(classifyModel({ id: "x".repeat(300) }, MLX)).toBeNull();
		expect(classifyModel("flux", MLX)).toBeNull();
	});
	test("name tokenising is linear on a long hostile id", () => {
		const t = performance.now();
		capabilitiesFromName(`${"a-".repeat(50_000)}!`);
		expect(performance.now() - t).toBeLessThan(500);
	});
});

describe("configuredLocalEndpoints", () => {
	test("defaults: mlx-serve, LM Studio, Ollama", () => {
		expect(configuredLocalEndpoints({})).toEqual([
			"http://127.0.0.1:11234",
			"http://localhost:1234",
			"http://localhost:11434",
		]);
	});
	test("honours env, strips /v1, drops Ollama when another server is selected", () => {
		expect(
			configuredLocalEndpoints({
				MLX_SERVE_URL: "http://127.0.0.1:9000/v1/",
				LM_STUDIO_HOST: "http://127.0.0.1:9001/",
				EIGHT_LOCAL_SERVER: "llama-server",
			}),
		).toEqual(["http://127.0.0.1:9000", "http://127.0.0.1:9001", "http://127.0.0.1:8080"]);
	});
	test("serverRoot", () => {
		expect(serverRoot("http://h:1/v1//")).toBe("http://h:1");
	});
});

describe("probeLocalMediaCapabilities", () => {
	test("reads all three shapes and picks only by capability", async () => {
		hits = [];
		const r = await probeLocalMediaCapabilities({ endpoints: [OLLAMA, LMSTUDIO, MLX] });
		expect(r.endpoints.map((e) => e.ok)).toEqual([true, true, true]);
		expect(r.models.length).toBe(7);
		expect(hits.every((h) => h.endsWith("/v1/models"))).toBe(true);

		const image = pickLocalModel(r, "image");
		expect(image).toEqual({
			ok: true,
			model: {
				id: "black-forest-labs/FLUX.1-schnell",
				baseUrl: MLX,
				capabilities: ["image"],
				source: "declared",
				state: "unloaded",
			},
		});
		// Chat is not picked here: name matching never classes chat models.
		expect(pickLocalModel(r, "chat")).toEqual({
			ok: false,
			reason: "chat is not a media capability this probe picks for (image, music, 3d)",
			answered: 3,
			asked: 3,
		});
	});

	test("a remote-state model is never picked", async () => {
		const r = await probeLocalMediaCapabilities({ endpoints: [MLX] });
		expect(pickLocalModel(r, "music")).toEqual({
			ok: false,
			reason: "no local model can do music (1 of 1 local model servers answered)",
			answered: 1,
			asked: 1,
		});
	});

	test("no capable model: a plain reason, no invented id", async () => {
		const r = await probeLocalMediaCapabilities({ endpoints: [OLLAMA, LMSTUDIO] });
		const p = pickLocalModel(r, "image");
		expect(p).toEqual({
			ok: false,
			reason: "no local model can do image (2 of 2 local model servers answered)",
			answered: 2,
			asked: 2,
		});
		expect(pickLocalModel(r, "3d").ok).toBe(false);
	});

	test("refuses a non-loopback endpoint without sending anything", async () => {
		const seen: string[] = [];
		const r = await probeLocalMediaCapabilities({
			endpoints: ["http://192.168.1.20:11434", "https://api.example.com"],
			fetchImpl: async (u) => {
				seen.push(u);
				return Response.json(MLX_SERVE_MODELS);
			},
		});
		expect(seen).toEqual([]);
		expect(r.endpoints.map((e) => e.error)).toEqual([
			"refused: not a loopback host",
			"refused: not a loopback host",
		]);
		expect(r.models).toEqual([]);
	});

	test("does not follow a redirect", async () => {
		hits = [];
		const r = await probeLocalMediaCapabilities({ endpoints: [REDIRECT] });
		expect(r.endpoints[0]).toMatchObject({ ok: false, error: "HTTP 302" });
		expect(hits.length).toBe(1);
	});

	test("short timeout and refused port are reported, never thrown", async () => {
		const t = performance.now();
		const r = await probeLocalMediaCapabilities({ endpoints: [SLOW, CLOSED], timeoutMs: 200 });
		expect(performance.now() - t).toBeLessThan(1500);
		expect(r.endpoints.map((e) => e.error)).toEqual(["timed out", "unreachable"]);
		expect(pickLocalModel(r, "image")).toEqual({
			ok: false,
			reason: "no local model can do image (0 of 2 local model servers answered)",
			answered: 0,
			asked: 2,
		});
	});
});

describe("bounded reads (8SO F1, F3)", () => {
	test("a /v1/models body past 2 MB is refused while streaming", async () => {
		const r = await probeLocalMediaCapabilities({ endpoints: [HUGE] });
		expect(r.endpoints[0]).toMatchObject({ ok: false, error: "body too large" });
		expect(r.models).toEqual([]);
	});

	test("a declared Content-Length over the cap is refused before reading", async () => {
		const res = new Response("small", { headers: { "content-length": String(64 * 1024 * 1024) } });
		await expect(readCapped(res, 1024)).rejects.toThrow("response body over 1024 bytes");
	});

	test("a body at the cap is read whole", async () => {
		const bytes = await readCapped(new Response("x".repeat(1024)), 1024);
		expect(bytes.byteLength).toBe(1024);
	});

	test("each model keeps at most 32 capabilities", async () => {
		const r = await probeLocalMediaCapabilities({ endpoints: [MANY_CAPS] });
		expect(r.models[0]?.capabilities.length).toBe(32);
		expect(pickLocalModel(r, "image").ok).toBe(false);
	});

	test("safeForLog drops C0 and C1 control characters", () => {
		expect(safeForLog("flux\u001b[2J\nfake\u0085line\u007f ok")).toBe("flux[2Jfakeline ok");
	});
});
