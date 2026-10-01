/**
 * Product code opens SQLite through SqliteDatabase, never a raw bun:sqlite
 * Database.
 *
 * A raw Database keeps its file open after close() while any prepared
 * statement is unfinalized, and on Windows that open file cannot be deleted
 * or replaced (EBUSY). SqliteDatabase (packages/core/sqlite.ts) releases it.
 * This fails when a new `new Database(` appears in a file that imports
 * bun:sqlite, so the fix cannot quietly erode.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");

/** Tests, scripts and benchmarks open throwaway databases; they may stay raw. */
const ALLOWED_PATTERNS = [
	/\.test\.tsx?$/,
	/(^|\/)__tests__\//,
	/(^|\/)scripts\//,
	/(^|\/)bench(marks?)?\//,
	/\.d\.ts$/,
];

/**
 * The wrapper itself, plus known stragglers left for a follow-up (#3310).
 * Remove an entry when its file moves to SqliteDatabase; never add one.
 */
const ALLOWED_FILES = new Set([
	"packages/core/sqlite.ts",
	"apps/linkedin-vessel/src/campaign-db.ts",
	"packages/daemon/routes/store/graph.ts",
	"packages/eyes/marlin/extract-video.ts",
]);

function trackedSourceFiles(): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx", "*.mts"], { cwd: ROOT });
	if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
	return out.stdout
		.toString()
		.split("\n")
		.filter((f) => f && !f.includes("node_modules/"));
}

test("no product file constructs a raw bun:sqlite Database", () => {
	const offenders: string[] = [];
	for (const rel of trackedSourceFiles()) {
		if (ALLOWED_FILES.has(rel) || ALLOWED_PATTERNS.some((re) => re.test(rel))) continue;
		const abs = path.join(ROOT, rel);
		if (!fs.existsSync(abs)) continue;
		const src = fs.readFileSync(abs, "utf8");
		if (src.includes("bun:sqlite") && src.includes("new Database(")) offenders.push(rel);
	}
	expect(offenders).toEqual([]);
});

test("every allowlisted straggler still needs its entry", () => {
	const stale = [...ALLOWED_FILES].filter((rel) => {
		if (rel === "packages/core/sqlite.ts") return false;
		const abs = path.join(ROOT, rel);
		return !fs.existsSync(abs) || !fs.readFileSync(abs, "utf8").includes("new Database(");
	});
	expect(stale).toEqual([]);
});
