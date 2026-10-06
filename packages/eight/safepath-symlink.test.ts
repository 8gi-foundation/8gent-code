/**
 * #3607: safePath was lexical, so a symlink inside the workspace let write_file
 * and edit_file reach outside it. Runs through ToolExecutor, the shipped path.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);
process.env.EIGHT_NO_OPEN = "1";
process.env.EIGHT_DECK_VIDEO = "0";

const MSG = "Path escapes workspace via symlink";

function setup() {
	const root = tempDir("safepath-");
	const ws = path.join(root, "ws");
	const outside = path.join(root, "outside");
	fs.mkdirSync(ws);
	fs.mkdirSync(outside);
	return { ws, outside, ex: new ToolExecutor(ws) };
}

describe("safePath symlink confinement (#3607)", () => {
	for (const tool of ["write_file", "edit_file"] as const) {
		const call = (ex: ToolExecutor, p: string) =>
			tool === "write_file"
				? ex.execute("write_file", { path: p, content: "pwned" })
				: ex.execute("edit_file", { path: p, oldText: "secret", newText: "pwned" });

		test(`${tool}: symlinked directory cannot escape`, async () => {
			const { ws, outside, ex } = setup();
			fs.writeFileSync(path.join(outside, "f.txt"), "secret");
			fs.symlinkSync(outside, path.join(ws, "link"));
			await expect(call(ex, "link/f.txt")).rejects.toThrow(MSG);
			expect(fs.readFileSync(path.join(outside, "f.txt"), "utf-8")).toBe("secret");
		});

		test(`${tool}: new file under a symlinked directory cannot escape`, async () => {
			const { ws, outside, ex } = setup();
			fs.symlinkSync(outside, path.join(ws, "link"));
			await expect(call(ex, "link/new/deep.txt")).rejects.toThrow(MSG);
			expect(fs.existsSync(path.join(outside, "new"))).toBe(false);
		});

		test(`${tool}: dangling symlink is refused and its target not created`, async () => {
			const { ws, outside, ex } = setup();
			fs.symlinkSync(path.join(outside, "ghost.txt"), path.join(ws, "dangling"));
			await expect(call(ex, "dangling")).rejects.toThrow(MSG);
			expect(fs.existsSync(path.join(outside, "ghost.txt"))).toBe(false);
		});

		test(`${tool}: symlinked file is refused`, async () => {
			const { ws, outside, ex } = setup();
			fs.writeFileSync(path.join(outside, "f.txt"), "secret");
			fs.symlinkSync(path.join(outside, "f.txt"), path.join(ws, "flink"));
			await expect(call(ex, "flink")).rejects.toThrow(MSG);
			expect(fs.readFileSync(path.join(outside, "f.txt"), "utf-8")).toBe("secret");
		});

		test(`${tool}: nested symlink chain is refused`, async () => {
			const { ws, outside, ex } = setup();
			fs.writeFileSync(path.join(outside, "f.txt"), "secret");
			fs.symlinkSync(outside, path.join(ws, "hop2"));
			fs.symlinkSync(path.join(ws, "hop2"), path.join(ws, "hop1"));
			await expect(call(ex, "hop1/f.txt")).rejects.toThrow(MSG);
			expect(fs.readFileSync(path.join(outside, "f.txt"), "utf-8")).toBe("secret");
		});
	}

	test("write and edit through an in-workspace final symlink change the target (CLAUDE.md -> AGENTS.md)", async () => {
		const { ws, ex } = setup();
		fs.writeFileSync(path.join(ws, "AGENTS.md"), "old");
		fs.symlinkSync("AGENTS.md", path.join(ws, "CLAUDE.md"));
		await ex.execute("edit_file", { path: "CLAUDE.md", oldText: "old", newText: "mid" });
		expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf-8")).toBe("mid");
		await ex.execute("write_file", { path: "CLAUDE.md", content: "new" });
		expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf-8")).toBe("new");
		expect(fs.lstatSync(path.join(ws, "CLAUDE.md")).isSymbolicLink()).toBe(true);
	});

	test("a symlinked workspace root works and still confines", async () => {
		const { ws, outside } = setup();
		const alias = path.join(path.dirname(ws), "wsalias");
		fs.symlinkSync(ws, alias);
		const ex = new ToolExecutor(alias);
		expect(await ex.execute("write_file", { path: "a/b.txt", content: "x" })).toContain("File written");
		expect(fs.readFileSync(path.join(ws, "a/b.txt"), "utf-8")).toBe("x");
		fs.symlinkSync(outside, path.join(ws, "link"));
		await expect(ex.execute("write_file", { path: "link/z.txt", content: "x" })).rejects.toThrow(MSG);
	});

	test("a symlink loop is refused fast with a non-escape message", async () => {
		const { ws, ex } = setup();
		fs.symlinkSync("b", path.join(ws, "a"));
		fs.symlinkSync("a", path.join(ws, "b"));
		await expect(ex.execute("write_file", { path: "a", content: "x" })).rejects.toThrow("symlink loop");
		await expect(ex.execute("write_file", { path: "a/c.txt", content: "x" })).rejects.toThrow("symlink loop");
	});

	test("a dangling in-workspace symlink names the real target and is not called an escape", async () => {
		const { ws, ex } = setup();
		fs.symlinkSync("real.txt", path.join(ws, "d"));
		const err = await ex.execute("write_file", { path: "d", content: "x" }).catch((e) => e as Error);
		expect(String(err.message)).toContain(path.join(fs.realpathSync(ws), "real.txt"));
		expect(String(err.message)).not.toContain(MSG);
	});

	test("a normal nested new path still works", async () => {
		const { ws, ex } = setup();
		const out = await ex.execute("write_file", { path: "a/b/c.txt", content: "ok" });
		expect(out).toContain("File written");
		expect(fs.readFileSync(path.join(ws, "a/b/c.txt"), "utf-8")).toBe("ok");
		const edit = await ex.execute("edit_file", { path: "a/b/c.txt", oldText: "ok", newText: "fine" });
		expect(edit).not.toContain(MSG);
		expect(fs.readFileSync(path.join(ws, "a/b/c.txt"), "utf-8")).toBe("fine");
	});

	test("a symlink that stays inside the workspace is still readable and writable through", async () => {
		const { ws, ex } = setup();
		fs.mkdirSync(path.join(ws, "real"));
		fs.writeFileSync(path.join(ws, "real/x.txt"), "hello");
		fs.symlinkSync(path.join(ws, "real"), path.join(ws, "alias"));
		expect(await ex.execute("read_file", { path: "alias/x.txt" })).toContain("hello");
		expect(await ex.execute("write_file", { path: "alias/y.txt", content: "y" })).toContain("File written");
	});

	test("read_file through an escaping symlink is refused", async () => {
		const { ws, outside, ex } = setup();
		fs.writeFileSync(path.join(outside, "f.txt"), "secret");
		fs.symlinkSync(outside, path.join(ws, "link"));
		await expect(ex.execute("read_file", { path: "link/f.txt" })).rejects.toThrow(MSG);
		fs.symlinkSync(path.join(outside, "f.txt"), path.join(ws, "flink"));
		await expect(ex.execute("read_file", { path: "flink" })).rejects.toThrow(MSG);
	});
});
