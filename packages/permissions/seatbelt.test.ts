/**
 * Seatbelt sandbox tests (issue #2756 step 2).
 *
 * Profile generation, the capability-manifest bridge, and per-session
 * scratch dirs are pure and run on every platform. The live enforcement
 * suite runs only where the kernel can actually enforce it (macOS with
 * /usr/bin/sandbox-exec) and proves the epic's done-criterion at the OS
 * layer: a command cannot read the credential store even when its
 * manifest scope covers it, cannot write outside its work dir, and
 * cannot reach the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetToolManifests } from "./capability-manifest";
import { runSandboxed } from "./sandbox";
import {
	buildSeatbeltProfile,
	destroySessionScratch,
	isSeatbeltAvailable,
	seatbeltSpecForTool,
	sensitiveCredentialPaths,
	sessionScratchDir,
} from "./seatbelt";

// Real on-disk fixtures. realpathSync everywhere: on macOS os.tmpdir()
// returns a /var symlink but the kernel matches real paths.
const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-workspace-")));
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-outside-")));
const FAKE_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-home-")));
const SSH_KEY = path.join(FAKE_HOME, ".ssh", "id_ed25519");

beforeAll(() => {
	fs.writeFileSync(path.join(WORKSPACE, "hello.txt"), "workspace file");
	fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "outside-secret");
	fs.mkdirSync(path.dirname(SSH_KEY), { recursive: true });
	fs.writeFileSync(SSH_KEY, "PRIVATE KEY MATERIAL");
	process.env.EIGHT_FAKE_HOME = FAKE_HOME;
});

afterAll(() => {
	delete process.env.EIGHT_FAKE_HOME;
	resetToolManifests();
	for (const dir of [WORKSPACE, OUTSIDE, FAKE_HOME]) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ============================================
// Profile generation (pure, every platform)
// ============================================

describe("buildSeatbeltProfile", () => {
	test("denies by default and allows the work dir", () => {
		const profile = buildSeatbeltProfile({ workDir: WORKSPACE });
		expect(profile.startsWith("(version 1)\n(deny default)")).toBe(true);
		expect(profile).toContain(`(allow file-read* file-write* (subpath "${WORKSPACE}"))`);
	});

	test("network is denied unless explicitly allowed", () => {
		const closed = buildSeatbeltProfile({ workDir: WORKSPACE });
		expect(closed).toContain("(deny network*)");
		expect(closed).not.toContain("(allow network*)");

		const open = buildSeatbeltProfile({ workDir: WORKSPACE, allowNetwork: true });
		expect(open).toContain("(allow network*)");
		expect(open).not.toContain("(deny network*)");
	});

	test("sensitive credential denies come AFTER every allow so they win", () => {
		const profile = buildSeatbeltProfile({
			workDir: WORKSPACE,
			readPaths: [FAKE_HOME],
			writePaths: [OUTSIDE],
		});
		const sshDeny = profile.indexOf(path.join(FAKE_HOME, ".ssh"));
		const lastAllow = profile.lastIndexOf("(allow ");
		expect(sshDeny).toBeGreaterThan(-1);
		expect(sshDeny).toBeGreaterThan(lastAllow);
	});

	test("manifest read scopes are read-only, write scopes read/write", () => {
		const profile = buildSeatbeltProfile({
			workDir: WORKSPACE,
			readPaths: ["/one/read"],
			writePaths: ["/two/write"],
		});
		expect(profile).toContain(`(allow file-read* (subpath "/one/read"))`);
		expect(profile).toContain(`(allow file-read* file-write* (subpath "/two/write"))`);
	});

	test("escapes quotes in paths so a crafted dir name cannot break the profile", () => {
		const profile = buildSeatbeltProfile({ workDir: '/tmp/evil") (allow default) ("' });
		expect(profile).toContain('\\"');
		expect(profile).not.toContain('(subpath "/tmp/evil")');
	});

	test("rejects relative work dirs", () => {
		expect(() => buildSeatbeltProfile({ workDir: "relative/dir" })).toThrow(/absolute/);
	});

	test("default deny list covers the classic credential stores", () => {
		// Other test files in this package set EIGHT_DATA_DIR; pin it here
		// so the expected key-store path is deterministic.
		const savedDataDir = process.env.EIGHT_DATA_DIR;
		delete process.env.EIGHT_DATA_DIR;
		try {
			const paths = sensitiveCredentialPaths();
			expect(paths).toContain(path.join(FAKE_HOME, ".ssh"));
			expect(paths).toContain(path.join(FAKE_HOME, ".aws"));
			expect(paths).toContain(path.join(FAKE_HOME, ".8gent", "keys"));
		} finally {
			if (savedDataDir !== undefined) process.env.EIGHT_DATA_DIR = savedDataDir;
		}
	});
});

// ============================================
// Capability-manifest bridge (pure, every platform)
// ============================================

describe("seatbeltSpecForTool", () => {
	test("derives scopes from the tool's manifest", () => {
		const spec = seatbeltSpecForTool("run_command", WORKSPACE);
		expect(spec).toBeDefined();
		expect(spec!.workDir).toBe(WORKSPACE);
		// run_command declares read+write on ${workspace} and ${tmp}
		expect(spec!.readPaths).toContain(WORKSPACE);
		expect(spec!.writePaths).toContain(WORKSPACE);
		expect(spec!.allowNetwork).toBe(false);
	});

	test("returns undefined for an unmanifested tool - deny by default", () => {
		expect(seatbeltSpecForTool("totally_unknown_tool", WORKSPACE)).toBeUndefined();
	});
});

// ============================================
// Per-session scratch dirs (every platform)
// ============================================

describe("session scratch dirs", () => {
	test("created once, reused across calls, destroyed on demand", () => {
		const id = `test-${process.pid}-${Date.now()}`;
		const first = sessionScratchDir(id);
		fs.writeFileSync(path.join(first, "state.txt"), "persists");

		const second = sessionScratchDir(id);
		expect(second).toBe(first);
		expect(fs.readFileSync(path.join(second, "state.txt"), "utf8")).toBe("persists");

		destroySessionScratch(id);
		expect(fs.existsSync(first)).toBe(false);
	});

	test("rejects session ids that could traverse paths", () => {
		expect(() => sessionScratchDir("../evil")).toThrow(/invalid session id/);
		expect(() => sessionScratchDir("a/b")).toThrow(/invalid session id/);
		expect(() => sessionScratchDir("")).toThrow(/invalid session id/);
	});
});

// ============================================
// Live kernel enforcement (macOS only)
// ============================================

const live = isSeatbeltAvailable();

describe.if(live)("seatbelt live enforcement (macOS)", () => {
	test("commands run and produce output inside the sandbox", async () => {
		const result = await runSandboxed("echo hello-from-seatbelt", {
			isolation: "seatbelt",
			workDir: WORKSPACE,
		});
		expect(result.isolation).toBe("seatbelt");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello-from-seatbelt");
	});

	test("can read and write inside the work dir", async () => {
		const result = await runSandboxed("cat hello.txt && echo written > out.txt && cat out.txt", {
			isolation: "seatbelt",
			workDir: WORKSPACE,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("workspace file");
		expect(result.stdout).toContain("written");
	});

	test("cannot read files outside its declared scopes", async () => {
		const result = await runSandboxed(`cat ${OUTSIDE}/secret.txt`, {
			isolation: "seatbelt",
			workDir: WORKSPACE,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("outside-secret");
	});

	test("cannot write outside its declared scopes", async () => {
		const target = path.join(OUTSIDE, "escaped.txt");
		const result = await runSandboxed(`echo escaped > ${target}`, {
			isolation: "seatbelt",
			workDir: WORKSPACE,
		});
		expect(result.exitCode).not.toBe(0);
		expect(fs.existsSync(target)).toBe(false);
	});

	test("granted read scopes actually work (positive control for the deny test)", async () => {
		fs.writeFileSync(path.join(FAKE_HOME, "notes.txt"), "plain home file");
		const result = await runSandboxed(`cat ${path.join(FAKE_HOME, "notes.txt")}`, {
			isolation: "seatbelt",
			workDir: WORKSPACE,
			readPaths: [FAKE_HOME],
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("plain home file");
	});

	test("cannot read the SSH key even when the manifest granted the home scope", async () => {
		// The epic's done-criterion: the deny rules sit BELOW the allow for
		// the whole fake home, and the kernel lets the deny win.
		const result = await runSandboxed(`cat ${SSH_KEY}`, {
			isolation: "seatbelt",
			workDir: WORKSPACE,
			readPaths: [FAKE_HOME],
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("PRIVATE KEY MATERIAL");
	});

	test("network is unreachable when not granted", async () => {
		// nc to a public resolver IP: no DNS involved, the kernel refuses
		// the socket immediately, so this is fast and offline-safe.
		const result = await runSandboxed("/usr/bin/nc -z -w 1 1.1.1.1 53", {
			isolation: "seatbelt",
			workDir: WORKSPACE,
		});
		expect(result.exitCode).not.toBe(0);
	});

	test("session scratch dir persists state across sandboxed runs", async () => {
		const id = `live-${process.pid}-${Date.now()}`;
		try {
			const write = await runSandboxed("echo carried > note.txt", {
				isolation: "seatbelt",
				sessionId: id,
			});
			expect(write.exitCode).toBe(0);

			const read = await runSandboxed("cat note.txt", {
				isolation: "seatbelt",
				sessionId: id,
			});
			expect(read.exitCode).toBe(0);
			expect(read.stdout.trim()).toBe("carried");
		} finally {
			destroySessionScratch(id);
		}
	});
});
