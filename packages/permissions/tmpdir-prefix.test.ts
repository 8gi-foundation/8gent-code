import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluatePolicy, policyScratchDir } from "./policy-engine";
import { destroySessionScratch, sessionScratchDir as seatbeltScratchDir } from "./seatbelt";
import { scratchDirPath } from "./session-scratch";
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
		const dir = policyScratchDir("s-4488") as string;
		expect(dir).toBe(fs.realpathSync(scratchDirPath("s-4488")));
		expect(path.dirname(dir)).toBe(path.join(DATA_DIR, "scratch"));
		const d = await write(path.join(dir, "note.txt"));
		expect("reason" in d ? d.reason : "").not.toContain("[workspace-boundary]");
	});

	test("the scratch dir is created 0700 and is per session", () => {
		const a = policyScratchDir("s-a") as string;
		const b = policyScratchDir("s-b") as string;
		expect(a).not.toBe(b);
		if (process.platform !== "win32") expect(fs.statSync(a).mode & 0o777).toBe(0o700);
	});

	test("a hostile session id cannot escape the scratch root", () => {
		const dir = policyScratchDir("../../etc") as string;
		expect(path.dirname(dir)).toBe(path.join(DATA_DIR, "scratch"));
	});
});

describe("prefixes are not realpath'd (no widening)", () => {
	test("a prefix that is a symlink does not pull its target in", () => {
		const r = checkFilePathBoundary(path.join(SHARED_TMP, "a.txt"), WORKSPACE, [MAC_TMP_LINK]);
		expect(r.allowed).toBe(false);
	});

	test("a candidate under the symlink path itself resolves to the target and is refused", () => {
		const r = checkFilePathBoundary(path.join(MAC_TMP_LINK, "a.txt"), WORKSPACE, [MAC_TMP_LINK]);
		expect(r.allowed).toBe(false);
	});

	test("a plain absolute prefix still allows its subtree", () => {
		const r = checkFilePathBoundary(path.join(SHARED_TMP, "a.txt"), WORKSPACE, [SHARED_TMP]);
		expect(r.allowed).toBe(true);
	});

	test("a relative prefix resolves against the workspace root", () => {
		const r = checkFilePathBoundary(path.join(WORKSPACE, "sub", "a.txt"), WORKSPACE, ["sub"]);
		expect(r.allowed).toBe(true);
	});
});

describe("scratch dir is verified, fail closed", () => {
	test("a planted scratch symlink is refused and does not widen the allow-list", async () => {
		const dd = path.join(ROOT, "evil-data");
		fs.mkdirSync(dd);
		fs.symlinkSync("/", path.join(dd, "scratch"));
		const saved = process.env.EIGHT_DATA_DIR;
		process.env.EIGHT_DATA_DIR = dd;
		try {
			expect(policyScratchDir("victim")).toBeNull();
			const d = await write("/etc/hosts", "victim");
			expect(d.allowed).toBe(false);
			expect("reason" in d && d.reason).toContain("[workspace-boundary]");
		} finally {
			process.env.EIGHT_DATA_DIR = saved;
		}
	});

	test("a symlinked session dir is refused", () => {
		const key = path.basename(scratchDirPath("linked"));
		fs.mkdirSync(path.join(DATA_DIR, "scratch"), { recursive: true });
		fs.symlinkSync(SHARED_TMP, path.join(DATA_DIR, "scratch", key));
		expect(policyScratchDir("linked")).toBeNull();
	});

	test("a pre-existing 0755 session dir is tightened to 0700", () => {
		const p = scratchDirPath("loose");
		fs.mkdirSync(p, { recursive: true });
		fs.chmodSync(p, 0o755);
		const dir = policyScratchDir("loose") as string;
		expect(dir).not.toBeNull();
		if (process.platform !== "win32") expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	});

	test("a dir that vanished is recreated, not served from cache", () => {
		const dir = policyScratchDir("vanish") as string;
		fs.rmSync(dir, { recursive: true });
		const again = policyScratchDir("vanish") as string;
		expect(fs.statSync(again).isDirectory()).toBe(true);
	});
});

describe("session ids do not collide", () => {
	test("a.b, a_b and a/b get different dirs", () => {
		const dirs = new Set(["a.b", "a_b", "a/b", "a\u00e9", "a_"].map((i) => policyScratchDir(i)));
		expect(dirs.size).toBe(5);
	});

	test("two 65-char ids differing at the end get different dirs", () => {
		const base = "x".repeat(64);
		expect(policyScratchDir(`${base}1`)).not.toBe(policyScratchDir(`${base}2`));
	});

	test("the same id always maps to the same dir", () => {
		expect(policyScratchDir("same")).toBe(policyScratchDir("same"));
	});
});

describe("sessions without an id", () => {
	test("empty and missing ids share the per-process dir, not the pid, and differ from a real id", () => {
		const e = policyScratchDir("") as string;
		expect(policyScratchDir(undefined)).toBe(e);
		expect(e).not.toBe(policyScratchDir("x"));
		expect(path.basename(e)).not.toBe(String(process.pid));
		expect(path.basename(e)).not.toContain(String(process.pid));
	});
});

describe("seatbelt and policy agree on one scratch dir", () => {
	test("the seatbelt work dir is the policy scratch dir and policy allows a path inside it", async () => {
		const id = `sb-${process.pid}`;
		const work = seatbeltScratchDir(id);
		expect(work).toBe(policyScratchDir(id) as string);
		expect(work.startsWith(os.tmpdir())).toBe(false);
		fs.writeFileSync(path.join(work, "out.txt"), "x");
		const d = await write(path.join(work, "out.txt"), id);
		expect("reason" in d ? d.reason : "").not.toContain("[workspace-boundary]");
		destroySessionScratch(id);
		expect(fs.existsSync(work)).toBe(false);
	});

	test("a pre-created 0755 seatbelt work dir is tightened to 0700", () => {
		const id = `sb-loose-${process.pid}`;
		const p = scratchDirPath(id);
		fs.mkdirSync(p, { recursive: true });
		fs.chmodSync(p, 0o755);
		const work = seatbeltScratchDir(id);
		if (process.platform !== "win32") expect(fs.statSync(work).mode & 0o777).toBe(0o700);
	});
});
