/**
 * #3107: write_file ran macOS `open` on every file it wrote, source files and
 * sub-agent writes included (7 editor windows from one llama3.2:3b sub-agent
 * in pilot run 2026-09-30_070309), and always said "opened". It now opens
 * only viewable deliverables, interactively, never from a spawned sub-agent,
 * once per path per turn, and says "opened" only when it did.
 *
 * `open` itself is stubbed on PATH (see below), so no window ever appears
 * while these tests run, on the old code or the new.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";

// Remove the temp dirs tempDir() has recorded, this file's included (#3285).
afterAll(cleanupTempDirs);

// Stub `open` at the OS level: a fake `open` first on PATH that only records
// its argument. Whatever way the code under test reaches child_process
// (static import, dynamic import, require), the real /usr/bin/open never runs
// and no window can appear, on the old code or the new.
const stubBin = tempDir("open-stub-");
const openLog = path.join(stubBin, "opened.log");
fs.writeFileSync(path.join(stubBin, "open"), `#!/bin/sh\necho "$1" >> "${openLog}"\n`, { mode: 0o755 });
process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`;
// Marp decks otherwise render a narrated deck.mp4 on write.
process.env.EIGHT_DECK_VIDEO = "0";

/** The paths the stub `open` received (it runs detached, so allow it a moment). */
async function openedPaths(expectAtLeast = 0): Promise<string[]> {
	for (let i = 0; i < 40; i++) {
		const lines = fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf-8").split("\n").filter(Boolean) : [];
		if (lines.length >= expectAtLeast && (expectAtLeast > 0 || i >= 10)) return lines;
		await Bun.sleep(25);
	}
	return fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf-8").split("\n").filter(Boolean) : [];
}

const { ToolExecutor } = await import("./tools");
const { decideOpenOnWrite, isDocumentMarkdown } = await import("./open-on-write");

const realPlatform = process.platform;
// Save the descriptor, not the value: on a non-TTY stdout (CI) isTTY has no
// own property, and defineProperty would create a non-writable one that makes
// a later plain assignment in another test file throw (#3287).
const realTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const setStdoutTTY = (value: boolean) =>
	Object.defineProperty(process.stdout, "isTTY", { value, writable: true, configurable: true });
const realNoOpen = process.env.EIGHT_NO_OPEN;

beforeEach(() => {
	fs.rmSync(openLog, { force: true });
	// An interactive macOS session: the only place opening is allowed at all.
	Object.defineProperty(process, "platform", { value: "darwin" });
	setStdoutTTY(true);
	delete process.env.EIGHT_NO_OPEN;
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform });
	if (realTTY) Object.defineProperty(process.stdout, "isTTY", realTTY);
	else Reflect.deleteProperty(process.stdout, "isTTY");
	if (realNoOpen === undefined) delete process.env.EIGHT_NO_OPEN;
	else process.env.EIGHT_NO_OPEN = realNoOpen;
});

const workdir = () => tempDir("open-on-write-");
const MARP = "---\nmarp: true\ntheme: default\n---\n\n# Slide 1\n";

