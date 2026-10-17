import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linksFooter, localImports } from "./file-links";

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
		expect(footer).toContain("Local imports not read yet: src/queue.ts");
		expect(footer).not.toContain("src/defaults.ts");
		expect(footer).toContain("Imported by, not read yet: src/worker.ts");
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
