import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadControlConfig, readControlState } from "../../apps/tui/src/lib/control-state";
import { jobFileName, jobsDir, pruneDoneJobs, writeJobFile } from "./job-file";

let home: string;
let dir: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "jobfile-"));
	dir = path.join(home, ".8gent", "jobs");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function rows() {
	return readControlState(loadControlConfig({ home }), { home });
}

describe("writeJobFile", () => {
	test("the Control reader parses exactly what the writer wrote", () => {
		expect(
			writeJobFile(
				{
					kind: "cron",
					name: "cron-nightly",
					state: "running",
					stage: "shell",
					last: "2026-10-25T10:00:00",
					next: "soon",
					waitingOn: null,
					detail: "d",
				},
				dir,
			),
		).toBe(true);
		const r = rows();
		expect(r.problems).toEqual([]);
		expect(r.rows).toEqual([
			{
				kind: "cron",
				name: "cron-nightly",
				state: "running",
				stage: "shell",
				last: "10:00",
				next: "soon",
				waitingOn: null,
				detail: "d",
			},
		]);
	});

	test("replaces the file in place and leaves no tmp files", () => {
		writeJobFile({ kind: "k", name: "a", state: "running" }, dir);
		writeJobFile({ kind: "k", name: "a", state: "waiting-on-you", waitingOn: "you" }, dir);
		expect(fs.readdirSync(dir)).toEqual(["a.json"]);
		expect(rows().rows[0].state).toBe("waiting-on-you");
	});

	test("a reader never sees a half-written file", () => {
		for (let i = 0; i < 200; i++) {
			writeJobFile({ kind: "k", name: "a", state: "running", detail: "x".repeat(i * 50) }, dir);
			const r = rows();
			expect(r.problems).toEqual([]);
			expect(r.rows.length).toBe(1);
		}
	});

	test("never throws when the folder cannot be made", () => {
		const blocker = path.join(home, "file");
		fs.writeFileSync(blocker, "x");
		expect(writeJobFile({ kind: "k", name: "a", state: "done" }, path.join(blocker, "jobs"))).toBe(
			false,
		);
		expect(writeJobFile({ kind: "k", name: "a", state: "done" }, null)).toBe(false);
	});

	test("names cannot escape the folder", () => {
		expect(jobFileName("../../etc/passwd")).toBe("etc-passwd.json");
		expect(jobFileName("")).toBe("loop.json");
		writeJobFile({ kind: "k", name: "../x", state: "running" }, dir);
		expect(fs.readdirSync(dir)).toEqual(["x.json"]);
	});

	test("under test the default folder is off unless EIGHT_JOBS_DIR is set", () => {
		expect(jobsDir({ NODE_ENV: "test", HOME: home })).toBeNull();
		expect(jobsDir({ NODE_ENV: "test", EIGHT_JOBS_DIR: "/x" })).toBe("/x");
		expect(jobsDir({ HOME: home })).toBe(dir);
	});
});

describe("pruneDoneJobs", () => {
	const old = () => new Date(Date.now() - 3 * 86_400_000);
	const age = (n: string) => fs.utimesSync(path.join(dir, `${n}.json`), old(), old());

	test("removes only old finished helper files", () => {
		writeJobFile({ kind: "helper", name: "helper-old", state: "done" }, dir);
		writeJobFile({ kind: "helper", name: "helper-run", state: "running" }, dir);
		writeJobFile({ kind: "helper", name: "helper-new", state: "done" }, dir);
		for (const n of ["helper-old", "helper-run"]) age(n);
		expect(pruneDoneJobs(86_400_000, dir)).toBe(1);
		expect(fs.readdirSync(dir).sort()).toEqual(["helper-new.json", "helper-run.json"]);
	});

	test("an owner's script row and the cron and update rows survive a prune", () => {
		writeJobFile({ kind: "script", name: "nightly-backup", state: "done" }, dir);
		writeJobFile({ kind: "cron", name: "cron-nightly", state: "done" }, dir);
		writeJobFile({ kind: "update", name: "update-check", state: "done" }, dir);
		// Even a helper-named file of another kind is the owner's.
		writeJobFile({ kind: "script", name: "helper-mine", state: "done" }, dir);
		for (const n of ["nightly-backup", "cron-nightly", "update-check", "helper-mine"]) age(n);
		expect(pruneDoneJobs(86_400_000, dir)).toBe(0);
		expect(fs.readdirSync(dir).length).toBe(4);
	});
});

describe("tmp file", () => {
	test("a planted symlink at a guessable tmp name is never written through", () => {
		const victim = path.join(home, "victim");
		fs.writeFileSync(victim, "keep");
		fs.mkdirSync(dir, { recursive: true });
		for (const guess of [
			`a.json.${process.pid}.${Date.now().toString(36)}.tmp`,
			`a.json.${process.pid}.tmp`,
		])
			fs.symlinkSync(victim, path.join(dir, guess));
		expect(writeJobFile({ kind: "k", name: "a", state: "running" }, dir)).toBe(true);
		expect(fs.readFileSync(victim, "utf8")).toBe("keep");
	});
});
