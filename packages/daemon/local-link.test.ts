/** #4834: the token file and the discovery file, and what they refuse. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	DISCOVERY_FILE,
	TOKEN_FILE,
	discoverDaemons,
	ensureTokenFile,
	readDiscovery,
	readTokenFile,
	removeDiscovery,
	writeDiscovery,
} from "./local-link";

let root: string;
beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "local-link-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const mode = (f: string) => fs.statSync(f).mode & 0o777;

describe("operator token file", () => {
	it("is created 0600 in a 0700 directory, 64 hex, and reused on the next start", () => {
		const dir = path.join(root, "data");
		const t = ensureTokenFile(dir);
		expect(t).toMatch(/^[0-9a-f]{64}$/);
		expect(mode(path.join(dir, TOKEN_FILE))).toBe(0o600);
		expect(mode(dir)).toBe(0o700);
		expect(ensureTokenFile(dir)).toBe(t);
		expect(readTokenFile(dir)).toBe(t);
	});

	it("does not loosen an existing directory", () => {
		fs.chmodSync(root, 0o755);
		ensureTokenFile(root);
		expect(mode(root)).toBe(0o755);
	});

	it("refuses a file other users can read, and never rewrites it", () => {
		const f = path.join(root, TOKEN_FILE);
		fs.writeFileSync(f, `${"a".repeat(64)}\n`, { mode: 0o644 });
		fs.chmodSync(f, 0o644);
		expect(readTokenFile(root)).toBeNull();
		expect(() => ensureTokenFile(root)).toThrow(/readable by other users/);
		expect(fs.readFileSync(f, "utf8").trim()).toBe("a".repeat(64));
	});

	it("refuses a symlink, even to a good file", () => {
		const real = path.join(root, "real");
		fs.writeFileSync(real, `${"b".repeat(64)}\n`, { mode: 0o600 });
		fs.symlinkSync(real, path.join(root, TOKEN_FILE));
		expect(readTokenFile(root)).toBeNull();
		expect(() => ensureTokenFile(root)).toThrow(/symlink/);
	});

	it("refuses a malformed token rather than using or replacing it", () => {
		const f = path.join(root, TOKEN_FILE);
		fs.writeFileSync(f, "hunter2\n", { mode: 0o600 });
		expect(readTokenFile(root)).toBeNull();
		expect(() => ensureTokenFile(root)).toThrow(/malformed/);
		expect(fs.readFileSync(f, "utf8")).toBe("hunter2\n");
	});
});

describe("discovery file", () => {
	const mine = (dir: string, over: Record<string, unknown> = {}) => ({
		url: "ws://127.0.0.1:18790",
		pid: process.pid,
		dataDir: dir,
		...over,
	});

	it("is 0600, round-trips, and carries no token", () => {
		ensureTokenFile(root);
		writeDiscovery(root, mine(root));
		const f = path.join(root, DISCOVERY_FILE);
		expect(mode(f)).toBe(0o600);
		expect(readDiscovery(root)).toEqual(mine(root));
		expect(fs.readFileSync(f, "utf8")).not.toContain(readTokenFile(root) as string);
	});

	it("ignores a dead pid, a non-loopback url, a url with credentials, and a loose or symlinked file", () => {
		writeDiscovery(root, mine(root, { pid: 2_147_483_000 }));
		expect(readDiscovery(root)).toBeNull();
		expect(readDiscovery(root, { requireLive: false })?.pid).toBe(2_147_483_000);
		for (const url of [
			"ws://evil.example:18789",
			"ws://user:pw@127.0.0.1:1",
			"http://127.0.0.1:1",
			"nope",
		]) {
			writeDiscovery(root, mine(root, { url }));
			expect(readDiscovery(root)).toBeNull();
		}
		writeDiscovery(root, mine(root));
		fs.chmodSync(path.join(root, DISCOVERY_FILE), 0o666);
		expect(readDiscovery(root)).toBeNull();
		fs.rmSync(path.join(root, DISCOVERY_FILE));
		fs.writeFileSync(path.join(root, "x.json"), JSON.stringify(mine(root)), { mode: 0o600 });
		fs.symlinkSync(path.join(root, "x.json"), path.join(root, DISCOVERY_FILE));
		expect(readDiscovery(root)).toBeNull();
	});

	it("is removed only by the pid that wrote it", () => {
		writeDiscovery(root, mine(root));
		removeDiscovery(root, process.pid + 1);
		expect(readDiscovery(root)).not.toBeNull();
		removeDiscovery(root);
		expect(readDiscovery(root)).toBeNull();
	});

	it("is found under ~/.8gent and ~/.8gent/*, live ones only, root first", () => {
		const base = path.join(root, ".8gent");
		writeDiscovery(base, mine(base, { url: "ws://127.0.0.1:18789" }));
		const bot = path.join(base, "eightgent-data");
		writeDiscovery(bot, mine(bot));
		const stale = path.join(base, "old-data");
		writeDiscovery(stale, mine(stale, { pid: 2_147_483_000 }));
		const found = discoverDaemons(root);
		expect(found.map((d) => d.url)).toEqual(["ws://127.0.0.1:18789", "ws://127.0.0.1:18790"]);
		expect(found[1].dir).toBe(bot);
		expect(discoverDaemons(path.join(root, "nowhere"))).toEqual([]);
	});
});
