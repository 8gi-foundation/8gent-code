/**
 * ReplicateBackend guardrail (#2934, part of #2922).
 *
 * The backend builds a MusicGen prompt and a prediction request, then polls.
 * A fake fetch records every request and scripts the responses, so the
 * prompt wording, the request body and the poll/download flow are all
 * asserted without a network call or an API key that works.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplicateBackend } from "../replicate.js";
import type { MixConfig } from "../types.js";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

type Responder = (req: Recorded) => {
	ok?: boolean;
	status?: number;
	json?: unknown;
	bytes?: Uint8Array;
};

const realFetch = globalThis.fetch;
const realKey = process.env.REPLICATE_API_KEY;
let outDir: string;
let requests: Recorded[] = [];

function installFetch(respond: Responder): void {
	requests = [];
	const fake = async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = Object.fromEntries(
			Object.entries((init?.headers as Record<string, string>) ?? {}),
		);
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		const rec: Recorded = { url, method: init?.method ?? "GET", headers, body };
		requests.push(rec);
		const res = respond(rec);
		return {
			ok: res.ok ?? true,
			status: res.status ?? 200,
			json: async () => res.json,
			arrayBuffer: async () => (res.bytes ?? new Uint8Array()).buffer,
		} as unknown as Response;
	};
	globalThis.fetch = fake as unknown as typeof fetch;
}

beforeAll(() => {
	outDir = mkdtempSync(join(tmpdir(), "8gent-replicate-"));
});

afterAll(() => {
	globalThis.fetch = realFetch;
	if (realKey === undefined) delete process.env.REPLICATE_API_KEY;
	else process.env.REPLICATE_API_KEY = realKey;
	rmSync(outDir, { recursive: true, force: true });
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const baseConfig: MixConfig = {
	genre: "techno",
	bpm: 128,
	key: "Am",
	durationSec: 20,
	layers: ["drums", "bass"],
	mood: "driving",
	loop: true,
};

describe("ReplicateBackend availability", () => {
	test("is unavailable without an API key and never calls the network", async () => {
		delete process.env.REPLICATE_API_KEY;
		installFetch(() => ({}));
		const backend = new ReplicateBackend(outDir);
		expect(backend.available).toBe(false);
		expect(await backend.generate(baseConfig)).toBeNull();
		expect(requests).toEqual([]);
	});

	test("is available when the key is set", () => {
		process.env.REPLICATE_API_KEY = "test-key";
		expect(new ReplicateBackend(outDir).available).toBe(true);
	});
});

describe("ReplicateBackend request building", () => {
	test("posts a MusicGen prediction with the genre prompt, capped duration and bearer auth", async () => {
		process.env.REPLICATE_API_KEY = "test-key";
		installFetch(() => ({ ok: false, status: 401 }));
		const backend = new ReplicateBackend(outDir);

		expect(await backend.generate({ ...baseConfig, durationSec: 120 })).toBeNull();

		expect(requests).toHaveLength(1);
		const [req] = requests;
		expect(req.url).toBe("https://api.replicate.com/v1/predictions");
		expect(req.method).toBe("POST");
		expect(req.headers.Authorization).toBe("Bearer test-key");
		expect(req.headers["Content-Type"]).toBe("application/json");
		const body = req.body as { version: string; input: Record<string, unknown> };
		expect(body.version).toBe("671ac645ce5e552cc63a54a2bbff63fcf798043055f2a91c1c7c6b372394a788");
		expect(body.input.duration).toBe(30);
		expect(body.input.model_version).toBe("stereo-melody-large");
		expect(body.input.output_format).toBe("wav");
		expect(body.input.normalization_strategy).toBe("peak");
		expect(body.input.prompt).toBe(
			"driving four-on-the-floor techno with pulsating synthesizers and deep rolling bassline, driving mood, 128 BPM, key of Am, instrumental, high quality production, no vocals",
		);
	});

	test("keeps short durations as-is and omits mood and key when absent", async () => {
		process.env.REPLICATE_API_KEY = "test-key";
		installFetch(() => ({ ok: false, status: 500 }));
		const backend = new ReplicateBackend(outDir);
		await backend.generate({
			genre: "lofi",
			bpm: 80,
			durationSec: 12,
			layers: ["drums"],
			loop: false,
		});
		const body = requests[0].body as { input: Record<string, unknown> };
		expect(body.input.duration).toBe(12);
		expect(body.input.prompt).toBe(
			"warm lofi hip hop beats with vinyl crackle, jazzy chords, and mellow drums, 80 BPM, instrumental, high quality production, no vocals",
		);
	});

	test("describes genres without a curated prompt generically", async () => {
		process.env.REPLICATE_API_KEY = "test-key";
		installFetch(() => ({ ok: false, status: 500 }));
		await new ReplicateBackend(outDir).generate({
			genre: "garage",
			bpm: 130,
			durationSec: 10,
			layers: ["drums"],
			loop: false,
		});
		const body = requests[0].body as { input: Record<string, unknown> };
		expect(body.input.prompt).toBe(
			"garage electronic music, 130 BPM, instrumental, high quality production, no vocals",
		);
	});
});

describe("ReplicateBackend polling", () => {
	test("polls the prediction with auth, downloads the output and writes a wav", async () => {
		process.env.REPLICATE_API_KEY = "test-key";
		const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
		installFetch((req) => {
			if (req.method === "POST") return { json: { id: "pred_123" } };
			if (req.url.endsWith("/predictions/pred_123")) {
				return { json: { status: "succeeded", output: "https://cdn.test/pred_123.wav" } };
			}
			return { bytes: audio };
		});
		const backend = new ReplicateBackend(outDir);
		const out = await backend.generate(baseConfig);

		expect(out).not.toBeNull();
		expect(out?.startsWith(`${outDir}/replicate-`)).toBe(true);
		expect(out?.endsWith(".wav")).toBe(true);
		expect(Array.from(readFileSync(out as string))).toEqual(Array.from(audio));

		expect(requests.map((r) => r.url)).toEqual([
			"https://api.replicate.com/v1/predictions",
			"https://api.replicate.com/v1/predictions/pred_123",
			"https://cdn.test/pred_123.wav",
		]);
		expect(requests[1].headers.Authorization).toBe("Bearer test-key");
	}, 10000);

	test("returns null when the prediction fails", async () => {
		process.env.REPLICATE_API_KEY = "test-key";
		installFetch((req) => {
			if (req.method === "POST") return { json: { id: "pred_bad" } };
			return { json: { status: "failed", error: "model exploded" } };
		});
		expect(await new ReplicateBackend(outDir).generate(baseConfig)).toBeNull();
		expect(requests).toHaveLength(2);
	}, 10000);

	test("returns null when fetch throws", async () => {
		process.env.REPLICATE_API_KEY = "test-key";
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(await new ReplicateBackend(outDir).generate(baseConfig)).toBeNull();
	});
});
