import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type LoopRow,
	fmtWhen,
	loadControlConfig,
	orderRows,
	readControlState,
	watchTargets,
} from "./control-state.js";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "control-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function job(dir: string, file: string, body: unknown, ageMin = 0) {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, file);
	fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
	const t = new Date(Date.now() - ageMin * 60_000);
	fs.utimesSync(p, t, t);
}

const jobsDir = () => path.join(home, ".8gent", "jobs");
const cfg = () => loadControlConfig({ home });

describe("jobs reader", () => {
	test("each state becomes a row with the fields it was given", () => {
		const base = {
			kind: "lane",
			stage: "build",
			last: "2026-10-25T16:02:00",
			next: "review",
			detail: "d",
		};
		job(jobsDir(), "a.json", { ...base, name: "epics lane", state: "running" });
		job(jobsDir(), "b.json", {
			...base,
			name: "disk prune",
			state: "waiting-on-you",
			waitingOn: "your yes",
		});
		job(jobsDir(), "c.json", {
			...base,
			name: "release",
			state: "queued",
			waitingOn: "next merge",
		});
		job(jobsDir(), "d.json", {
			...base,
			name: "old probe",
			state: "stalled",
			waitingOn: "no owner",
		});
		job(jobsDir(), "e.json", { ...base, name: "scout", state: "done" });
		const { rows, problems } = readControlState(cfg(), { home });
		expect(problems).toEqual([]);
		expect(rows.map((r) => [r.name, r.state])).toEqual([
			["disk prune", "waiting-on-you"],
			["epics lane", "running"],
			["release", "queued"],
			["old probe", "stalled"],
			["scout", "done"],
		]);
		const prune = rows.find((r) => r.name === "disk prune");
		expect(prune).toMatchObject({
			kind: "lane",
			stage: "build",
			next: "review",
			waitingOn: "your yes",
			detail: "d",
		});
		expect(prune?.last).toMatch(/^\d\d:\d\d$/);
	});

	test("a missing folder and a missing config are skipped, not errors", () => {
		expect(readControlState(cfg(), { home })).toEqual({ rows: [], problems: [] });
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".8gent", "control.json"),
			JSON.stringify({
				sources: [
					{ type: "jobs", dir: "~/nowhere" },
					{ type: "merge-ready", path: "~/nowhere.txt", queueLog: "~/nowhere.jsonl" },
				],
			}),
		);
		expect(readControlState(cfg(), { home })).toEqual({ rows: [], problems: [] });
	});

	test("malformed files are reported and skipped, good ones still read", () => {
		job(jobsDir(), "bad.json", "{ not json");
		job(jobsDir(), "arr.json", "[1,2]");
		job(jobsDir(), "nostate.json", { name: "x", state: "sleeping" });
		job(jobsDir(), "ok.json", { state: "running" });
		fs.writeFileSync(path.join(jobsDir(), "notes.txt"), "ignored");
		const { rows, problems } = readControlState(cfg(), { home });
		expect(rows.map((r) => r.name)).toEqual(["ok"]);
		expect(rows[0]).toMatchObject({
			kind: "loop",
			stage: "",
			last: null,
			next: null,
			waitingOn: null,
		});
		expect(problems.length).toBe(3);
	});

	test("a running loop that stopped reporting is stalled, per config and per job", () => {
		job(jobsDir(), "old.json", { name: "old", state: "running" }, 90);
		job(jobsDir(), "fresh.json", { name: "fresh", state: "running" }, 5);
		job(jobsDir(), "patient.json", { name: "patient", state: "running", staleAfterMin: 0 }, 900);
		job(jobsDir(), "strict.json", { name: "strict", state: "running", staleAfterMin: 2 }, 5);
		const rows = readControlState(cfg(), { home }).rows;
		const by = Object.fromEntries(rows.map((r) => [r.name, r]));
		expect(by.old.state).toBe("stalled");
		expect(by.old.waitingOn).toMatch(/^no update for 9\dm$/);
		expect(by.fresh.state).toBe("running");
		expect(by.patient.state).toBe("running");
		expect(by.strict.state).toBe("stalled");
	});
});

