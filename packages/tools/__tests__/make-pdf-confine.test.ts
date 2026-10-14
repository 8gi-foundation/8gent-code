/**
 * make_pdf reads mdPath and htmlPath only inside the workspace (#4272 hold, 8SO).
 *
 * Runs the real tool path (agentTools.make_pdf) beside read_file: whatever
 * read_file refuses, make_pdf must refuse too, and nothing may reach
 * ~/.8gent/creative. The planted text is checked against every PDF in that
 * folder, so a leak cannot hide behind a renamed output.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../../ai/tools";
import { CreatedFiles } from "../../permissions/s1-created-files";
import { CREATIVE_DIR, makePdf } from "../make-pdf";

afterAll(cleanupTempDirs);

const priorContext = getToolContext();
afterEach(() => setToolContext(priorContext));

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<string>;
const run = (name: "make_pdf" | "read_file", args: Record<string, unknown>) =>
	(agentTools[name] as unknown as { execute: Exec }).execute(args, {
		toolCallId: "t",
		messages: [],
	});

const SECRET = "TOPSECRETXYZZY";

function setup(): { ws: string; outside: string } {
	const ws = tempDir("mkpdf-confine-ws-");
	const outside = tempDir("mkpdf-confine-out-");
	setToolContext({ ...priorContext, workingDirectory: ws, createdFiles: new CreatedFiles() });
	return { ws, outside };
}

const pdfsInCreative = () =>
	fs.existsSync(CREATIVE_DIR) ? fs.readdirSync(CREATIVE_DIR).filter((f) => f.endsWith(".pdf")) : [];

/** make_pdf refuses the path, read_file refuses it too, and no new PDF appears. */
async function expectRefusedLikeReadFile(p: string, key: "mdPath" | "htmlPath" = "mdPath") {
	const before = pdfsInCreative();
	const out = JSON.parse(await run("make_pdf", { [key]: p, outName: `leak-${key}` }));
	expect(out.error).toMatch(/make_pdf failed/);
	expect(out.path).toBeUndefined();
	expect(JSON.stringify(out)).not.toContain(SECRET);
	const read = await run("read_file", { path: p });
	expect(read).toContain("Nothing was read");
	expect(read).not.toContain(SECRET);
	expect(pdfsInCreative()).toEqual(before);
	return out.error as string;
}

describe("make_pdf file sources stay inside the workspace", () => {
	test("refuses an absolute path outside the workspace", async () => {
		const { outside } = setup();
		const target = path.join(outside, "notes.md");
		fs.writeFileSync(target, `# ${SECRET}`);
		for (const key of ["mdPath", "htmlPath"] as const) {
			expect(await expectRefusedLikeReadFile(target, key)).toMatch(/outside/);
		}
	});

	test("refuses a relative path that climbs out", async () => {
		const { ws } = setup();
		const name = `climb-4272-${process.pid}.md`;
		const sibling = path.join(ws, "..", name);
		fs.writeFileSync(sibling, `# ${SECRET}`);
		try {
			expect(await expectRefusedLikeReadFile(`../${name}`)).toMatch(/outside/);
		} finally {
			fs.rmSync(sibling, { force: true });
		}
	});

	test("refuses a symlink inside the workspace that escapes it", async () => {
		const { ws, outside } = setup();
		fs.writeFileSync(path.join(outside, "real.md"), `# ${SECRET}`);
		fs.symlinkSync(path.join(outside, "real.md"), path.join(ws, "link.md"));
		fs.symlinkSync(outside, path.join(ws, "dirlink"));
		expect(await expectRefusedLikeReadFile("link.md")).toMatch(/symlink/);
		expect(await expectRefusedLikeReadFile("dirlink/real.md", "htmlPath")).toMatch(/symlink/);
	});

	test("refuses a credential file, outside the workspace and inside it", async () => {
		const { ws, outside } = setup();
		// 8SO's reproduction: a fake credentials file outside the workspace.
		fs.writeFileSync(path.join(outside, "credentials"), `# ${SECRET}`);
		expect(await expectRefusedLikeReadFile(path.join(outside, "credentials"))).toMatch(
			/credential/,
		);
		// Credential-pattern names are refused even inside the workspace.
		fs.writeFileSync(path.join(ws, "credentials"), `# ${SECRET}`);
		fs.writeFileSync(path.join(ws, "id_rsa"), `# ${SECRET}`);
		expect(await expectRefusedLikeReadFile("credentials")).toMatch(/credential/);
		expect(await expectRefusedLikeReadFile("id_rsa", "htmlPath")).toMatch(/credential/);
	});

	test("refuses ~ paths that land outside the workspace, before any read", async () => {
		setup();
		// No file is planted in the real home: the refusal must come from the
		// confinement check, before existence is ever looked at.
		const name = `home-4272-${process.pid}.md`;
		const err = await expectRefusedLikeReadFile(`~/${name}`);
		expect(err).toMatch(/outside/);
		expect(err).not.toMatch(/not found/);
		expect(await expectRefusedLikeReadFile("~", "htmlPath")).toMatch(/outside/);
	});

	test("still renders a file inside the workspace, relative or absolute", async () => {
		const { ws } = setup();
		fs.writeFileSync(path.join(ws, "brief.md"), "# Inside brief\n\nbody");
		const rel = JSON.parse(await run("make_pdf", { mdPath: "brief.md", outName: "inside-rel" }));
		const abs = JSON.parse(
			await run("make_pdf", { mdPath: path.join(ws, "brief.md"), outName: "inside-abs" }),
		);
		try {
			expect(rel.error).toBeUndefined();
			expect(rel.path).toBe(path.join(CREATIVE_DIR, "inside-rel.pdf"));
			expect(abs.path).toBe(path.join(CREATIVE_DIR, "inside-abs.pdf"));
		} finally {
			for (const r of [rel, abs]) if (r.path) fs.rmSync(r.path, { force: true });
		}
	});

	test("makePdf with a file source and no workspace root reads nothing", async () => {
		const { ws } = setup();
		fs.writeFileSync(path.join(ws, "x.md"), `# ${SECRET}`);
		await expect(makePdf({ mdPath: path.join(ws, "x.md") })).rejects.toThrow(/workspace root/);
	});
});
