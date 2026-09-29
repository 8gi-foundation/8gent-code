/**
 * Semantic locate (M3b): symbol signature + path embeddings, cosine top-k,
 * built lazily, persisted beside the index cache, and hybrid with a note when
 * embeddings are unavailable. The provider here is a fake bag-of-words
 * embedder, so these tests never need Ollama.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EmbeddingProvider } from "../memory/embeddings";
import { clearIndex, indexFolder, refreshIndex } from "./index";
import { formatLocate, locate } from "./locate";
import type { ProseRouting } from "./locate-system-one";
import {
	SEMANTIC_KINDS,
	clearSemanticIndex,
	ensureSemanticIndex,
	semanticDoc,
	semanticSearch,
	semanticStatus,
} from "./semantic";

const DIMS = 64;

/** Split camel case and punctuation into lower-case words. */
function wordsOf(text: string): string[] {
	return text
		.replace(/^search_(query|document): /, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 2);
}

/** A fake embedder: each word adds 1 to one hashed dimension. */
class FakeEmbedder implements EmbeddingProvider {
	readonly dimensions = DIMS;
	readonly model = "fake-bow";
	available = true;
	texts: string[] = [];
	fail = false;
	delayMs = 0;
	gate: Promise<void> | null = null;
	async generate(text: string): Promise<Float32Array> {
		if (this.gate) await this.gate;
		if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		if (this.fail) throw new Error("embedder down");
		this.texts.push(text);
		const v = new Float32Array(DIMS);
		for (const w of wordsOf(text)) {
			let h = 0;
			for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
			v[h % DIMS] += 1;
		}
		return v;
	}
	async generateBatch(texts: string[]): Promise<Float32Array[]> {
		const out: Float32Array[] = [];
		for (const t of texts) out.push(await this.generate(t));
		return out;
	}
}

let root: string;
let cacheRoot: string;
let emb: FakeEmbedder;

function write(rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

beforeEach(async () => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-repo-")));
	cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-cache-"));
	write(
		"src/guard/repeat-detector.ts",
		"export class RepeatDetector {\n\tnoticeRepeatedAction(action: string): boolean {\n\t\treturn false;\n\t}\n}\n",
	);
	write(
		"src/net/failover.ts",
		"export function switchModelWhenProviderStops(provider: string): string {\n\treturn provider;\n}\n",
	);
	write("src/util/strings.ts", "export function padLeft(s: string, n: number) {\n\treturn s;\n}\n");
	write("src/util/consts.ts", "export const SOME_LIMIT = 5;\n");
	emb = new FakeEmbedder();
	await indexFolder(root, { cacheDir: cacheRoot });
});

