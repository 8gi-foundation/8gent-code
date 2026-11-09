/**
 * 8llm plan: read-only planner and device measurer for layer-streamed inference.
 * Reads a GGUF header and tensor table only, never weights. Nothing leaves the device.
 *   bun packages/8llm/plan.ts <model.gguf> [--context N] [--budget-gb N] [--measure]
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { totalmem, freemem, platform, homedir } from "node:os";
import { join, dirname } from "node:path";

const GB = 1024 ** 3;
const SCALAR: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
export type Tensor = { name: string; offset: number; bytes: number };
export type Header = { tensors: Tensor[]; meta: Record<string, number>; arch: string };

/** Windowed synchronous reader so large tokenizer arrays never load whole. */
function reader(fd: number) {
  let base = 0, buf = Buffer.alloc(0), pos = 0;
  const need = (n: number) => {
    if (pos >= base && pos + n <= base + buf.length) return;
    const b = Buffer.alloc(Math.max(n, 1 << 20));
    const got = readSync(fd, b, 0, b.length, pos);
    if (got < n) throw new Error("gguf: truncated header");
    base = pos; buf = b.subarray(0, got);
  };
  const take = (n: number) => { need(n); const o = pos - base; pos += n; return buf.subarray(o, o + n); };
  return {
    get pos() { return pos; },
    skip: (n: number) => { pos += n; },
    u32: () => take(4).readUInt32LE(0),
    u64: () => Number(take(8).readBigUInt64LE(0)),
    str: () => { const n = Number(take(8).readBigUInt64LE(0)); return take(n).toString("utf8"); },
    take,
  };
}

export function readHeader(path: string): Header {
  const fd = openSync(path, "r");
  try {
    const r = reader(fd);
    if (r.take(4).toString("latin1") !== "GGUF") throw new Error("gguf: bad magic");
    const version = r.u32();
    if (version < 2 || version > 3) throw new Error(`gguf: unsupported version ${version}`);
    const nT = r.u64(), nKV = r.u64();
    const meta: Record<string, number> = {};
    let arch = "", align = 32;
    const value = (type: number): number | string | undefined => {
      if (type === 8) return r.str();
      if (type === 9) {
        const et = r.u32(), n = r.u64();
        if (et === 8) for (let i = 0; i < n; i++) r.str();
        else r.skip(n * (SCALAR[et] ?? 0));
        return undefined;
      }
      const sz = SCALAR[type]; if (!sz) throw new Error(`gguf: bad value type ${type}`);
      const b = r.take(sz);
      return sz === 8 ? Number(b.readBigUInt64LE(0)) : type === 6 ? b.readFloatLE(0) : type === 12 ? b.readDoubleLE(0) : sz === 4 ? b.readUInt32LE(0) : sz === 2 ? b.readUInt16LE(0) : b[0];
    };
    for (let i = 0; i < nKV; i++) {
      const key = r.str(), v = value(r.u32());
      if (key === "general.architecture") arch = String(v);
      else if (key === "general.alignment") align = Number(v);
      else if (typeof v === "number") meta[key] = v;
    }
    const raw: { name: string; offset: number }[] = [];
    for (let i = 0; i < nT; i++) {
      const name = r.str(), nd = r.u32();
      r.skip(nd * 8 + 4);
      raw.push({ name, offset: r.u64() });
    }
    const dataStart = Math.ceil(r.pos / align) * align;
    const end = statSync(path).size - dataStart;
    const order = [...raw].sort((a, b) => a.offset - b.offset);
    const size = new Map(order.map((t, i) => [t.name, (i + 1 < order.length ? order[i + 1].offset : end) - t.offset]));
    return { arch, meta, tensors: raw.map((t) => ({ ...t, bytes: size.get(t.name)! })) };
  } finally { closeSync(fd); }
}

