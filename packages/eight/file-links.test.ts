import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linksFooter, localImports } from "./file-links";
import { ToolExecutor } from "./tools";

let root: string;
const w = (rel: string, body: string) => {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
	return p;
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "file-links-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("localImports", () => {
	test("resolves relative specifiers to existing files, skips packages", () => {
		const cfg = w(
			"src/config.ts",
			`import { A } from "./a";\nimport x from "zod";\nexport * from "./sub";\nconst q = await import("./lazy");\n`,
		);
		const a = w("src/a.ts", "export const A = 1;");
		const sub = w("src/sub/index.ts", "export {};");
		const lazy = w("src/lazy.ts", "export {};");
		expect(localImports(cfg, fs.readFileSync(cfg, "utf-8")).sort()).toEqual([a, lazy, sub].sort());
	});
	test("a specifier with no file behind it is dropped", () => {
		const cfg = w("src/config.ts", `import { A } from "./missing";`);
		expect(localImports(cfg, fs.readFileSync(cfg, "utf-8"))).toEqual([]);
	});
});

describe("linksFooter", () => {
	test("names unread imports and unread importers, relative to cwd", () => {
		const cfg = w("src/config.ts", `import { Q } from "./queue";\nimport { D } from "./defaults";`);
		w("src/queue.ts", "export const Q = 1;");
		const d = w("src/defaults.ts", "export const D = 1;");
		w("src/worker.ts", `import { loadConfig } from "./config";`);
		const footer = linksFooter(cfg, fs.readFileSync(cfg, "utf-8"), new Set([cfg, d]), root);
		expect(footer).toBe("[Not read yet in this chain: src/queue.ts, src/worker.ts.]");
	});
	test("an importer is listed with its own unread imports, so retry.ts is named on the config read", () => {
		const cfg = w("src/config.ts", "export const c = 1;");
		const worker = w(
			"src/worker.ts",
			`import { c } from "./config";\nimport { waitSeconds } from "./retry";\nimport { log } from "./log";`,
		);
		const retry = w("src/retry.ts", "export const waitSeconds = () => 1;");
		w("src/log.ts", "export const log = 1;");
		const footer = linksFooter(cfg, "export const c = 1;", new Set([cfg, worker]), root);
		expect(footer).toBe("");
		const f2 = linksFooter(cfg, "export const c = 1;", new Set([cfg]), root);
		expect(f2).toContain("Not read yet in this chain: src/worker.ts, src/log.ts, src/retry.ts.");
		const f3 = linksFooter(cfg, "export const c = 1;", new Set([cfg, retry]), root);
		expect(f3).toContain("Not read yet in this chain: src/worker.ts, src/log.ts.");
		expect(f3).not.toContain("retry.ts");
	});
	test("the chain config -> worker -> retry surfaces retry once worker is read", () => {
		w("src/config.ts", "export const c = 1;");
		const worker = w(
			"src/worker.ts",
			`import { c } from "./config";\nimport { waitSeconds } from "./retry";`,
		);
		w("src/retry.ts", "export const waitSeconds = () => 1;");
		const footer = linksFooter(worker, fs.readFileSync(worker, "utf-8"), new Set([worker]), root);
		expect(footer).toContain("src/config.ts, src/retry.ts");
	});
	test("one to-do list in reading order: imports, then importers, then their imports; no separate clause", () => {
		const cfg = w(
			"src/config.ts",
			`import { D } from "./defaults";\nimport { R } from "./regions";`,
		);
		w("src/defaults.ts", "export const D = 1;");
		w("src/regions.ts", "export const R = 1;");
		w("src/worker.ts", `import { c } from "./config";\nimport { w } from "./retry";`);
		w("src/retry.ts", "export const w = 1;");
		const f = linksFooter(cfg, fs.readFileSync(cfg, "utf-8"), new Set([cfg]), root);
		expect(f).toBe(
			"[Not read yet in this chain: src/defaults.ts, src/regions.ts, src/worker.ts, src/retry.ts.]",
		);
		expect(f).not.toContain("Imported by");
		expect(f).not.toContain("also imports");
	});
	test("a name reached twice is listed once", () => {
		const cfg = w("src/config.ts", "export const c = 1;");
		for (let i = 0; i < 3; i++)
			w(`src/w${i}.ts`, `import { c } from "./config";\nimport { s } from "./shared";`);
		w("src/shared.ts", "export const s = 1;");
		const f = linksFooter(cfg, "export const c = 1;", new Set([cfg]), root);
		expect(f).toBe("[Not read yet in this chain: src/w0.ts, src/w1.ts, src/w2.ts, src/shared.ts.]");
	});
	test("the list is capped at eight names", () => {
		const cfg = w("src/config.ts", "export const c = 1;");
		for (let i = 0; i < 10; i++)
			w(`src/w${String(i).padStart(2, "0")}.ts`, `import { c } from "./config";`);
		const f = linksFooter(cfg, "export const c = 1;", new Set([cfg]), root);
		expect(f).toContain("src/w07.ts (+2 more).]");
		expect(f).not.toContain("src/w08.ts");
	});
	test("empty when everything linked has been read", () => {
		const a = w("src/a.ts", `import { b } from "./b";`);
		const b = w("src/b.ts", `export const b = 1;`);
		expect(linksFooter(a, fs.readFileSync(a, "utf-8"), new Set([a, b]), root)).toBe("");
	});
	test("non-code files get no footer", () => {
		const md = w("README.md", `see ./a`);
		expect(linksFooter(md, "see ./a", new Set(), root)).toBe("");
	});
	test("never walks node_modules", () => {
		const a = w("src/a.ts", "export const a = 1;");
		w("node_modules/pkg/x.ts", `import { a } from "../../src/a";`);
		expect(linksFooter(a, "export const a = 1;", new Set([a]), root)).toBe("");
	});
});

