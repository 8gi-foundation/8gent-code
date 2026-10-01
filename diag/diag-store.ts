import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { MemoryStore } from "../packages/memory/store";
import { generateId } from "../packages/memory/types";
const mem = () => { const now = Date.now(); return { id: generateId("mem"), type: "core", scope: "project", category: "architecture", key: "k", title: "t", content: "c", confidence: 0.9, tags: ["a"], relatedKeys: [], learnedAt: now, lastConfirmed: now, importance: 0.6, decayFactor: 1, accessCount: 0, lastAccessed: now, createdAt: now, updatedAt: now, version: 1, source: "user_explicit" } as any; };
const ops: Record<string, (s: MemoryStore) => void> = {
  none: () => {}, write: (s) => { s.write(mem()); }, writeGet: (s) => { s.get(s.write(mem())); }, stats: (s) => { s.getStats(); },
};
for (const base of ["/tmp", os.tmpdir()]) for (const [name, op] of Object.entries(ops)) {
  fs.mkdirSync(base, { recursive: true });
  const f = path.join(base, `diag-${name}-${Date.now()}.db`);
  const s = new MemoryStore(f); let err = "";
  try { op(s); } catch (e) { err = "op threw " + e; }
  s.close();
  const res = ["", "-wal", "-shm"].map((x) => { const p = f + x; if (!fs.existsSync(p)) return x + ":absent"; try { fs.unlinkSync(p); return x + ":deleted"; } catch (e: any) { return x + ":" + e.code; } });
  console.log("DIAG", base, name, res.join(" "), err, "vec=", (s as any).vecLoaded);
}