describe("merge-ready reader", () => {
	const sha = "a".repeat(40);
	const write = (lines: string[], log?: unknown[]) => {
		const dir = path.join(home, "ledgers");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "review-ledger.txt"), lines.join("\n"));
		if (log)
			fs.writeFileSync(
				path.join(dir, "merge-log.jsonl"),
				log.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
			);
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".8gent", "control.json"),
			JSON.stringify({
				sources: [
					{
						type: "merge-ready",
						path: "~/ledgers/review-ledger.txt",
						queueLog: "~/ledgers/merge-log.jsonl",
						limit: 3,
					},
				],
			}),
		);
	};

	test("MERGE-OK lines are queued, merged ones from the queue log are done, latest line per PR wins", () => {
		write(
			[
				"# comment line",
				"TRIAGE x#1: HOLD",
				`MERGE-OK org/repo#10 at ${sha}: first read`,
				`MERGE-OK org/repo#11 at ${"b".repeat(40)}: evidence for 11`,
				`MERGE-OK org/repo#10 at ${"c".repeat(40)}: second read PASS`,
				"MERGE-OK broken line without a sha",
			],
			[{ ts: "2026-10-25T15:32:00", pr: 11, merge_commit: "m", head: "h" }, "not json"],
		);
		const { rows, problems } = readControlState(cfg(), { home });
		expect(rows.map((r) => [r.name, r.state, r.stage])).toEqual([
			["repo#10", "queued", "MERGE-OK"],
			["repo#11", "done", "merged"],
		]);
		expect(rows[0].detail).toContain("ccccccccc");
		expect(rows[0].detail).toContain("second read PASS");
		expect(rows[0]).toMatchObject({ kind: "merge", waitingOn: "merge", next: "merge" });
		expect(problems.length).toBe(2);
	});

	test("limit keeps only the latest PRs, and a long file is read from its tail", () => {
		const many = Array.from({ length: 5 }, (_, i) => `MERGE-OK org/repo#${i + 1} at ${sha}: e`);
		write(many);
		expect(readControlState(cfg(), { home }).rows.map((r) => r.name)).toEqual([
			"repo#3",
			"repo#4",
			"repo#5",
		]);
		const big = [
			`MERGE-OK org/repo#1 at ${sha}: old`,
			"x".repeat(200_000),
			`MERGE-OK org/repo#2 at ${sha}: new`,
		];
		write(big);
		expect(readControlState(cfg(), { home }).rows.map((r) => r.name)).toEqual(["repo#2"]);
	});
});

describe("config", () => {
	test("no config reads the generic jobs folder under home and nothing else", () => {
		const c = cfg();
		expect(c.sources).toEqual([{ type: "jobs", dir: jobsDir() }]);
		expect(watchTargets(c)).toEqual([jobsDir()]);
	});

	test("malformed config falls back to the default", () => {
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".8gent", "control.json"), "{{");
		expect(cfg().sources).toEqual([{ type: "jobs", dir: jobsDir() }]);
	});

	test("caps and floors come from config, ~ expands to home", () => {
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".8gent", "control.json"),
			JSON.stringify({
				sources: [{ type: "jobs", dir: "~/x" }],
				helperCap: 4,
				diskFloorGB: 30,
				staleAfterMin: 10,
			}),
		);
		expect(cfg()).toEqual({
			sources: [{ type: "jobs", dir: path.join(home, "x") }],
			helperCap: 4,
			diskFloorGB: 30,
			staleAfterMin: 10,
		});
	});
});

describe("ordering and time", () => {
	const row = (name: string, state: LoopRow["state"]): LoopRow => ({
		kind: "k",
		name,
		state,
		stage: "",
		last: null,
		next: null,
		waitingOn: null,
		detail: "",
	});

	test("waiting on you, running, queued, stalled, then done; names break ties", () => {
		const out = orderRows([
			row("z", "stalled"),
			row("b", "queued"),
			row("y", "running"),
			row("a", "queued"),
			row("m", "done"),
			row("c", "waiting-on-you"),
			row("x", "running"),
		]);
		expect(out.map((r) => r.name)).toEqual(["c", "x", "y", "a", "b", "z", "m"]);
	});

	test("fmtWhen shows HH:MM for ISO and epoch, passes other text through", () => {
		expect(fmtWhen("2026-10-25T16:02:00")).toBe("16:02");
		expect(fmtWhen(new Date(2026, 9, 25, 7, 5).getTime())).toBe("07:05");
		expect(fmtWhen("on MERGE-OK")).toBe("on MERGE-OK");
		expect(fmtWhen(null)).toBeNull();
		expect(fmtWhen("")).toBeNull();
	});
});