afterEach(() => {
	clearSemanticIndex(root);
	clearIndex(root);
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("semanticDoc", () => {
	test("is the signature and the relative path", () => {
		const doc = semanticDoc(root, {
			id: `${root}/src/a.ts::f`,
			name: "f",
			kind: "function",
			filePath: path.join(root, "src/a.ts"),
			startLine: 1,
			endLine: 3,
			signature: "function f(a: string):\n   number",
		});
		expect(doc).toBe("function f(a: string): number src/a.ts");
		expect(
			semanticDoc(root, {
				id: "x",
				name: "Box",
				kind: "class",
				filePath: path.join(root, "b.ts"),
				startLine: 1,
				endLine: 1,
			}),
		).toBe("class Box b.ts");
	});

	test("embeds functions, classes, interfaces, types and methods, not constants", () => {
		expect([...SEMANTIC_KINDS].sort()).toEqual([
			"class",
			"function",
			"interface",
			"method",
			"type",
		]);
	});
});

describe("semantic index", () => {
	test("ranks the symbol whose signature and path carry the query's meaning", async () => {
		expect(await ensureSemanticIndex(root, { provider: emb })).toMatchObject({ state: "ready" });
		// Constants are not embedded: 4 symbols (class, method, 2 functions).
		expect(emb.texts.length).toBe(4);
		expect(emb.texts.every((t) => t.startsWith("search_document: "))).toBe(true);
		const r = await semanticSearch(root, "notice a repeated action", { provider: emb });
		expect(r.status).toBe("ready");
		expect(r.hits[0]?.symbol.filePath).toBe(path.join(root, "src/guard/repeat-detector.ts"));
		expect(emb.texts.at(-1)).toBe("search_query: notice a repeated action");
		const f = await semanticSearch(root, "switch model when a provider stops", { provider: emb });
		expect(f.hits[0]?.symbol.name).toBe("switchModelWhenProviderStops");
	});

	test("vectors persist beside the index cache: a new process embeds nothing twice", async () => {
		await ensureSemanticIndex(root, { provider: emb });
		expect(emb.texts.length).toBe(4);
		clearSemanticIndex(root);
		const again = new FakeEmbedder();
		expect(await ensureSemanticIndex(root, { provider: again })).toMatchObject({ state: "ready" });
		expect(again.texts).toEqual([]);
	});

	test("after a file changes, only the new signatures are embedded", async () => {
		await ensureSemanticIndex(root, { provider: emb });
		write(
			"src/util/strings.ts",
			"export function padRight(s: string, n: number) {\n\treturn s;\n}\n",
		);
		fs.utimesSync(path.join(root, "src/util/strings.ts"), new Date(), new Date(Date.now() + 5000));
		refreshIndex(root);
		emb.texts = [];
		expect(await ensureSemanticIndex(root, { provider: emb })).toMatchObject({ state: "ready" });
		expect(emb.texts).toEqual([
			"search_document: function padRight(s: string, n: number) src/util/strings.ts",
		]);
		const r = await semanticSearch(root, "pad right", { provider: emb });
		expect(r.hits[0]?.symbol.name).toBe("padRight");
	});

	test("a change that keeps every signature embeds nothing and leaves the store file alone", async () => {
		await ensureSemanticIndex(root, { provider: emb });
		const dir = fs.readdirSync(cacheRoot).map((d) => path.join(cacheRoot, d))[0];
		const bin = fs.readdirSync(dir).find((f) => f.endsWith(".f32"));
		expect(bin).toBe("embeddings-fake-bow.f32");
		const before = fs.statSync(path.join(dir, bin!)).mtimeMs;
		write(
			"src/util/strings.ts",
			"export function padLeft(s: string, n: number) {\n\treturn s + '';\n}\n",
		);
		fs.utimesSync(path.join(root, "src/util/strings.ts"), new Date(), new Date(Date.now() + 5000));
		expect(refreshIndex(root)).toMatchObject({ changed: 1 });
		emb.texts = [];
		expect(await ensureSemanticIndex(root, { provider: emb })).toMatchObject({ state: "ready" });
		expect(emb.texts).toEqual([]);
		expect(fs.statSync(path.join(dir, bin!)).mtimeMs).toBe(before);
	});

	test("a search before the index is built starts the build and says it is building", async () => {
		let open!: () => void;
		emb.gate = new Promise((r) => {
			open = r;
		});
		const first = await semanticSearch(root, "repeated action", { provider: emb });
		expect(first).toMatchObject({ status: "building", hits: [] });
		expect(semanticStatus(root)).toMatchObject({ state: "building", total: 4 });
		open();
		await ensureSemanticIndex(root, { provider: emb });
		expect((await semanticSearch(root, "repeated action", { provider: emb })).status).toBe("ready");
	});

	test("no embedding model: unavailable, never thrown", async () => {
		emb.available = false;
		expect(await ensureSemanticIndex(root, { provider: emb })).toMatchObject({
			state: "unavailable",
		});
		expect(await semanticSearch(root, "anything", { provider: emb })).toMatchObject({
			status: "unavailable",
			hits: [],
		});
	});

	test("an embedder that fails mid-build is unavailable, not thrown", async () => {
		emb.fail = true;
		expect(await ensureSemanticIndex(root, { provider: emb })).toMatchObject({
			state: "unavailable",
		});
	});

	test("a slow query embedding times out", async () => {
		await ensureSemanticIndex(root, { provider: emb });
		emb.delayMs = 200;
		const r = await semanticSearch(root, "repeated action", { provider: emb, queryTimeoutMs: 20 });
		expect(r).toMatchObject({ status: "timeout", hits: [] });
	});

	test("a repo with no index is unavailable", async () => {
		expect(await semanticSearch("/no/such/repo", "x", { provider: emb })).toMatchObject({
			status: "unavailable",
		});
	});
});

describe("locate in semantic mode", () => {
	const semanticRouter = async (): Promise<ProseRouting> => ({
		mode: "semantic",
		chosen: "semantic",
		reason: "model",
		confidence: 0.95,
		threshold: 0.5,
		latencyMs: 1,
	});

	test("a kept semantic mode answers with the nearest signatures", async () => {
		await ensureSemanticIndex(root, { provider: emb });
		const r = await locate("how does it notice a repeated action", {
			root,
			repoId: root,
			systemOne: semanticRouter,
			semantic: (id, q) => semanticSearch(id, q, { provider: emb }),
		});
		expect(r.route).toMatchObject({ mode: "semantic", rule: "system_one" });
		expect(r.rows[0]).toMatchObject({ file: "src/guard/repeat-detector.ts" });
		expect(r.rows.length).toBeLessThanOrEqual(5);
		expect(formatLocate(r).split("\n")[0]).toBe(
			"locate semantic (system_one semantic 0.95): how does it notice a repeated action",
		);
	});

	test("semantic unavailable: the hybrid answer with a note", async () => {
		emb.available = false;
		const plain = await locate("how does it notice a repeated action", {
			root,
			repoId: root,
			systemOne: null,
		});
		const r = await locate("how does it notice a repeated action", {
			root,
			repoId: root,
			systemOne: semanticRouter,
			semantic: (id, q) => semanticSearch(id, q, { provider: emb }),
		});
		expect(r.route).toMatchObject({ mode: "hybrid", rule: "prose" });
		expect(r.rows).toEqual(plain.rows);
		expect(r.semantic).toMatchObject({ status: "unavailable" });
		expect(formatLocate(r)).toContain("Semantic search is not available");
	});

	test("semantic still building: the hybrid answer with a note", async () => {
		emb.gate = new Promise(() => {});
		const r = await locate("how does it notice a repeated action", {
			root,
			repoId: root,
			systemOne: semanticRouter,
			semantic: (id, q) => semanticSearch(id, q, { provider: emb }),
		});
		expect(r.route).toMatchObject({ mode: "hybrid" });
		expect(formatLocate(r)).toContain("semantic index is still being built (0 of 4");
	});
});