describe("write_file opens only deliverables (#3107)", () => {
	test("a source file is written, never opened, and the result does not say opened", async () => {
		const dir = workdir();
		const ex = new ToolExecutor(dir);
		for (const [p, c] of [
			["src/clamp.ts", "export const x = 1;\n"],
			["package.json", "{}\n"],
			["src/app.js", "1;\n"],
			["README.md", "# twofix\n"],
		]) {
			const out = await ex.execute("write_file", { path: p, content: c });
			expect(out).toStartWith(`File written: ${path.join(dir, p)}`);
			expect(out).not.toContain("opened");
		}
		expect(await openedPaths()).toEqual([]);
	});

	test("a viewable deliverable is opened, and the result says so", async () => {
		const dir = workdir();
		const ex = new ToolExecutor(dir);
		const out = await ex.execute("write_file", { path: "report.html", content: "<h1>hi</h1>" });
		expect(out).toStartWith(`File written and opened: ${path.join(dir, "report.html")}`);
		expect(await openedPaths(1)).toEqual([path.join(dir, "report.html")]);
	});

	test("a Marp deck counts as a document; other markdown does not", async () => {
		const dir = workdir();
		const ex = new ToolExecutor(dir);
		await ex.execute("write_file", { path: "deck/deck.md", content: MARP });
		await ex.execute("write_file", { path: "deck/outline.md", content: "# Outline\n- a\n" });
		expect(await openedPaths(1)).toEqual([path.join(dir, "deck", "deck.md")]);
	});

	test("the same path opens at most once per turn, and again next turn", async () => {
		const dir = workdir();
		const ex = new ToolExecutor(dir);
		const a = await ex.execute("write_file", { path: "chart.svg", content: "<svg/>" });
		const b = await ex.execute("write_file", { path: "chart.svg", content: "<svg></svg>" });
		expect(a).toContain("File written and opened");
		expect(b).toStartWith("File written: ");
		expect(await openedPaths(1)).toHaveLength(1);
		ex.beginTurn();
		await ex.execute("write_file", { path: "chart.svg", content: "<svg/>" });
		expect(await openedPaths(2)).toHaveLength(2);
	});

	test("never from a spawned sub-agent", async () => {
		const ex = new ToolExecutor(workdir(), "primary", undefined, { openOnWrite: false });
		const out = await ex.execute("write_file", { path: "report.html", content: "<h1>hi</h1>" });
		expect(out).toStartWith("File written: ");
		expect(await openedPaths()).toEqual([]);
	});

	test("never when not interactive: no TTY, or EIGHT_NO_OPEN=1", async () => {
		setStdoutTTY(false);
		await new ToolExecutor(workdir()).execute("write_file", { path: "a.pdf", content: "%PDF" });
		setStdoutTTY(true);
		process.env.EIGHT_NO_OPEN = "1";
		const out = await new ToolExecutor(workdir()).execute("write_file", { path: "a.png", content: "x" });
		expect(out).toStartWith("File written: ");
		expect(await openedPaths()).toEqual([]);
	});
});

describe("decideOpenOnWrite", () => {
	const base = {
		absolutePath: "/w/out.pdf",
		content: "",
		platform: "darwin" as NodeJS.Platform,
		openOnWrite: true,
		isTTY: true,
		env: {},
		openedThisTurn: new Set<string>(),
	};
	test("each rule on its own", () => {
		expect(decideOpenOnWrite(base).open).toBe(true);
		expect(decideOpenOnWrite({ ...base, platform: "linux" }).open).toBe(false);
		expect(decideOpenOnWrite({ ...base, env: { EIGHT_NO_OPEN: "1" } }).reason).toBe("EIGHT_NO_OPEN=1");
		expect(decideOpenOnWrite({ ...base, isTTY: false }).open).toBe(false);
		expect(decideOpenOnWrite({ ...base, openOnWrite: false }).reason).toBe("spawned sub-agent");
		expect(decideOpenOnWrite({ ...base, absolutePath: "/w/x.json" }).open).toBe(false);
		expect(decideOpenOnWrite({ ...base, openedThisTurn: new Set(["/w/out.pdf"]) }).open).toBe(false);
		for (const ext of [".html", ".htm", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".mp4", ".mov", ".pptx", ".docx", ".PDF"]) {
			expect(decideOpenOnWrite({ ...base, absolutePath: `/w/f${ext}` }).open).toBe(true);
		}
	});
	test("isDocumentMarkdown reads front matter only", () => {
		expect(isDocumentMarkdown(MARP)).toBe(true);
		expect(isDocumentMarkdown("# Title\n\nmarp: true\n")).toBe(false);
		expect(isDocumentMarkdown("---\ntitle: x\n---\n")).toBe(false);
	});
});

describe("the agent pool builds sub-agents that never open files", () => {
	test("pool agents get openOnWrite: false", async () => {
		const configs: Array<Record<string, unknown>> = [];
		mock.module("../eight", () => ({
			Agent: class {
				constructor(config: Record<string, unknown>) {
					configs.push(config);
				}
				async isReady() {
					return false;
				}
			},
		}));
		const { AgentPool } = await import("../orchestration");
		const pool = new AgentPool(1);
		await pool.spawnAgent("x", { workingDirectory: workdir() });
		for (let i = 0; i < 100 && configs.length === 0; i++) await Bun.sleep(10);
		expect(configs[0]?.openOnWrite).toBe(false);
	});
});