export type Plan = ReturnType<typeof makePlan>;
export function makePlan(h: Header, o: { context: number; budgetBytes: number; readBps?: number | null }) {
  const layers = new Map<number, number>();
  let embd = 0, head = 0, other = 0;
  for (const t of h.tensors) {
    const m = /^blk\.(\d+)\./.exec(t.name);
    if (m) layers.set(+m[1], (layers.get(+m[1]) ?? 0) + t.bytes);
    else if (t.name.startsWith("token_embd")) embd += t.bytes;
    else if (t.name.startsWith("output")) head += t.bytes;
    else other += t.bytes;
  }
  const n = layers.size, sizes = [...layers.values()];
  const maxLayer = Math.max(0, ...sizes), avgLayer = n ? sizes.reduce((a, b) => a + b, 0) / n : 0;
  const m = (k: string) => h.meta[`${h.arch}.${k}`];
  const heads = m("attention.head_count"), kvHeads = m("attention.head_count_kv") ?? heads;
  const headDim = m("attention.key_length") ?? (m("embedding_length") && heads ? m("embedding_length") / heads : 0);
  const kvPerToken = 2 * n * (kvHeads ?? 0) * headDim * 2; // K and V, fp16
  const kvBytes = kvPerToken * o.context, scratch = 0.5 * GB;
  const floor = 2 * maxLayer + embd + head + other + kvBytes + scratch;
  const fits = o.budgetBytes >= floor;
  const resident = fits && avgLayer ? Math.min(n, Math.floor((o.budgetBytes - floor) / avgLayer)) : 0;
  const streamed = n - resident, perToken = streamed * avgLayer;
  const secPerToken = o.readBps ? perToken / o.readBps : null;
  return { arch: h.arch, layers: n, layerBytes: Math.round(avgLayer), kvBytesPerToken: kvPerToken, context: o.context, kvBytes,
    floorBytes: floor, budgetBytes: o.budgetBytes, fits, residentLayers: resident, streamedLayers: streamed,
    streamedBytesPerToken: Math.round(perToken), readBps: o.readBps ?? null,
    decodeSecPerToken: secPerToken, decodeTokPerSec: secPerToken ? 1 / secPerToken : null };
}

/** Sequential read with the file cache bypassed. Returns null when bypass is unavailable (never a cached number). */
export async function measureRead(path: string, limit = 2 * GB): Promise<number | null> {
  let fd = -1;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const mac = platform() === "darwin";
    const lib = dlopen(mac ? "libSystem.B.dylib" : "libc.so.6", mac
      ? { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } }
      : { posix_fadvise: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32], returns: FFIType.i32 } });
    fd = openSync(path, "r");
    const total = Math.min(statSync(path).size, limit);
    // macOS F_NOCACHE=48 on the fd; Linux POSIX_FADV_DONTNEED=4 drops the range before reading.
    const rc = mac ? lib.symbols.fcntl!(fd, 48, 1) : lib.symbols.posix_fadvise!(fd, 0, total, 4);
    if (rc !== 0) return null;
    const buf = Buffer.alloc(8 << 20);
    const t0 = performance.now();
    let done = 0;
    while (done < total) { const got = readSync(fd, buf, 0, Math.min(buf.length, total - done), done); if (!got) break; done += got; }
    const secs = (performance.now() - t0) / 1000;
    return done && secs > 0 ? done / secs : null;
  } catch { return null; } finally { if (fd >= 0) closeSync(fd); }
}

export function appendLedger(file: string, plan: Plan, model: string, measured: boolean) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), model, measured, device: { platform: platform(), totalBytes: totalmem(), freeBytes: freemem() }, plan }) + "\n");
}

export function render(p: Plan): string {
  const g = (x: number) => (x / GB).toFixed(2) + " GB";
  return [`arch ${p.arch}, ${p.layers} layers of ${g(p.layerBytes)}`, `budget ${g(p.budgetBytes)}, floor ${g(p.floorBytes)} (kv ${g(p.kvBytes)} at context ${p.context})`,
    p.fits ? `resident ${p.residentLayers} layers, stream ${p.streamedLayers}, ${g(p.streamedBytesPerToken)} read per token` : "does not fit: budget is under the floor",
    p.decodeSecPerToken ? `measured read ${g(p.readBps!)}/s, decode floor ${p.decodeSecPerToken.toFixed(1)} s/token (${p.decodeTokPerSec!.toFixed(3)} tok/s)` : "decode floor: not measured (pass --measure)"].join("\n");
}

if (import.meta.main) {
  const a = process.argv.slice(2), model = a.find((x) => !x.startsWith("--") && !/^\d+(\.\d+)?$/.test(x));
  const flag = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (!model) { console.error("usage: plan.ts <model.gguf> [--context N] [--budget-gb N] [--measure]"); process.exit(2); }
  const budget = flag("--budget-gb") ? +flag("--budget-gb")! * GB : Math.max(0, totalmem() - 7 * GB);
  const bps = a.includes("--measure") ? await measureRead(model) : null;
  if (a.includes("--measure") && bps === null) console.error("read speed not measured: cache bypass unavailable here");
  const plan = makePlan(readHeader(model), { context: +(flag("--context") ?? 4096), budgetBytes: budget, readBps: bps });
  console.log(render(plan));
  appendLedger(join(homedir(), ".8gent", "8llm", "plans.jsonl"), plan, model, bps !== null);
}
