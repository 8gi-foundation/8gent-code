import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineManager } from "./routines";
import { scoutDir } from "./scout";
import { runScoutCommand } from "./scout-cli";

const roots: string[] = [];
afterAll(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function rig(answer: boolean | null = true) {
	const home = mkdtempSync(join(tmpdir(), "scout-cli-"));
	roots.push(home);
	const env = { EIGHT_HOME: home };
	const out: string[] = [];
	const asked: [string, boolean][] = [];
	const urls: string[] = [];
	const manager = new RoutineManager(undefined, env, {
		fetchImpl: async (u) => {
			urls.push(u);
			return new Response("<p>AI in procurement.</p>", { status: 200 });
		},
	});
	const deps = {
		manager,
		env,
		say: (l: string) => out.push(l),
		ask: async (l: string, d: boolean) => {
			asked.push([l, d]);
			return answer;
		},
	};
	return { deps, out, asked, urls, manager, env };
}

const add = [
	"add",
	"morning",
	"--schedule",
	"0 9 * * *",
	"--source",
	"gov=https://www.gov.ie/en/feed/",
	"--keyword",
	"AI",
];

describe("8gent scout", () => {
	test("add shows every address, defaults to No, and saves only after a yes", async () => {
		const no = rig(false);
		expect(await runScoutCommand(add, no.deps)).toBe(1);
		expect(no.manager.list()).toEqual([]);
		expect(no.asked[0][1]).toBe(false);
		expect(no.asked[0][0]).toContain("https://www.gov.ie/en/feed/");

		const yes = rig(true);
		expect(await runScoutCommand(add, yes.deps)).toBe(0);
		expect(yes.manager.list()[0].kind).toBe("scout");
		expect(yes.out.join("\n")).toContain("morning");
		expect(yes.urls).toEqual([]); // saving fetches nothing
	});

	test("nobody to ask means no, with a plain line", async () => {
		const r = rig(null);
		expect(await runScoutCommand(add, r.deps)).toBe(1);
		expect(r.manager.list()).toEqual([]);
		expect(r.out.join("\n")).toMatch(/not enabled|no one to ask|nothing was saved/i);
	});

	test("bad input is refused before anything is asked: http, a missing schedule, an unknown flag", async () => {
		for (const args of [
			["add", "x", "--schedule", "0 9 * * *", "--source", "a=http://a.example/"],
			["add", "x", "--source", "a=https://a.example/"],
			["add", "x", "--schedule", "0 9 * * *", "--source", "a=https://a.example/", "--header", "x"],
			["add", "x", "--schedule", "0 9 * * *"],
		]) {
			const r = rig(true);
			expect(await runScoutCommand(args, r.deps)).toBe(1);
			expect(r.asked).toEqual([]);
			expect(r.manager.list()).toEqual([]);
		}
	});

	test("run fetches only the listed URL and prints where the result is; list shows it; remove deletes it", async () => {
		const r = rig(true);
		await runScoutCommand(add, r.deps);
		const id = r.manager.list()[0].id;
		r.out.length = 0;
		expect(await runScoutCommand(["run", id], r.deps)).toBe(0);
		expect(r.urls).toEqual(["https://www.gov.ie/en/feed/"]);
		expect(readdirSync(scoutDir(r.env, id)).length).toBe(1);
		expect(r.out.join("\n")).toContain(scoutDir(r.env, id));
		r.out.length = 0;
		await runScoutCommand(["list"], r.deps);
		expect(r.out.join("\n")).toContain(id);
		expect(await runScoutCommand(["remove", id], r.deps)).toBe(0);
		expect(r.manager.list()).toEqual([]);
	});

	test("disable then enable asks again; run on an unknown id fails", async () => {
		const r = rig(true);
		await runScoutCommand(add, r.deps);
		const id = r.manager.list()[0].id;
		expect(await runScoutCommand(["disable", id], r.deps)).toBe(0);
		r.asked.length = 0;
		expect(await runScoutCommand(["enable", id], r.deps)).toBe(0);
		expect(r.asked.length).toBe(1);
		expect(await runScoutCommand(["run", "nope"], r.deps)).toBe(1);
	});
});
