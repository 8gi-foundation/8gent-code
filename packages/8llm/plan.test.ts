import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeader, makePlan, measureRead, appendLedger } from "./plan";

const str = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([l, b]); };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const kvU32 = (k: string, v: number) => Buffer.concat([str(k), u32(4), u32(v)]);

/** Synthetic header: 3 blocks of 1000 bytes, embeddings 500, head 400. Data is sparse, never real weights. */
function fixture(): string {
  const specs: [string, number][] = [["token_embd.weight", 500], ["blk.0.attn.weight", 1000], ["blk.1.attn.weight", 1000], ["blk.2.attn.weight", 1000], ["output.weight", 400]];
  let off = 0;
  const infos = specs.map(([n, sz]) => { const b = Buffer.concat([str(n), u32(1), u64(sz), u32(0), u64(off)]); off += sz; return b; });
  const tokens = Buffer.concat([str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(2), str("a"), str("bb")]);
  const kvs = [Buffer.concat([str("general.architecture"), u32(8), str("llama")]), kvU32("llama.attention.head_count", 8), kvU32("llama.attention.head_count_kv", 2), kvU32("llama.embedding_length", 64), tokens];
  const head = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(specs.length), u64(kvs.length), ...kvs, ...infos]);
  const start = Math.ceil(head.length / 32) * 32;
  const p = join(mkdtempSync(join(tmpdir(), "8llm-")), "m.gguf");
  writeFileSync(p, Buffer.concat([head, Buffer.alloc(start - head.length)]));
  truncateSync(p, start + off);
  return p;
}

test("reads header and tensor sizes without weights", () => {
  const h = readHeader(fixture());
  expect(h.arch).toBe("llama");
  expect(h.tensors.map((t) => t.bytes)).toEqual([500, 1000, 1000, 1000, 400]);
});

test("rejects a file that is not GGUF", () => {
  const p = join(mkdtempSync(join(tmpdir(), "8llm-")), "x.gguf");
  writeFileSync(p, "NOPE0000000000000000");
  expect(() => readHeader(p)).toThrow("bad magic");
});

test("plan: kv sizing, residency and decode floor", () => {
  const h = readHeader(fixture());
  const p = makePlan(h, { context: 10, budgetBytes: 1e12, readBps: 1000 });
  expect(p.layers).toBe(3);
  expect(p.kvBytesPerToken).toBe(2 * 3 * 2 * 8 * 2); // 2 * layers * kvHeads * headDim(8) * 2 bytes
  expect(p.residentLayers).toBe(3);
  expect(p.streamedBytesPerToken).toBe(0);
  const tight = makePlan(h, { context: 10, budgetBytes: p.floorBytes + 1000, readBps: 1000 });
  expect(tight.residentLayers).toBe(1);
  expect(tight.streamedLayers).toBe(2);
  expect(tight.decodeSecPerToken).toBe(2);
  expect(makePlan(h, { context: 10, budgetBytes: 10 }).fits).toBe(false);
});

test("measure returns a rate or null, never throws; ledger gets one line", async () => {
  const p = fixture();
  const bps = await measureRead(p);
  expect(bps === null || bps > 0).toBe(true);
  const ledger = join(mkdtempSync(join(tmpdir(), "8llm-")), "d", "plans.jsonl");
  appendLedger(ledger, makePlan(readHeader(p), { context: 10, budgetBytes: 1e9 }), p, bps !== null);
  expect(readFileSync(ledger, "utf8").trim().split("\n").length).toBe(1);
});

// Hostile fixtures: raw bytes written to a temp file, then parsed.
const tmp = (b: Buffer) => { const p = join(mkdtempSync(join(tmpdir(), "8llm-")), "h.gguf"); writeFileSync(p, b); return p; };
const hdr = (nT: number, kvs: Buffer[], infos: Buffer[] = []) => Buffer.concat([Buffer.from("GGUF"), u32(3), u64(nT), u64(kvs.length), ...kvs, ...infos]);
const info = (name: string, off: number) => Buffer.concat([str(name), u32(1), u64(1), u32(0), u64(off)]);

test("hostile: string length past end of file is refused before allocation", () => {
  const huge = Buffer.concat([u64(2 ** 40), Buffer.from("x")]);
  expect(() => readHeader(tmp(hdr(0, [huge])))).toThrow("past end of file");
});

test("hostile: alignment must be a power of two", () => {
  expect(() => readHeader(tmp(hdr(0, [kvU32("general.alignment", 48)])))).toThrow("power of two");
  expect(() => readHeader(tmp(hdr(0, [kvU32("general.alignment", 0)])))).toThrow("power of two");
});

test("hostile: tensor offset outside the data section is refused", () => {
  const h = hdr(1, [], [info("blk.0.a", 1 << 30)]);
  expect(() => readHeader(tmp(Buffer.concat([h, Buffer.alloc(64)])))).toThrow("outside data section");
});

test("hostile: header running past end of file never yields a negative size", () => {
  expect(() => readHeader(tmp(hdr(1, [], [info("blk.0.a", 0)])))).not.toThrow();
  const sizes = readHeader(tmp(hdr(1, [], [info("blk.0.a", 0)]))).tensors.map((t) => t.bytes);
  expect(sizes.every((b) => b >= 0)).toBe(true);
});

test("hostile: unknown array element type is refused", () => {
  const arr = Buffer.concat([str("k"), u32(9), u32(99), u64(1), Buffer.alloc(8)]);
  expect(() => readHeader(tmp(hdr(0, [arr])))).toThrow("unknown array element type");
});

test("hostile: implausible tensor count is refused", () => {
  expect(() => readHeader(tmp(hdr(2 ** 40, [])))).toThrow("implausible");
});

test("ledger line holds no path separator and keeps the basename", () => {
  const p = fixture();
  const ledger = join(mkdtempSync(join(tmpdir(), "8llm-")), "plans.jsonl");
  appendLedger(ledger, makePlan(readHeader(p), { context: 10, budgetBytes: 1e9 }), p, false);
  const line = readFileSync(ledger, "utf8");
  expect(line.includes("/")).toBe(false);
  expect(JSON.parse(line).model).toBe("m.gguf");
});
