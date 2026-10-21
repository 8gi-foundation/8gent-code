import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryManager } from "./index";
import {
	ensureEightIgnored,
	migrateRepoMemory,
	prepareProjectMemoryDir,
	projectStateDir,
} from "./project-state";

let root: string;
let repo: string;
let data: string;
const saved = { data: process.env.EIGHT_DATA_DIR, inRepo: process.env.EIGHT_PROJECT_STATE_IN_REPO };

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps4711-")));
	repo = path.join(root, "repo");
	data = path.join(root, "data");
	fs.mkdirSync(repo);
	process.env.EIGHT_DATA_DIR = data;
	// biome-ignore lint/performance/noDelete: env must be unset, not "undefined"
	delete process.env.EIGHT_PROJECT_STATE_IN_REPO;
});

afterEach(() => {
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.data],
		["EIGHT_PROJECT_STATE_IN_REPO", saved.inRepo],
	] as const) {
		// biome-ignore lint/performance/noDelete: env must be unset, not "undefined"
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

describe("project state outside the repo (#4711)", () => {
	test("state dir is projects/<12 hex of sha1(path)> under the data dir", () => {
		const d = projectStateDir(repo);
		expect(path.dirname(d)).toBe(path.join(data, "projects"));
		expect(path.basename(d)).toMatch(/^[0-9a-f]{12}$/);
		expect(projectStateDir(repo)).toBe(d);
		expect(projectStateDir(path.join(root, "other"))).not.toBe(d);
	});

	test("opening the store leaves the repo untouched", async () => {
		const m = new MemoryManager(repo);
		await m.remember("a fact", "project");
		expect(fs.readdirSync(repo)).toEqual([]);
		expect(fs.existsSync(path.join(projectStateDir(repo), "memory", "memory.db"))).toBe(true);
	});

	test("opt-in keeps the old location and ignores .8gent/", async () => {
		process.env.EIGHT_PROJECT_STATE_IN_REPO = "1";
		fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules");
		const dir = prepareProjectMemoryDir(repo);
		expect(dir).toBe(path.join(repo, ".8gent", "memory"));
		expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.8gent/\n");
		// idempotent: second call adds nothing
		prepareProjectMemoryDir(repo);
		expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.8gent/\n");
	});

	test("ensureEightIgnored respects an existing line", () => {
		fs.writeFileSync(path.join(repo, ".gitignore"), ".8gent\n");
		expect(ensureEightIgnored(repo)).toBe(false);
		expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe(".8gent\n");
	});

	test("an existing repo-local db is copied once, never overwritten, never deleted", () => {
		const old = path.join(repo, ".8gent", "memory");
		fs.mkdirSync(old, { recursive: true });
		fs.writeFileSync(path.join(old, "memory.db"), "OLD");
		const dest = path.join(projectStateDir(repo), "memory");
		expect(migrateRepoMemory(repo, dest)).toBe(true);
		expect(fs.readFileSync(path.join(dest, "memory.db"), "utf8")).toBe("OLD");
		fs.writeFileSync(path.join(dest, "memory.db"), "NEW");
		expect(migrateRepoMemory(repo, dest)).toBe(false);
		expect(fs.readFileSync(path.join(dest, "memory.db"), "utf8")).toBe("NEW");
		expect(fs.existsSync(path.join(old, "memory.db"))).toBe(true);
	});

	test("running from the data dir's parent does not copy the global store into a project", () => {
		const home = path.join(root, "home");
		const global = path.join(home, ".8gent");
		process.env.EIGHT_DATA_DIR = global;
		fs.mkdirSync(path.join(global, "memory"), { recursive: true });
		fs.writeFileSync(path.join(global, "memory", "memory.db"), "GLOBAL");
		expect(migrateRepoMemory(home, path.join(projectStateDir(home), "memory"))).toBe(false);
	});

	test("a planted symlink memory.db is never followed", () => {
		const secret = path.join(root, "secret.db");
		fs.writeFileSync(secret, "SECRET");
		const old = path.join(repo, ".8gent", "memory");
		fs.mkdirSync(old, { recursive: true });
		fs.symlinkSync(secret, path.join(old, "memory.db"));
		const dest = path.join(projectStateDir(repo), "memory");
		expect(migrateRepoMemory(repo, dest)).toBe(false);
		expect(fs.existsSync(path.join(dest, "memory.db"))).toBe(false);
	});

	test("a symlinked sidecar is skipped and an existing destination file is not overwritten", () => {
		const old = path.join(repo, ".8gent", "memory");
		fs.mkdirSync(old, { recursive: true });
		fs.writeFileSync(path.join(old, "memory.db"), "OLD");
		fs.writeFileSync(path.join(old, "memory.db-wal"), "OLDWAL");
		fs.symlinkSync(path.join(root, "secret.db"), path.join(old, "memory.db-shm"));
		const dest = path.join(projectStateDir(repo), "memory");
		fs.mkdirSync(dest, { recursive: true });
		fs.writeFileSync(path.join(dest, "memory.db-wal"), "KEEP");
		expect(migrateRepoMemory(repo, dest)).toBe(true);
		expect(fs.readFileSync(path.join(dest, "memory.db-wal"), "utf8")).toBe("KEEP");
		expect(fs.existsSync(path.join(dest, "memory.db-shm"))).toBe(false);
	});

	test("a symlink at the destination db is refused", () => {
		const old = path.join(repo, ".8gent", "memory");
		fs.mkdirSync(old, { recursive: true });
		fs.writeFileSync(path.join(old, "memory.db"), "OLD");
		const dest = path.join(projectStateDir(repo), "memory");
		fs.mkdirSync(dest, { recursive: true });
		const target = path.join(root, "target.db");
		fs.symlinkSync(target, path.join(dest, "memory.db"));
		expect(migrateRepoMemory(repo, dest)).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
	});

	test("repo.path is written on create; a dir made for another path sends this repo to a longer hash", () => {
		const first = prepareProjectMemoryDir(repo);
		const stateDir = path.dirname(first);
		expect(fs.readFileSync(path.join(stateDir, "repo.path"), "utf8")).toBe(fs.realpathSync(repo));
		expect(prepareProjectMemoryDir(repo)).toBe(first);
		fs.writeFileSync(path.join(stateDir, "repo.path"), "/somewhere/else");
		const second = prepareProjectMemoryDir(repo);
		expect(second).not.toBe(first);
		expect(path.basename(path.dirname(second))).toHaveLength(24);
		expect(projectStateDir(repo)).toBe(path.dirname(second));
	});
});
