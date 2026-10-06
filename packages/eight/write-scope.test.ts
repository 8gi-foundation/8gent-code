/**
 * #3580: in pilot run 2026-10-06_201858/media-brief-video the request said
 * "put everything in video/". The model wrote video/slides.md and
 * video/narration.txt, then a new build_video.sh in the top folder, and the
 * write result gave no hint. write_file now says so, once, on both tool paths.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { writeScopeLine } from "../ai/write-scope";
import { CreatedFiles } from "../permissions/s1-created-files";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const LINE =
	"Scope: build_video.sh is a new file in the top folder, but every other file you created is in video/. " +
	"If the request put the work in video/, write it there instead (helper scripts too) and remove this one.";

describe("writeScopeLine", () => {
	const W = "/w";
	const at = (rel: string) => path.join(W, rel);

	test("the pilot's sequence: two files in video/, then a new script in the top folder", () => {
		const s = new CreatedFiles();
		expect(writeScopeLine(s, W, at("video/slides.md"), true)).toBe("");
		expect(writeScopeLine(s, W, at("video/narration.txt"), true)).toBe("");
		expect(writeScopeLine(s, W, at("build_video.sh"), true)).toBe(LINE);
		// One nudge: the record now spans two places, so a second root file is quiet.
		expect(writeScopeLine(s, W, at("notes.txt"), true)).toBe("");
	});

	test("rewriting an existing top-folder file is not flagged", () => {
		const s = new CreatedFiles();
		writeScopeLine(s, W, at("video/a.md"), true);
		writeScopeLine(s, W, at("video/b.md"), true);
		expect(writeScopeLine(s, W, at("README.md"), false)).toBe("");
	});

	test("one earlier file is not yet a work folder", () => {
		const s = new CreatedFiles();
		writeScopeLine(s, W, at("video/a.md"), true);
		expect(writeScopeLine(s, W, at("build.sh"), true)).toBe("");
	});

	test("work spread over several folders, or started in the top folder, is not flagged", () => {
		const spread = new CreatedFiles();
		writeScopeLine(spread, W, at("src/a.ts"), true);
		writeScopeLine(spread, W, at("tests/a.test.ts"), true);
		expect(writeScopeLine(spread, W, at("package.json"), true)).toBe("");
		const top = new CreatedFiles();
		writeScopeLine(top, W, at("index.html"), true);
		writeScopeLine(top, W, at("style.css"), true);
		expect(writeScopeLine(top, W, at("app.js"), true)).toBe("");
	});

	test("a new file in another folder, or outside the working directory, is not flagged", () => {
		const s = new CreatedFiles();
		writeScopeLine(s, W, at("video/a.md"), true);
		writeScopeLine(s, W, at("video/b.md"), true);
		expect(writeScopeLine(s, W, at("scripts/build.sh"), true)).toBe("");
		expect(writeScopeLine(s, W, "/elsewhere/x.sh", true)).toBe("");
	});

	test("no session record, no line", () => {
		expect(writeScopeLine(undefined, W, at("build.sh"), true)).toBe("");
	});
});

describe("write_file reports scope on both tool paths", () => {
	const pilot = async (write: (p: string, c: string) => Promise<string>) => {
		await write("video/slides.md", "# Tide Library\n---\n# What it is\n");
		await write("video/narration.txt", "Welcome.\nIt lends tools.\n");
		return write("build_video.sh", "#!/bin/sh\necho ok\n");
	};

	test("ToolExecutor (text-tool and local providers)", async () => {
		const dir = tempDir("write-scope-");
		const ex = new ToolExecutor(dir);
		const out = await pilot((p, c) => ex.execute("write_file", { path: p, content: c }));
		expect(out).toStartWith(`File written: ${path.join(dir, "build_video.sh")}`);
		expect(out).toContain(`\n${LINE}`);
		// A second write of the same script is a rewrite: no repeat.
		const again = await ex.execute("write_file", {
			path: "build_video.sh",
			content: "#!/bin/sh\n",
		});
		expect(again).not.toContain("Scope:");
	});

	test("AI SDK registry", async () => {
		const dir = tempDir("write-scope-");
		const before = getToolContext();
		setToolContext({ ...before, workingDirectory: dir, createdFiles: new CreatedFiles() });
		try {
			const out = await pilot(
				async (p, c) =>
					(await agentTools.write_file.execute?.(
						{ path: p, content: c },
						{ toolCallId: "t", messages: [] },
					)) as string,
			);
			expect(out).toContain(`\n${LINE}`);
			expect(fs.existsSync(path.join(dir, "build_video.sh"))).toBe(true);
		} finally {
			setToolContext(before);
		}
	});

	test("files written into the work folder keep their result unchanged", async () => {
		const dir = tempDir("write-scope-");
		const ex = new ToolExecutor(dir);
		await ex.execute("write_file", { path: "video/a.md", content: "a\n" });
		await ex.execute("write_file", { path: "video/b.md", content: "b\n" });
		const out = await ex.execute("write_file", { path: "video/build.sh", content: "#!/bin/sh\n" });
		expect(out).toBe(`File written: ${path.join(dir, "video/build.sh")}`);
	});
});
