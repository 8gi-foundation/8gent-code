/**
 * ArtifactStore tests.
 *
 * Issue: 8gi-foundation/8gent-code#2463.
 *
 * Concept extracted from StartupHakk/OpenMonoAgent under CleanRoomPort
 * rules; no AGPL source copied. Behaviour rebuilt from the issue spec
 * and the 8DO chip-format amendment (2026-05-09 boardroom).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../artifact-store";

// ---- Test scaffolding -----------------------------------------------------

let tmpRoot: string;
let dataDir: string;

function makeTmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "artifact-store-test-"));
}

function readFileUtf8(p: string): string {
	return fs.readFileSync(p, "utf8");
}

beforeEach(() => {
	tmpRoot = makeTmpRoot();
	dataDir = path.join(tmpRoot, "artifacts");
	// Point PathGuard's protected-dir root at the tmp tree so the symlink
	// fixture below tests behaviour against a fake ~/.ssh, not the real one.
	process.env.EIGHT_FAKE_HOME = tmpRoot;
});

afterEach(() => {
	delete process.env.EIGHT_FAKE_HOME;
	delete process.env.ARTIFACT_THRESHOLD;
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// ---- AC 1: under threshold passes through --------------------------------

describe("ArtifactStore — pass-through under threshold", () => {
	it("returns the original string unchanged when size < threshold", () => {
		const store = new ArtifactStore("session-a", dataDir, 50_000);
		const small = "x".repeat(1000);
		const out = store.persistAndReplace(small, "read_file");
		expect(out).toBe(small);
		expect(store.size).toBe(0);
		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it("treats result exactly at threshold as still under (boundary)", () => {
		const store = new ArtifactStore("session-a", dataDir, 50_000);
		const exact = "y".repeat(50_000);
		const out = store.persistAndReplace(exact, "grep");
		expect(out).toBe(exact);
		expect(store.size).toBe(0);
	});
});

// ---- AC 2: over threshold persists + returns chip + preview --------------

describe("ArtifactStore — persists over threshold", () => {
	it("writes file under {dataDir}/{sessionId}/ and returns chip + preview", () => {
		const store = new ArtifactStore("session-b", dataDir, 50_000);
		const big = "z".repeat(132 * 1024); // ~132KB
		const out = store.persistAndReplace(big, "run_command");

		// 8DO chip format: [ARTIFACT <hash> <size>] -- short hex prefix,
		// human-readable size, square-bracketed, screen-reader friendly.
		expect(out).toMatch(/^\[ARTIFACT [0-9a-f]{4,12} \d+(?:\.\d+)?KB\]/);

		// Preview block + truncation marker + expand path.
		expect(out).toContain("[truncated; full at ");
		expect(out).toContain(path.join(dataDir, "session-b"));

		// File on disk holds the full original bytes.
		const sessionDir = path.join(dataDir, "session-b");
		const files = fs.readdirSync(sessionDir);
		expect(files.length).toBe(1);
		const stored = readFileUtf8(path.join(sessionDir, files[0]!));
		expect(stored).toBe(big);
		expect(store.size).toBe(1);
	});

	it("preview is at most 1KB of the original content", () => {
		const store = new ArtifactStore("session-b2", dataDir, 50_000);
		// Use distinct head/tail markers so the tail-presence assertion is
		// not accidentally satisfied by a repeating-pattern body.
		const head = "HEAD-MARKER-";
		const tail = "-TAIL-MARKER";
		const body = "x".repeat(80_000);
		const big = head + body + tail;
		const out = store.persistAndReplace(big, "read_file");
		expect(out).toContain(head);
		expect(out).not.toContain(tail);
	});
});

// ---- AC 3: hash prefix stable across runs --------------------------------

describe("ArtifactStore — stable hash for identical content", () => {
	it("same content -> same hash prefix across separate store instances", () => {
		const a = new ArtifactStore("s1", dataDir, 50_000);
		const b = new ArtifactStore("s2", dataDir, 50_000);
		const payload = "stable-content-".repeat(5000); // ~75KB
		const refA = a.persistAndReplace(payload, "read_file");
		const refB = b.persistAndReplace(payload, "read_file");
		const hashA = refA.match(/^\[ARTIFACT ([0-9a-f]+) /)?.[1];
		const hashB = refB.match(/^\[ARTIFACT ([0-9a-f]+) /)?.[1];
		expect(hashA).toBeTruthy();
		expect(hashA).toBe(hashB);
	});
});

// ---- AC 4: failed results never persisted --------------------------------

describe("ArtifactStore — failed results bypass persistence", () => {
	it("does not persist when isError flag is true", () => {
		const store = new ArtifactStore("session-c", dataDir, 50_000);
		const big = "e".repeat(80_000);
		const out = store.persistAndReplace(big, "run_command", { isError: true });
		expect(out).toBe(big);
		expect(store.size).toBe(0);
		expect(fs.existsSync(path.join(dataDir, "session-c"))).toBe(false);
	});
});

// ---- AC 5: idempotent writes for same hash -------------------------------

describe("ArtifactStore — idempotent on repeat", () => {
	it("re-running with identical content reuses the same file (no duplicate writes)", () => {
		const store = new ArtifactStore("session-d", dataDir, 50_000);
		const big = "repeat-".repeat(10_000); // ~70KB
		const ref1 = store.persistAndReplace(big, "read_file");
		const ref2 = store.persistAndReplace(big, "read_file");
		expect(ref1).toBe(ref2);
		const sessionDir = path.join(dataDir, "session-d");
		expect(fs.readdirSync(sessionDir).length).toBe(1);
		expect(store.size).toBe(1);
	});
});

// ---- AC 6: read(hash) returns full original ------------------------------

describe("ArtifactStore — read(hash)", () => {
	it("returns the full original content for a stored hash", async () => {
		const store = new ArtifactStore("session-e", dataDir, 50_000);
		const big = "payload-data-".repeat(5000); // ~65KB
		const ref = store.persistAndReplace(big, "read_file");
		const hash = ref.match(/^\[ARTIFACT ([0-9a-f]+) /)?.[1];
		expect(hash).toBeTruthy();
		const full = await store.read(hash!);
		expect(full).toBe(big);
	});

	it("throws a clear error when the hash is unknown", async () => {
		const store = new ArtifactStore("session-e2", dataDir, 50_000);
		await expect(store.read("deadbeef")).rejects.toThrow(/not found/i);
	});
});

// ---- AC 7: concurrent writes don't collide -------------------------------

describe("ArtifactStore — concurrent writes", () => {
	it("two parallel persists with different content both land on disk", async () => {
		const store = new ArtifactStore("session-f", dataDir, 50_000);
		const a = "AAA".repeat(20_000);
		const b = "BBB".repeat(20_000);
		const [refA, refB] = await Promise.all([
			Promise.resolve(store.persistAndReplace(a, "read_file")),
			Promise.resolve(store.persistAndReplace(b, "grep")),
		]);
		expect(refA).not.toBe(refB);
		const sessionDir = path.join(dataDir, "session-f");
		expect(fs.readdirSync(sessionDir).length).toBe(2);
		expect(store.size).toBe(2);
	});

	it("two parallel persists with identical content collapse to one file", async () => {
		const store = new ArtifactStore("session-f2", dataDir, 50_000);
		const same = "SAME".repeat(20_000);
		await Promise.all([
			Promise.resolve(store.persistAndReplace(same, "read_file")),
			Promise.resolve(store.persistAndReplace(same, "read_file")),
		]);
		const sessionDir = path.join(dataDir, "session-f2");
		expect(fs.readdirSync(sessionDir).length).toBe(1);
	});
});

// ---- 8DO amendment: chip format spec ------------------------------------

describe("ArtifactStore — 8DO chip format (2026-05-09 amendment)", () => {
	it("size renders as KB with no fractional digits for whole-KB payloads", () => {
		const store = new ArtifactStore("session-fmt", dataDir, 50_000);
		const exactly100KB = "x".repeat(100 * 1024);
		const out = store.persistAndReplace(exactly100KB, "read_file");
		expect(out).toMatch(/^\[ARTIFACT [0-9a-f]+ 100KB\]/);
	});

	it("size renders as MB for payloads >= 1MB", () => {
		const store = new ArtifactStore("session-fmt2", dataDir, 50_000);
		const oneMB = "y".repeat(1024 * 1024);
		const out = store.persistAndReplace(oneMB, "read_file");
		expect(out).toMatch(/^\[ARTIFACT [0-9a-f]+ 1(?:\.0)?MB\]/);
	});

	it("hash prefix is 4 to 12 lowercase hex characters", () => {
		const store = new ArtifactStore("session-fmt3", dataDir, 50_000);
		const big = "h".repeat(60_000);
		const out = store.persistAndReplace(big, "read_file");
		const m = out.match(/^\[ARTIFACT ([0-9a-f]+) /);
		expect(m).not.toBeNull();
		const hash = m![1]!;
		expect(hash.length).toBeGreaterThanOrEqual(4);
		expect(hash.length).toBeLessThanOrEqual(12);
	});

	it("documents a CLI expand path so screen-reader users can fetch full content", () => {
		const store = new ArtifactStore("session-fmt4", dataDir, 50_000);
		const big = "p".repeat(60_000);
		const out = store.persistAndReplace(big, "read_file");
		// Even if the CLI is not implemented in v1, the chip text must
		// surface the on-disk path so a human can `cat` it.
		expect(out).toContain(path.join(dataDir, "session-fmt4"));
		expect(out).toMatch(/8gent artifact <hash>|full at /);
	});
});

// ---- 8SO concern: PathGuard runs on the write path -----------------------

describe("ArtifactStore — PathGuard on write-path (8SO)", () => {
	it("rejects construction when dataDir resolves into a protected dir via symlink", () => {
		// Build a fake home with .ssh under it. Point the artifact dataDir at
		// a symlink that resolves to .ssh. PathGuard MUST refuse the write.
		const fakeHome = tmpRoot;
		const sshDir = path.join(fakeHome, ".ssh");
		fs.mkdirSync(sshDir, { recursive: true });
		const symlinkPath = path.join(fakeHome, "evil-link");
		fs.symlinkSync(sshDir, symlinkPath);

		const evilDataDir = path.join(symlinkPath, "artifacts");
		expect(() => new ArtifactStore("s-evil", evilDataDir, 50_000)).toThrow(
			/protected|guard|denied/i,
		);
	});

	it("rejects construction when dataDir resolves to /dev", () => {
		expect(() => new ArtifactStore("s-dev", "/dev/null/artifacts", 50_000)).toThrow(
			/device|guard|denied/i,
		);
	});

	it("allows a normal tmp dataDir", () => {
		expect(() => new ArtifactStore("s-ok", dataDir, 50_000)).not.toThrow();
	});
});

// ---- env override --------------------------------------------------------

describe("ArtifactStore — env-overridable threshold", () => {
	it("ARTIFACT_THRESHOLD env var overrides the default", () => {
		process.env.ARTIFACT_THRESHOLD = "1000";
		const store = new ArtifactStore("session-env", dataDir);
		const out = store.persistAndReplace("a".repeat(1500), "read_file");
		expect(out).toMatch(/^\[ARTIFACT /);
	});
});
