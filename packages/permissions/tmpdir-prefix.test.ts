import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluatePolicy, sessionScratchDir } from "./policy-engine";
import { checkFilePathBoundary } from "./src/workspace-boundary";

// #4488: the shared system temp dir is not a default writable prefix.
// Everything lives under a private realpath'd root so the test never depends
// on the host's real os.tmpdir() layout.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmp-prefix-")));
const WORKSPACE = path.join(ROOT, "ws");
const SHARED_TMP = path.join(ROOT, "shared-tmp"); // stands in for /tmp
const MAC_TMP_LINK = path.join(ROOT, "var-link"); // stands in for /var -> /private/var
const DATA_DIR = path.join(ROOT, "data");
const SAVED_DATA = process.env.EIGHT_DATA_DIR;
const SAVED_WS = process.env.EIGHT_WORKSPACE_ROOT;

beforeAll(() => {
	for (const d of [WORKSPACE, SHARED_TMP, DATA_DIR]) fs.mkdirSync(d, { recursive: true });
	fs.symlinkSync(SHARED_TMP, MAC_TMP_LINK);
	process.env.EIGHT_DATA_DIR = DATA_DIR;
	process.env.EIGHT_WORKSPACE_ROOT = WORKSPACE;
});

afterAll(() => {
	if (SAVED_DATA === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = SAVED_DATA;
	if (SAVED_WS === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
	else process.env.EIGHT_WORKSPACE_ROOT = SAVED_WS;
	fs.rmSync(ROOT, { recursive: true, force: true });
});

const write = (p: string, sessionId = "s-4488") =>
	evaluatePolicy("write_file", { path: p, workspaceRoot: WORKSPACE, sessionId } as never);

describe("default allowed prefixes exclude the system temp dir (#4488)", () => {
	test("a write under os.tmpdir() outside the scratch dir is refused", async () => {
		const target = path.join(fs.realpathSync(os.tmpdir()), `x-4488-${process.pid}.txt`);
		const d = await write(target);
		expect(d.allowed).toBe(false);
		expect("reason" in d && d.reason).toContain("[workspace-boundary]");
	});

	test("a symlinked temp path (the macOS /var layout) is refused too", async () => {
		const d = await write(path.join(MAC_TMP_LINK, "x.txt"));
		expect(d.allowed).toBe(false);
		expect("reason" in d && d.reason).toContain("[workspace-boundary]");
	});

	test("a write inside the session scratch dir is allowed", async () => {
		const dir = sessionScratchDir("s-4488");
		expect(dir).toBe(path.join(DATA_DIR, "scratch", "s-4488"));
		const d = await write(path.join(dir, "note.txt"));
		expect("reason" in d ? d.reason : "").not.toContain("[workspace-boundary]");
	});

	test("the scratch dir is created 0700 and is per session", () => {
		const a = sessionScratchDir("s-a");
		const b = sessionScratchDir("s-b");
		expect(a).not.toBe(b);
		if (process.platform !== "win32") expect(fs.statSync(a).mode & 0o777).toBe(0o700);
	});

	test("a hostile session id cannot escape the scratch root", () => {
		const dir = sessionScratchDir("../../etc");
		expect(path.dirname(dir)).toBe(path.join(DATA_DIR, "scratch"));
	});
});

describe("prefixes are realpath'd before comparing", () => {
	test("a symlinked prefix matches a realpath'd candidate", () => {
		const r = checkFilePathBoundary(path.join(SHARED_TMP, "a.txt"), WORKSPACE, [MAC_TMP_LINK]);
		expect(r.allowed).toBe(true);
	});

	test("a symlinked candidate matches a realpath'd prefix", () => {
		const r = checkFilePathBoundary(path.join(MAC_TMP_LINK, "a.txt"), WORKSPACE, [SHARED_TMP]);
		expect(r.allowed).toBe(true);
	});

	test("a prefix that does not exist yet still works", () => {
		const prefix = path.join(MAC_TMP_LINK, "later");
		const r = checkFilePathBoundary(path.join(SHARED_TMP, "later", "a.txt"), WORKSPACE, [prefix]);
		expect(r.allowed).toBe(true);
	});

	test("an unlisted symlinked path is still refused", () => {
		const r = checkFilePathBoundary(path.join(MAC_TMP_LINK, "a.txt"), WORKSPACE, []);
		expect(r.allowed).toBe(false);
	});
});
