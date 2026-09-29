/**
 * 8gent - windows long-path helper tests.
 *
 * Win32 cases pass `platform` explicitly so the suite is host-independent.
 * The end-to-end cases spawn the current runtime and are skipped off win32.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSafe, toLongPath } from "./win-path";

const SEG = "very-long-segment";
const DEEP_LEAF = "leaf";
const DEEP = `C:\\Users\\dev\\${Array.from({ length: 16 }, (_, i) => `${SEG}-${i}`).join("\\")}\\${DEEP_LEAF}`;
const DEEP_UNC = `\\\\build-server\\share\\${Array.from({ length: 16 }, (_, i) => `${SEG}-${i}`).join("\\")}\\${DEEP_LEAF}`;

/** Build a win32 absolute path of an exact length. */
const sizedPath = (len: number) => `C:\\${"a".repeat(len - 3)}`;

describe("toLongPath", () => {
  test("absolute paths longer than MAX_PATH gain the extended-length marker", () => {
    expect(DEEP.length).toBeGreaterThan(260);
    expect(toLongPath(DEEP, "win32")).toBe(`\\\\?\\${DEEP}`);
  });

  test("long UNC paths become \\\\?\\UNC\\server\\share", () => {
    expect(toLongPath(DEEP_UNC, "win32")).toBe(`\\\\?\\UNC\\${DEEP_UNC.slice(2)}`);
  });

  test("short paths are returned unchanged", () => {
    expect(toLongPath("C:\\Users\\dev\\src\\index.ts", "win32")).toBe("C:\\Users\\dev\\src\\index.ts");
  });

  test("the rewrite threshold is exactly 240 characters", () => {
    expect(sizedPath(239).length).toBe(239);
    expect(toLongPath(sizedPath(239), "win32")).toBe(sizedPath(239));
    expect(toLongPath(sizedPath(240), "win32")).toBe(`\\\\?\\${sizedPath(240)}`);
  });

  test("already-extended paths are unchanged (idempotent)", () => {
    const local = `\\\\?\\${DEEP}`;
    const unc = `\\\\?\\UNC\\${DEEP_UNC.slice(2)}`;
    const device = "\\\\.\\PhysicalDrive0";
    expect(toLongPath(local, "win32")).toBe(local);
    expect(toLongPath(unc, "win32")).toBe(unc);
    expect(toLongPath(device, "win32")).toBe(device);
  });

  test("relative and non-absolute paths are never rewritten", () => {
    const relative = Array.from({ length: 16 }, (_, i) => `${SEG}-${i}`).join("\\");
    expect(toLongPath(relative, "win32")).toBe(relative);
    expect(toLongPath("C:", "win32")).toBe("C:");
    expect(toLongPath("", "win32")).toBe("");
  });

  test("marking emits backslashes only (verbatim paths reject forward slashes)", () => {
    const forward = DEEP.replace(/\\/g, "/");
    const out = toLongPath(forward, "win32");
    expect(out).toBe(`\\\\?\\${DEEP}`);
    expect(out.includes("/")).toBe(false);
  });

  test("no-op on non-win32 platforms", () => {
    for (const platform of ["linux", "darwin", "freebsd", "aix"] as NodeJS.Platform[]) {
      expect(toLongPath(DEEP, platform)).toBe(DEEP);
      expect(toLongPath(DEEP_UNC, platform)).toBe(DEEP_UNC);
    }
  });
});

describe.if(process.platform === "win32")("spawnSafe (win32 end-to-end)", () => {
  const script = path.join(os.tmpdir(), `8gent-winpath-${process.pid}.mjs`);
  fs.writeFileSync(
    script,
    "import fs from 'node:fs';console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),probe:fs.existsSync('8gent-cwd-probe.txt')}));",
  );
  const deepBase = path.win32.join(os.tmpdir().replace(/\//g, "\\"), `8gent-winpath-deep-${process.pid}`);
  afterAll(() => {
    fs.rmSync(script, { force: true });
    // The deep-cwd test must not leave debris in the user's temp directory.
    expect(fs.existsSync(deepBase)).toBe(false);
  });

  const run = (args: string[], cwd?: string) =>
    new Promise<string>((resolve, reject) => {
      const proc = spawnSafe(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", (code: number | null) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
      proc.on("error", reject);
    });

  test("arguments are passed through untouched", async () => {
    // Contract: only the cwd is marked. Marking argv breaks node's loader and
    // git's path parsing (see module docs), so the long operand must stay plain.
    const printed = JSON.parse(await run([script, DEEP])) as { argv: string[] };
    expect(printed.argv).toEqual([DEEP]);
  });

  test("the process starts inside a >260-char working directory", async () => {
    const deepCwd = path.win32.join(
      deepBase,
      ...Array.from({ length: 12 }, (_, i) => `${SEG}-dir-${i}`),
    );
    expect(deepCwd.length).toBeGreaterThan(260);
    fs.mkdirSync(`\\\\?\\${deepCwd}`, { recursive: true });
    fs.writeFileSync(`\\\\?\\${path.win32.join(deepCwd, "8gent-cwd-probe.txt")}`, "probe");
    try {
      const printed = JSON.parse(await run([script, "marker"], deepCwd)) as { argv: string[]; probe: boolean };
      expect(printed.argv).toEqual(["marker"]);
      // The child reports the 8.3 short form of a verbatim cwd, so prove the
      // working directory behaviourally: it must see the file we planted there.
      expect(printed.probe).toBe(true);
    } finally {
      removeDeepTree(deepBase);
    }
  });
});

/**
 * Windows releases a child's cwd handle asynchronously, so a single recursive
 * delete of a directory a just-exited child ran in can leave the upper levels
 * behind. Retry until the tree is actually gone; assert it in afterAll.
 */
function removeDeepTree(base: string): void {
  for (let attempt = 0; attempt < 6 && fs.existsSync(base); attempt++) {
    fs.rmSync(`\\\\?\\${base}`, { recursive: true, force: true });
    if (fs.existsSync(base)) Bun.sleepSync(50 * (attempt + 1));
  }
}
