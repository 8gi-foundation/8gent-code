/**
 * 8SO second read of #4889: `8gent durable-run <dir>` never writes through a link or into a
 * folder other people can write. Black box: the real CLI, real folders and links, a victim file
 * that must come out untouched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const fresh = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "durable-folder-"));
	roots.push(d);
	return d;
};

async function durableRun(dir: string) {
	const proc = Bun.spawn(["bun", path.join(ROOT, "bin/8gent.ts"), "durable-run", dir], {
		cwd: ROOT,
		env: { ...process.env, EIGHT_DURABLE_RUN: "1", EIGHT_DATA_DIR: path.join(dir, "..", "data") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, out, err };
}

const VICTIM = "precious: do not overwrite";
function victimIn(base: string): string {
	const victim = path.join(base, "victim");
	fs.writeFileSync(victim, VICTIM);
	return victim;
}

describe("a link or a shared folder is refused before anything is written", () => {
	test("a world-writable folder holding a link named corpus.txt: the victim is untouched", async () => {
		const base = fresh();
		const victim = victimIn(base);
		const shared = path.join(base, "shared");
		fs.mkdirSync(shared);
		fs.chmodSync(shared, 0o777);
		fs.symlinkSync(victim, path.join(shared, "corpus.txt"));
		const r = await durableRun(shared);
		expect(r.code).not.toBe(0);
		expect(r.err).toMatch(/writable by others/);
		expect(fs.readFileSync(victim, "utf8")).toBe(VICTIM);
		expect(fs.existsSync(path.join(shared, "out"))).toBe(false); // not even the folder it would make
		expect(fs.existsSync(path.join(shared, "run.sqlite"))).toBe(false);
	});

	for (const name of ["corpus.txt", "effects.log", "gate.log", "sent.jsonl"]) {
		test(`a link named ${name} in the user's own folder is refused, the victim untouched`, async () => {
			const base = fresh();
			const victim = victimIn(base);
			const dir = path.join(base, "run");
			fs.mkdirSync(dir, { mode: 0o700 });
			fs.symlinkSync(victim, path.join(dir, name));
			const r = await durableRun(dir);
			// corpus.txt is written first, so the run stops; a log link is refused when the log is
			// first appended (the tool step fails, the run ends). Either way nothing goes through it.
			if (name === "corpus.txt") expect(r.code).not.toBe(0);
			expect(fs.readFileSync(victim, "utf8")).toBe(VICTIM);
		});
	}

	test("an out folder that is a link elsewhere is refused", async () => {
		const base = fresh();
		const elsewhere = path.join(base, "elsewhere");
		fs.mkdirSync(elsewhere);
		const dir = path.join(base, "run");
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.symlinkSync(elsewhere, path.join(dir, "out"));
		const r = await durableRun(dir);
		expect(r.code).not.toBe(0);
		expect(fs.readdirSync(elsewhere)).toEqual([]);
	});

	test("a link named notes.txt.tmp (the write_file temp name) is never written through", async () => {
		const base = fresh();
		const victim = victimIn(base);
		const dir = path.join(base, "run");
		fs.mkdirSync(path.join(dir, "out"), { recursive: true, mode: 0o700 });
		fs.symlinkSync(victim, path.join(dir, "out", "notes.txt.tmp"));
		await durableRun(dir);
		expect(fs.readFileSync(victim, "utf8")).toBe(VICTIM);
	});

	test("an ordinary private folder still runs to the end", async () => {
		const base = fresh();
		const dir = path.join(base, "run");
		const r = await durableRun(dir);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out.trim().split("\n").pop() as string).answerEntry).toBeGreaterThan(0);
		expect(fs.readFileSync(path.join(dir, "out", "notes.txt"), "utf8")).toContain("release notes");
	}, 60_000);
});
