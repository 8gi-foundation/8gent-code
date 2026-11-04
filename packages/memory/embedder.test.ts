/**
 * Opt-in embedder: consent, download safety, provider wire format, and the
 * store guard that keeps two models' vectors apart. No network: fetch is
 * injected, the llama.cpp endpoint is a loopback stub.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LlamaCppEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { EMBEDDER, askYesNo, downloadModel, enableEmbedder, isAllowedHost, isAttended } from "./embedder-setup.js";
import { MemoryStore } from "./store.js";
import type { SemanticMemory } from "./types.js";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "embedder-"));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const body = new TextEncoder().encode("pretend weights");
const goodHash = createHash("sha256").update(body).digest("hex");
const ok = () => new Response(body, { status: 200 });

describe("download safety", () => {
	test("hosts: only huggingface.co and hf.co", () => {
		expect(isAllowedHost("huggingface.co")).toBe(true);
		expect(isAllowedHost("cas-bridge.xethub.hf.co")).toBe(true);
		expect(isAllowedHost("evilhuggingface.co")).toBe(false);
		expect(isAllowedHost("huggingface.co.evil.com")).toBe(false);
	});

	test("a matching hash lands the file under its final name", async () => {
		const dest = join(tmp(), "m.gguf");
		await downloadModel({ dest, sha256: goodHash, fetchImpl: (async () => ok()) as unknown as typeof fetch });
		expect(readFileSync(dest)).toEqual(Buffer.from(body));
		expect(existsSync(`${dest}.part`)).toBe(false);
	});

	test("a wrong hash deletes the file and throws", async () => {
		const dest = join(tmp(), "m.gguf");
		await expect(
			downloadModel({ dest, sha256: "0".repeat(64), fetchImpl: (async () => ok()) as unknown as typeof fetch }),
		).rejects.toThrow(/hash mismatch/);
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(`${dest}.part`)).toBe(false);
	});

	test("a redirect to another host is refused before any bytes are fetched", async () => {
		const hosts: string[] = [];
		const f = (async (u: string) => {
			hosts.push(new URL(u).hostname);
			return new Response(null, { status: 302, headers: { location: "https://evil.example/model.gguf" } });
		}) as unknown as typeof fetch;
		await expect(downloadModel({ dest: join(tmp(), "m.gguf"), fetchImpl: f })).rejects.toThrow(/not an allowed host/);
		expect(hosts).toEqual(["huggingface.co"]);
	});

	test("plain http is refused", async () => {
		await expect(
			downloadModel({ dest: join(tmp(), "m.gguf"), url: "http://huggingface.co/x", fetchImpl: fetch }),
		).rejects.toThrow(/not an allowed host/);
	});

	test("the pinned hash is a real sha256 and the URL is the Hugging Face card", () => {
		expect(EMBEDDER.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(new URL(EMBEDDER.url).hostname).toBe("huggingface.co");
	});
});

describe("consent: default is No, unattended is No", () => {
	test("unattended never asks and never downloads", async () => {
		let asked = false;
		let downloaded = false;
		const lines: string[] = [];
		const r = await enableEmbedder({
			base: tmp(),
			attended: false,
			ask: async () => ((asked = true), true),
			download: async () => ((downloaded = true), ""),
			log: (s) => lines.push(s),
		});
		expect(r).toBe("unattended");
		expect([asked, downloaded]).toEqual([false, false]);
		expect(lines.length).toBe(1);
	});

	test("CI, the daemon, and a missing TTY all count as unattended", () => {
		expect(isAttended({}, true)).toBe(true);
		expect(isAttended({ CI: "1" }, true)).toBe(false);
		expect(isAttended({ EIGHT_DAEMON: "1" }, true)).toBe(false);
		expect(isAttended({}, false)).toBe(false);
	});

	test("answering No downloads nothing", async () => {
		let downloaded = false;
		const r = await enableEmbedder({
			base: tmp(),
			attended: true,
			ask: async () => false,
			download: async () => ((downloaded = true), ""),
			log: () => {},
		});
		expect(r).toBe("declined");
		expect(downloaded).toBe(false);
	});

	test("Enter, empty, and anything but y/yes is No", async () => {
		for (const answer of ["\n", "n\n", "maybe\n", "yep\n"]) {
			expect(await askYesNo("go?", Readable.from([answer]))).toBe(false);
		}
		expect(await askYesNo("go?", Readable.from(["y\n"]))).toBe(true);
		expect(await askYesNo("go?", Readable.from(["Yes\n"]))).toBe(true);
	});

	test("the consent text names model, licence, size, source", async () => {
		const lines: string[] = [];
		await enableEmbedder({ base: tmp(), attended: true, ask: async () => false, log: (s) => lines.push(s) });
		const text = lines.join("\n");
		for (const needle of ["embeddinggemma-2", "Apache-2.0", "310 MB", "huggingface.co", "Prohibited Use"]) {
			expect(text).toContain(needle);
		}
		expect(text).not.toMatch(/\bagent/i);
		expect(text).not.toContain(String.fromCharCode(0x2014));
	});
});

describe("LlamaCppEmbeddingProvider wire format", () => {
	test("documents and queries carry different prefixes; order is preserved", async () => {
		const seen: string[][] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/health") return new Response("ok");
				const { input } = (await req.json()) as { input: string[] };
				seen.push(input);
				// Return out of order to prove the provider sorts by index.
				const data = input.map((_, i) => ({ index: i, embedding: [i, 1, 0] })).reverse();
				return Response.json({ data });
			},
		});
		try {
			const p = new LlamaCppEmbeddingProvider(`http://127.0.0.1:${server.port}`, { dimensions: 3 });
			expect(await p.checkAvailability()).toBe(true);
			await p.generate("a memory");
			await p.generateQuery("a question");
			const batch = await p.generateBatch(["x", "y"]);
			expect(seen[0]).toEqual(["title: none | text: a memory"]);
			expect(seen[1]).toEqual(["task: search result | query: a question"]);
			expect(Array.from(batch[0])).toEqual([0, 1, 0]);
			expect(Array.from(batch[1])).toEqual([1, 1, 0]);
		} finally {
			server.stop(true);
		}
	});

	test("a dead endpoint is unavailable, not an exception", async () => {
		const p = new LlamaCppEmbeddingProvider("http://127.0.0.1:1");
		expect(await p.checkAvailability()).toBe(false);
	});
});

describe("store keeps vector spaces apart", () => {
	const mem = (id: string, text: string): SemanticMemory => ({
		id, type: "semantic", category: "fact", key: id, value: text, confidence: 1, evidenceCount: 1,
		tags: [], relatedKeys: [], learnedAt: 1, lastConfirmed: 1, scope: "project", importance: 0.5,
		decayFactor: 1, accessCount: 0, lastAccessed: 0, createdAt: 1, updatedAt: 1, version: 1, source: "user_explicit",
	});
	// Two models in one 768-wide table. The query "uno" shares no word with any memory, so
	// only a vector can find it. Model A puts one/uno on axis 0; model B swaps the axes.
	const stub = (model: string, axisOf: Record<string, number>): EmbeddingProvider => {
		const vec = (t: string) => {
			const v = new Float32Array(768);
			const axis = Object.entries(axisOf).find(([w]) => t.includes(w))?.[1];
			v[axis ?? 767] = 1;
			return v;
		};
		return { model, dimensions: 768, available: true, generate: async (t) => vec(t), generateBatch: async (ts) => ts.map(vec) };
	};

	test("recall under model B ignores vectors written by model A and reports them stale", async () => {
		const store = new MemoryStore(":memory:");
		store.writeBatch([mem("m_one", "zzqx one"), mem("m_two", "zzqx two")]);
		const A = stub("model-a", { one: 0, uno: 0, two: 1, dos: 1 });
		const B = stub("model-b", { one: 1, uno: 1, two: 0, dos: 0 });
		const ids = async () => (await store.recall("uno", { limit: 5 })).map((r) => r.memory.id);

		store.setEmbeddingProvider(A);
		expect(store.countNeedsReembed()).toBe(2);
		expect(await store.reembedStale()).toBe(2);
		expect(store.countNeedsReembed()).toBe(0);
		expect((await ids())[0]).toBe("m_one");

		// Switch embedder before re-embedding: A's vectors are in another space and must not answer.
		store.setEmbeddingProvider(B);
		expect(store.countNeedsReembed()).toBe(2);
		expect(await ids()).toEqual([]);

		expect(await store.reembedStale()).toBe(2);
		expect((await ids())[0]).toBe("m_one");
		store.close();
	});
});