describe("confinement and bounds", () => {
	test("a ../ specifier that leaves cwd is never named", () => {
		const ws = path.join(root, "ws");
		const cfg = w("ws/src/a.ts", `import { s } from "../../out/secret";`);
		w("out/secret.ts", "export const s = 1;");
		expect(linksFooter(cfg, fs.readFileSync(cfg, "utf-8"), new Set([cfg]), ws)).toBe("");
	});
	test("a symlink inside cwd pointing outside is never named", () => {
		const ws = path.join(root, "ws");
		const cfg = w("ws/src/a.ts", `import { s } from "../lnk/secret";`);
		w("out/secret.ts", "export const s = 1;");
		fs.symlinkSync(path.join(root, "out"), path.join(ws, "lnk"));
		expect(linksFooter(cfg, fs.readFileSync(cfg, "utf-8"), new Set([cfg]), ws)).toBe("");
	});
	test("a file the caller's read policy denies is never named", () => {
		const cfg = w("src/a.ts", `import { k } from "./creds";`);
		const creds = w("src/creds.ts", "export const k = 1;");
		w("src/user.ts", `import { x } from "./a";`);
		const deny = (abs: string) => abs !== creds && !abs.endsWith("user.ts");
		expect(linksFooter(cfg, fs.readFileSync(cfg, "utf-8"), new Set([cfg]), root, deny)).toBe("");
		expect(linksFooter(cfg, fs.readFileSync(cfg, "utf-8"), new Set([cfg]), root)).toContain(
			"src/creds.ts",
		);
	});
	test("second hop: an importer is named but its import outside cwd (../ and symlink) is not", () => {
		const ws = path.join(root, "ws");
		const cfg = w("ws/src/a.ts", "export const a = 1;");
		w(
			"ws/src/worker.ts",
			`import { a } from "./a";\nimport { s } from "../../out/secret";\nimport { t } from "../lnk/token";`,
		);
		w("out/secret.ts", "export const s = 1;");
		w("out/token.ts", "export const t = 1;");
		fs.symlinkSync(path.join(root, "out"), path.join(ws, "lnk"));
		const f = linksFooter(cfg, "export const a = 1;", new Set([cfg]), ws);
		expect(f).toContain("src/worker.ts");
		expect(f).not.toContain("secret");
		expect(f).not.toContain("token");
		expect(f).toBe("[Not read yet in this chain: src/worker.ts.]");
	});
	test("second hop: an importer is named but its policy-denied import is not (allow-all control)", () => {
		const cfg = w("src/a.ts", "export const a = 1;");
		const creds = w("src/creds.ts", "export const k = 1;");
		w("src/worker.ts", `import { a } from "./a";\nimport { k } from "./creds";`);
		const deny = (abs: string) => abs !== creds;
		const denied = linksFooter(cfg, "export const a = 1;", new Set([cfg]), root, deny);
		expect(denied).toContain("src/worker.ts");
		expect(denied).not.toContain("creds");
		const open = linksFooter(cfg, "export const a = 1;", new Set([cfg]), root);
		expect(open).toContain("Not read yet in this chain: src/worker.ts, src/creds.ts.");
	});
	test("the directory cap truncates and says so", () => {
		const a = w("a.ts", "export const a = 1;");
		for (let i = 0; i < 20; i++) w(`d${i}/f.ts`, "export {};");
		const f = linksFooter(a, "export const a = 1;", new Set([a]), root, () => true, { maxDirs: 3 });
		expect(f).toContain("stopped early");
	});
	test("the file cap truncates and says so", () => {
		const a = w("a.ts", "export const a = 1;");
		for (let i = 0; i < 10; i++) w(`f${i}.ts`, "export {};");
		const f = linksFooter(a, "export const a = 1;", new Set([a]), root, () => true, {
			maxFiles: 3,
		});
		expect(f).toContain("stopped early");
	});
	test("the time budget covers the importer reads, not just the walk", () => {
		const a = w("a.ts", "export const a = 1;");
		for (let i = 0; i < 5; i++) w(`f${i}.ts`, `import { a } from "./a";`);
		let t = 0;
		// The walk is done on the first calls (t stays 0); each later call ticks past the budget.
		const clock = () => (t++ < 3 ? 0 : 1000);
		const f = linksFooter(a, "export const a = 1;", new Set([a]), root, () => true, {
			maxMs: 100,
			now: clock,
		});
		expect(f).toContain("stopped early");
		expect(f).not.toContain("f4.ts");
	});
	test("a small tree is not reported as truncated", () => {
		const a = w("a.ts", "export const a = 1;");
		expect(linksFooter(a, "export const a = 1;", new Set([a]), root)).toBe("");
	});
});

