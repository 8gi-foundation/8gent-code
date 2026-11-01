import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillManager } from "../../../../packages/skills/index.js";
import { expandSkillSlashCommand, resolveSkillSlash } from "./skill-slash.js";

let root: string;
let project: string;
let home: string;

function writeSkill(dir: string, name: string, body: string, desc = "d") {
	fs.mkdirSync(path.join(dir, name), { recursive: true });
	fs.writeFileSync(
		path.join(dir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`,
	);
}
const mgr = () => new SkillManager(undefined, { projectDir: project, homeDir: home });

beforeEach(() => {
	root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "skillslash-"));
	project = path.join(root, "proj");
	home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("/skill:name", () => {
	test("resolves a project .agents skill and builds the [SKILL: name] prompt", async () => {
		writeSkill(path.join(project, ".agents", "skills"), "demo", "Say hello.");
		const r = await resolveSkillSlash("/skill:demo", mgr());
		expect(r).toEqual({ kind: "skill", name: "demo", prompt: "[SKILL: demo]\n\nSay hello." });
	});

	test("passes flags as arguments", async () => {
		writeSkill(path.join(project, ".agents", "skills"), "demo", "Say hello.");
		const out = await expandSkillSlashCommand("/skill:demo --who world", mgr());
		expect(out).toContain("[SKILL: demo]");
		expect(out).toContain('"who": "world"');
	});

	test("unknown name gives a clear message listing available skills", async () => {
		writeSkill(path.join(project, ".agents", "skills"), "demo", "x");
		const r = await resolveSkillSlash("/skill:nope", mgr());
		expect(r.kind).toBe("unknown");
		if (r.kind === "unknown") {
			expect(r.message).toContain('Unknown skill "nope"');
			expect(r.message).toContain("demo");
		}
	});

	test("expand turns an unknown explicit name into a relay instruction with the message", async () => {
		const out = await expandSkillSlashCommand("/skill:nope", mgr());
		expect(out).toContain('Unknown skill "nope"');
		expect(out).toContain("Reply with exactly this message");
	});

	test("empty name gives usage", async () => {
		const r = await resolveSkillSlash("/skill:", mgr());
		expect(r.kind).toBe("unknown");
		if (r.kind === "unknown") expect(r.message).toContain("Usage: /skill:<name>");
	});

	test("implicit /name still works and unknown implicit slashes pass through", async () => {
		writeSkill(path.join(project, ".agents", "skills"), "demo", "x");
		expect((await resolveSkillSlash("/demo", mgr())).kind).toBe("skill");
		expect(await expandSkillSlashCommand("/not-a-skill hi", mgr())).toBe("/not-a-skill hi");
		expect(await expandSkillSlashCommand("plain text", mgr())).toBe("plain text");
	});
});
