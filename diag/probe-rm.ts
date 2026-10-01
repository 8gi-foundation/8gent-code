// On EBUSY from rmSync, report which entries under the directory are locked.
import { mock } from "bun:test";
import fs from "node:fs"; import path from "node:path";
const r = fs.rmSync;
function walk(d: string, out: string[]) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { walk(p, out); out.push(p); } else out.push(p); } }
const rmSync = (p: any, o?: any) => { try { return r(p, o); } catch (e: any) {
  if (e.code === "EBUSY" || e.code === "EPERM") { const all: string[] = []; try { walk(String(p), all); } catch {}
    const locked = all.filter((x) => { try { fs.renameSync(x, x + ".pr"); fs.renameSync(x + ".pr", x); return false; } catch { return true; } });
    console.log("LOCKED under", p, "=>", locked.length ? locked.join(" , ") : "(no file locked; directory itself or a cwd)", "cwd=", process.cwd()); }
  throw e; } };
const patched = { ...fs, rmSync, default: { ...fs, rmSync } };
mock.module("node:fs", () => patched); mock.module("fs", () => patched);