describe("read_file integration", () => {
	const read = (ex: ToolExecutor, p: string, extra: object = {}) =>
		ex.execute("read_file", { path: p, ...extra }) as Promise<string>;
	test("whole read names the unread chain, per session, and shrinks once read", async () => {
		w("src/config.ts", `import { d } from "./defaults";`);
		w("src/defaults.ts", "export const d = 1;");
		w("src/worker.ts", `import { c } from "./config";`);
		const ex = new ToolExecutor(root);
		const first = await read(ex, "src/config.ts");
		expect(first).toContain("Not read yet in this chain: src/defaults.ts, src/worker.ts.");
		expect(first).not.toContain("Imported by");
		await read(ex, "src/defaults.ts");
		await read(ex, "src/worker.ts");
		expect(await read(ex, "src/config.ts")).not.toContain("Not read yet");
		expect(await read(new ToolExecutor(root), "src/config.ts")).toContain("src/defaults.ts");
	});
	test("an offset/limit slice carries the footer too", async () => {
		w("src/config.ts", `import { d } from "./defaults";\nexport const x = 1;\n`);
		w("src/defaults.ts", "export const d = 1;");
		const out = await read(new ToolExecutor(root), "src/config.ts", { offset: 2, limit: 1 });
		expect(out).toContain("Not read yet in this chain: src/defaults.ts");
	});
	test("a file over 200 lines carries the footer after the truncation note", async () => {
		const body = `import { d } from "./defaults";\n${"export const y = 1;\n".repeat(250)}`;
		w("src/big.ts", body);
		w("src/defaults.ts", "export const d = 1;");
		const out = await read(new ToolExecutor(root), "src/big.ts");
		expect(out).toContain("truncated");
		expect(out.trimEnd().endsWith("Not read yet in this chain: src/defaults.ts.]")).toBe(true);
	});
	test("a markdown file gets no footer", async () => {
		w("README.md", "see ./a.ts");
		expect(await read(new ToolExecutor(root), "README.md")).not.toContain("Not read yet");
	});
});
