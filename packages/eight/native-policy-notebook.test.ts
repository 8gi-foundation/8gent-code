/**
 * #3760: native run_command is evaluated by the policy engine like the
 * text-tool path, and the notebook write tools resolve through safePath and
 * gate a cell delete as a write, on both tool paths.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { CreatedFiles } from "../permissions/s1-created-files";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const priorContext = getToolContext();
const priorRoot = process.env.EIGHT_WORKSPACE_ROOT;
afterEach(() => {
	setToolContext(priorContext);
	if (priorRoot === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
	else process.env.EIGHT_WORKSPACE_ROOT = priorRoot;
});

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<string>;
const native = (name: string, args: Record<string, unknown>) =>
	((agentTools as Record<string, unknown>)[name] as unknown as { execute: Exec }).execute(args, { toolCallId: "t", messages: [] });

function nb(cells = 2): string {
	return JSON.stringify({
		cells: Array.from({ length: cells }, (_, i) => ({
			cell_type: "code",
			metadata: {},
			source: [`print(${i})`],
			outputs: [],
			execution_count: null,
		})),
		metadata: { kernelspec: { name: "python3", language: "python" } },
		nbformat: 4,
		nbformat_minor: 5,
	});
}

let ws = "";
let outside = "";
beforeEach(() => {
	ws = tempDir("nbpol-ws-");
	outside = tempDir("nbpol-out-");
	process.env.EIGHT_WORKSPACE_ROOT = ws;
	setToolContext({ ...priorContext, workingDirectory: ws, createdFiles: new CreatedFiles() });
});

describe("run_command policy parity (#3760)", () => {
	test("native and text path both refuse a command that writes outside the root", async () => {
		const nativeMarker = path.join(outside, "native-marker");
		const textMarker = path.join(outside, "text-marker");
		const nativeOut = await native("run_command", { command: `touch ${nativeMarker}` });
		const textOut = await new ToolExecutor(ws, "primary")
			.execute("run_command", { command: `touch ${textMarker}` })
			.catch((e) => String(e));
		expect(fs.existsSync(textMarker)).toBe(false);
		expect(String(textOut)).toContain("workspace-boundary");
		expect(fs.existsSync(nativeMarker)).toBe(false);
		expect(nativeOut).toContain("workspace-boundary");
	});

	test("native and text path both refuse a force push to main", async () => {
		const cmd = "git push --force origin main";
		const nativeOut = await native("run_command", { command: cmd });
		const textOut = await new ToolExecutor(ws, "primary")
			.execute("run_command", { command: cmd })
			.catch((e) => String(e));
		expect(nativeOut).toContain("no-force-push-main");
		expect(String(textOut)).toContain("no-force-push-main");
	});

	test("a command inside the root still runs natively", async () => {
		const out = await native("run_command", { command: "echo inside-3760" });
		expect(out).toContain("inside-3760");
	});
});

describe("notebook write tools (#3760)", () => {
	// No boundary env here, so safePath is the guard under test, not the policy engine.
	beforeEach(() => {
		delete process.env.EIGHT_WORKSPACE_ROOT;
	});

	const writes: Array<[string, (p: string) => Record<string, unknown>]> = [
		["notebook_edit_cell", (p) => ({ path: p, cellIndex: 0, newSource: "x = 1" })],
		["notebook_insert_cell", (p) => ({ path: p, afterIndex: 0, cellType: "code", source: "x = 1" })],
		["notebook_delete_cell", (p) => ({ path: p, cellIndex: 0 })],
	];

	for (const [name, mk] of writes) {
		test(`${name} is also refused by the policy gate when a root is set`, async () => {
			process.env.EIGHT_WORKSPACE_ROOT = ws;
			const target = path.join(outside, "g.ipynb");
			fs.writeFileSync(target, nb());
			const before = fs.readFileSync(target, "utf8");
			expect(await native(name, mk(target))).toContain("workspace-boundary");
			expect(fs.readFileSync(target, "utf8")).toBe(before);
		});

		test(`native ${name} refuses a notebook outside the root`, async () => {
			const target = path.join(outside, "n.ipynb");
			fs.writeFileSync(target, nb());
			const before = fs.readFileSync(target, "utf8");
			const out = await native(name, mk(target));
			expect(out).toContain("outside");
			expect(fs.readFileSync(target, "utf8")).toBe(before);
		});

		test(`native ${name} works on a notebook inside the root`, async () => {
			const target = path.join(ws, "n.ipynb");
			fs.writeFileSync(target, nb());
			const before = fs.readFileSync(target, "utf8");
			const out = await native(name, mk("n.ipynb"));
			expect(out).toContain('"success": true');
			expect(fs.readFileSync(target, "utf8")).not.toBe(before);
		});

		test(`text-path ${name} refuses a notebook outside the root`, async () => {
			const target = path.join(outside, "t.ipynb");
			fs.writeFileSync(target, nb());
			const before = fs.readFileSync(target, "utf8");
			const out = await new ToolExecutor(ws, "primary")
				.execute(name, mk(target))
				.catch((e) => String(e));
			expect(String(out)).toContain("outside");
			expect(fs.readFileSync(target, "utf8")).toBe(before);
		});
	}
	describe("symlinks inside the root", () => {
		for (const [name, mk] of writes) {
			test(`native and text-path ${name} refuse a symlinked notebook`, async () => {
				const target = path.join(outside, "ln.ipynb");
				fs.writeFileSync(target, nb());
				fs.symlinkSync(target, path.join(ws, "ln.ipynb"));
				const before = fs.readFileSync(target, "utf8");
				const nat = await native(name, mk("ln.ipynb"));
				const txt = await new ToolExecutor(ws, "primary").execute(name, mk("ln.ipynb")).catch((e) => String(e));
				expect(nat).toContain("symlink");
				expect(String(txt)).toContain("symlink");
				expect(fs.readFileSync(target, "utf8")).toBe(before);
			});

			test(`native and text-path ${name} treat a link that stays inside the root alike`, async () => {
				const real = path.join(ws, "real.ipynb");
				fs.writeFileSync(real, nb());
				fs.symlinkSync(real, path.join(ws, "alias.ipynb"));
				const nat = await native(name, mk("alias.ipynb"));
				fs.writeFileSync(real, nb());
				const txt = await new ToolExecutor(ws, "primary").execute(name, mk("alias.ipynb")).catch((e) => String(e));
				expect(nat.includes("success")).toBe(String(txt).includes("success"));
			});

			test(`native and text-path ${name} refuse a dangling link pointing outside`, async () => {
				const target = path.join(outside, "missing.ipynb");
				fs.symlinkSync(target, path.join(ws, "dangling.ipynb"));
				const nat = await native(name, mk("dangling.ipynb"));
				const txt = await new ToolExecutor(ws, "primary").execute(name, mk("dangling.ipynb")).catch((e) => String(e));
				expect(nat).toMatch(/symlink|outside/);
				expect(String(txt)).toMatch(/symlink|outside/);
				expect(fs.existsSync(target)).toBe(false);
			});

			test(`native and text-path ${name} refuse a symlinked parent directory`, async () => {
				fs.writeFileSync(path.join(outside, "pd.ipynb"), nb());
				fs.symlinkSync(outside, path.join(ws, "linkdir"));
				const before = fs.readFileSync(path.join(outside, "pd.ipynb"), "utf8");
				const nat = await native(name, mk("linkdir/pd.ipynb"));
				const txt = await new ToolExecutor(ws, "primary").execute(name, mk("linkdir/pd.ipynb")).catch((e) => String(e));
				expect(nat).toContain("outside");
				expect(String(txt)).toContain("outside");
				expect(fs.readFileSync(path.join(outside, "pd.ipynb"), "utf8")).toBe(before);
			});
		}
	});
});
