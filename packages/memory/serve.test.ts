import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryReader, isPrivate } from "./serve.ts";
import { MemoryStore } from "./store.ts";
import type { Memory } from "./types.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
let dir: string;
let dbPath: string;
let logPath: string;

function core(id: string, content: string, tags: string[]): Memory {
	const now = Date.now();
	return {
		id,
		type: "core",
		scope: "global",
		category: "preference",
		key: id,
		title: id,
		content,
		confidence: 0.9,
		evidenceCount: 1,
		tags,
		importance: 0.5,
		decayFactor: 1,
		accessCount: 0,
		createdAt: now,
		updatedAt: now,
		version: 1,
		source: "user",
	} as unknown as Memory;
}

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-serve-"));
	fs.mkdirSync(path.join(dir, "memory"));
	dbPath = path.join(dir, "memory", "memory.db");
	logPath = path.join(dir, "memory", "memory-access.jsonl");
	const store = new MemoryStore(dbPath);
	store.write(core("pub1", "Rishi prefers pineapplewidget deployments on Fridays", ["ops"]));
	store.write(core("priv-tag", "pineapplewidget home address is a tagged secret", ["Private"]));
	store.write(core("priv-tag2", "pineapplewidget bank detail", ["secret"]));
	store.write(core("priv-mark", "pineapplewidget diary entry #PRIVATE do not share", []));
	store.close();
	// A legacy row written before the admission gate redacted secrets.
	const raw = new Database(dbPath);
	const now = Date.now();
	raw
		.prepare(
			`INSERT INTO memories (id, type, scope, data, content_text, tags, source, created_at, updated_at)
			 VALUES ('legacy-secret','core','global',?,?,'[]','user',?,?)`,
		)
		.run('{"x":1}', "pineapplewidget token ghp_abcdefghijklmnopqrstuvwxyz0123456789", now, now);
	raw.close();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("filter and reader (real store)", () => {
	test("write attempt through the connection fails", () => {
		const r = new MemoryReader(dbPath);
		expect(() => r.connection.run("DELETE FROM memories")).toThrow();
		expect(() => r.connection.run("INSERT INTO memories (id) VALUES ('x')")).toThrow();
		r.close();
	});

	test("search returns the public fact only", () => {
		const r = new MemoryReader(dbPath);
		const ids = r.search("pineapplewidget", 20).map((x) => x.id);
		expect(ids).toEqual(["pub1"]);
		r.close();
	});

	test("get by id refuses every private row, same as missing", () => {
		const r = new MemoryReader(dbPath);
		for (const id of ["priv-tag", "priv-tag2", "priv-mark", "legacy-secret", "nope"]) {
			expect(r.get(id)).toBeNull();
		}
		expect(r.get("pub1")?.text).toContain("pineapplewidget");
		r.close();
	});

	test("unreadable tags fail closed", () => {
		expect(isPrivate({ content_text: "a", data: "{}", tags: "{not json" })).toBe(true);
	});
});

describe("real stdio protocol", () => {
	test("spawn 8gent memory serve, recall a fact fast, never a private one, log written", async () => {
		fs.rmSync(logPath, { force: true }); // the reader tests above logged here too
		const proc = Bun.spawn(["bun", path.join(ROOT, "bin/8gent.ts"), "memory", "serve"], {
			cwd: ROOT,
			env: { ...process.env, EIGHT_DATA_DIR: dir },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = proc.stdout.getReader();
		let buf = "";
		const call = async (msg: object) => {
			proc.stdin.write(`${JSON.stringify(msg)}\n`);
			proc.stdin.flush();
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					return JSON.parse(line);
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("server exited");
				buf += new TextDecoder().decode(value);
			}
		};
		const tool = (id: number, name: string, args: object) =>
			call({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
		try {
			const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			expect(init.result.serverInfo.name).toBe("8gent-memory");
			const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
			expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
				"memory_search",
				"memory_get",
			]);

			const t0 = performance.now();
			const found = await tool(3, "memory_search", { query: "pineapplewidget", limit: 20 });
			const ms = performance.now() - t0;
			expect(ms).toBeLessThan(200);
			const hits = JSON.parse(found.result.content[0].text);
			expect(hits.map((h: { id: string }) => h.id)).toEqual(["pub1"]);

			for (const id of ["priv-tag", "priv-tag2", "priv-mark", "legacy-secret"]) {
				const got = await tool(4, "memory_get", { id });
				expect(got.result.isError).toBe(true);
				expect(got.result.content[0].text).toBe("not found");
			}
			const pub = await tool(5, "memory_get", { id: "pub1" });
			expect(JSON.parse(pub.result.content[0].text).id).toBe("pub1");
		} finally {
			proc.stdin.end();
			await proc.exited;
		}

		const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ tool: "memory_search", query: "pineapplewidget", count: 1 });
		expect(lines.length).toBe(1 + 4 + 1);
		expect(fs.readFileSync(logPath, "utf8")).not.toContain("Fridays");
		expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
	}, 30000);
});
