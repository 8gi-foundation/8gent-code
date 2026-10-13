import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { refreshSecurityEnvForTests } from "../permissions/run-command-sandbox.js";
import { SkillManager } from "./index.js";

let root: string;
let project: string;
let home: string;
let savedDataDir: string | undefined;

function writeSkill(dir: string, name: string, body: string): string {
	fs.mkdirSync(path.join(dir, name), { recursive: true });
	const file = path.join(dir, name, "SKILL.md");
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: from ${body}\n---\n${body}\n`);
	return file;
}
/** Pin project skill files in the test data dir's skills-trust.json (#4125). */
function pin(entries: Record<string, string>) {
	const dir = path.join(root, "data");
	fs.mkdirSync(dir, { recursive: true });
	const pins: Record<string, string> = {};
	for (const [name, file] of Object.entries(entries))
		pins[name] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	fs.writeFileSync(path.join(dir, "skills-trust.json"), JSON.stringify(pins));
}
const mgr = () => new SkillManager(undefined, { projectDir: project, homeDir: home });

beforeEach(() => {
	root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "skilldisc-"));
	project = path.join(root, "proj");
	home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	// Keep the real ~/.8gent/skills-trust.json out of these tests (#4125).
	savedDataDir = process.env.EIGHT_DATA_DIR;
	process.env.EIGHT_DATA_DIR = path.join(root, "data");
	refreshSecurityEnvForTests();
});
afterEach(() => {
	if (savedDataDir === undefined) Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	else process.env.EIGHT_DATA_DIR = savedDataDir;
	refreshSecurityEnvForTests();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("skill discovery", () => {
	test("finds project .agents/skills and ~/.agents/skills", async () => {
		writeSkill(path.join(project, ".agents", "skills"), "p-skill", "P");
		writeSkill(path.join(home, ".agents", "skills"), "u-skill", "U");
		const m = mgr();
		await m.loadSkills();
		expect(m.getSkill("p-skill")?.prompt).toBe("P");
		expect(m.getSkill("u-skill")?.prompt).toBe("U");
		expect(m.getCollisions()).toEqual([]);
	});

	test("still reads project and global .claude/skills", async () => {
		writeSkill(path.join(project, ".claude", "skills"), "c-proj", "CP");
		writeSkill(path.join(home, ".claude", "skills"), "c-home", "CH");
		const m = mgr();
		await m.loadSkills();
		expect(m.getSkill("c-proj")).toBeDefined();
		expect(m.getSkill("c-home")).toBeDefined();
	});

	test("precedence (pinned project skills): project .agents > project .claude > ~/.8gent > ~/.agents > ~/.claude", async () => {
		const names = ["a", "b", "c", "d", "e"];
		// Each name exists in the tiers from its index to the end; the first tier wins.
		const tiers: string[] = [
			path.join(project, ".agents", "skills"),
			path.join(project, ".claude", "skills"),
			"", // ~/.8gent/skills flat .md, handled below
			path.join(home, ".agents", "skills"),
			path.join(home, ".claude", "skills"),
		];
		names.forEach((n, i) => {
			for (let t = i; t < tiers.length; t++) {
				if (t === 2) {
					const d = path.join(home, ".8gent", "skills");
					fs.mkdirSync(d, { recursive: true });
					fs.writeFileSync(
						path.join(d, `${n}-flat.md`),
						`---\nname: ${n}\ndescription: x\n---\ntier2\n`,
					);
				} else writeSkill(tiers[t], n, `tier${t}`);
			}
		});
		// #4125: a project skill only beats a user skill when its sha256 is pinned.
		pin({
			a: path.join(tiers[0], "a", "SKILL.md"),
			b: path.join(tiers[1], "b", "SKILL.md"),
		});
		const m = mgr();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		await m.loadSkills();
		warn.mockRestore();
		expect(names.map((n) => m.getSkill(n)?.prompt)).toEqual([
			"tier0",
			"tier1",
			"tier2",
			"tier3",
			"tier4",
		]);
	});

	test("pinned project beats user; unpinned project cannot replace bundled; collisions reported", async () => {
		const projDup = writeSkill(path.join(project, ".agents", "skills"), "dup", "PROJECT");
		writeSkill(path.join(home, ".agents", "skills"), "dup", "USER");
		const projRetro = writeSkill(
			path.join(project, ".agents", "skills"),
			"retro",
			"OVERRIDES-BUNDLED",
		);
		pin({ dup: projDup });
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const m = mgr();
		await m.loadSkills();
		expect(m.getSkill("dup")?.prompt).toBe("PROJECT");
		// #4125: retro is not pinned, so the bundled retro is kept.
		expect(m.getSkill("retro")?.filePath).toBe(path.join(import.meta.dir, "retro", "SKILL.md"));
		expect(
			m
				.getCollisions()
				.map((x) => x.name)
				.sort(),
		).toEqual(["dup", "retro"]);
		expect(m.getCollisions().find((x) => x.name === "retro")?.ignored).toBe(projRetro);
		const c = m.getCollisions().filter((x) => x.name === "dup");
		expect(c.length).toBe(1);
		expect(c[0].kept).toContain(path.join("proj", ".agents"));
		expect(c[0].ignored).toContain(path.join("home", ".agents"));
		expect(warn.mock.calls.filter((a) => String(a[0]).includes('"dup"')).length).toBe(1);
		// A reload reports the collision in getCollisions() but does not warn again.
		await m.loadSkills();
		expect(m.getCollisions().length).toBe(2);
		expect(warn.mock.calls.filter((a) => String(a[0]).includes('"dup"')).length).toBe(1);
		warn.mockRestore();
	});

	test("project equal to home is not a collision with itself", async () => {
		writeSkill(path.join(home, ".agents", "skills"), "same", "S");
		const m = new SkillManager(undefined, { projectDir: home, homeDir: home });
		await m.loadSkills();
		expect(m.getCollisions()).toEqual([]);
		expect(m.getSkill("same")?.prompt).toBe("S");
	});
});
