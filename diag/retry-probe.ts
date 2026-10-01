// On EBUSY/EPERM from unlinkSync/rmSync, retry for up to 5 s and report whether the lock clears.
import { mock } from "bun:test";
import fs from "node:fs";
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function wrap(name: "unlinkSync" | "rmSync") {
  const orig = (fs as any)[name];
  return (p: any, o?: any) => {
    try { return orig(p, o); } catch (e: any) {
      if (e.code !== "EBUSY" && e.code !== "EPERM") throw e;
      const t0 = Date.now();
      for (let i = 0; i < 50; i++) { sleep(100); try { const r = orig(p, o); console.log(`RETRY-OK ${name} ${p} after ${Date.now() - t0}ms`); return r; } catch {} }
      console.log(`RETRY-FAIL ${name} ${p} still ${e.code} after ${Date.now() - t0}ms`); throw e;
    }
  };
}
const unlinkSync = wrap("unlinkSync"), rmSync = wrap("rmSync");
const patched = { ...fs, unlinkSync, rmSync, default: { ...fs, unlinkSync, rmSync } };
mock.module("node:fs", () => patched); mock.module("fs", () => patched);
