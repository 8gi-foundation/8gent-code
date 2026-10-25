import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillManager } from "../index.js";
import { offerBringItHome } from "./ask.js";
import { ingest } from "./ingest.js";
import { hasImported, importManifestPath, importedRoot } from "./paths.js";
import { type FsLike, scanOtherTools } from "./scan.js";

let root: string;
let home: string;
let project: string;
const SECRET = "sk-super-secret-token";

function put(rel: string, body: string, mode?: number): string {
	const f = path.join(home, rel);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, body);
	if (mode !== undefined) fs.chmodSync(f, mode);
	return f;
}
const skill = (name: string, body: string, desc = `does ${name}`) =>
	`---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;

function fixture() {
	put(".claude/CLAUDE.md", "# Be brief\nNo em dashes.");
	put(
		".claude/skills/CreateSkill/SKILL.md",
		skill("CreateSkill", "Read $PAI_DIR/skills/CORE/SkillSystem.md first."),
	);
	put(".claude/skills/Deploy/SKILL.md", skill("Deploy", "Run the deploy checklist."));
	put(".claude/skills/Legacy/SKILL.md", skill("Legacy", "Use $PAI_DIR/tools/run.sh to go."));
	put(
		".claude/skills/Pathy/SKILL.md",
		skill("Pathy", "Open /Users/nobody/gone/notes.md then continue."),
	);
	put(".claude/commands/ship.md", "Ship it $ARGUMENTS");
	put(".claude/projects/-proj/memory/MEMORY.md", "- likes short replies");
	put(".claude/projects/-proj/memory/prefs.md", "prefers bun");
	put(".claude/history.jsonl", "{}");
	put(".agents/skills/Deploy/SKILL.md", skill("Deploy", "agents copy"));
	put(".agents/skills/Extra/SKILL.md", skill("Extra", "extra body"));
	put(".codex/AGENTS.md", "codex rules");
	put(".codex/prompts/review.md", "review prompt");
	put(".cursor/rules/style.mdc", "---\ndescription: style\n---\nuse tabs");
	// Secrets: unreadable by mode, so any read throws. Scan and import must succeed anyway.
	put(".claude/.env", SECRET, 0o000);
	put(".claude/settings.json", `{"token":"${SECRET}"}`, 0o000);
	put(".claude/.credentials.json", SECRET, 0o000);
	put(".codex/auth.json", SECRET, 0o000);
	put(".claude.json", SECRET, 0o000);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "bringhome-"));
	home = path.join(root, "home");
	project = path.join(root, "proj");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
});
afterEach(() => {
	for (const f of [
		".claude/.env",
		".claude/settings.json",
		".claude/.credentials.json",
		".codex/auth.json",
		".claude.json",
	]) {
		try {
			fs.chmodSync(path.join(home, f), 0o600);
		} catch {}
	}
	fs.rmSync(root, { recursive: true, force: true });
});

const mgr = () => new SkillManager(undefined, { projectDir: project, homeDir: home });

describe("core skills win", () => {
	test("/createskill resolves to the bundled skill-creator, not a ~/.claude CreateSkill that needs $PAI_DIR", async () => {
		put(
			".claude/skills/CreateSkill/SKILL.md",
			skill("CreateSkill", "Read $PAI_DIR/skills/CORE/SkillSystem.md first."),
		);
		const m = mgr();
		await m.loadSkills();
		for (const t of ["/createskill", "/create-skill", "createskill"]) {
			const s = m.getSkill(t);
			expect(s?.name).toBe("skill-creator");
			expect(s?.prompt).not.toContain("PAI_DIR");
		}
		expect(m.getSkill("CreateSkill")?.name).toBe("skill-creator");
		expect(m.getCollisions().some((c) => c.ignored.includes(".claude/skills/CreateSkill"))).toBe(
			true,
		);
	});

	test("same-trigger skill from ~/.agents does not shadow a bundled trigger either", async () => {
		put(
			".agents/skills/mytdd/SKILL.md",
			"---\nname: mytdd\ndescription: x\ntrigger: /tdd\n---\nmine\n",
		);
		const m = mgr();
		await m.loadSkills();
		expect(m.getSkill("/tdd")?.name).toBe("test-driven-development");
		expect(m.getSkill("mytdd")).toBeUndefined();
	});

	test("other tools' non-colliding skills still load live, and ~/.8gent/skills still overrides", async () => {
		put(".claude/skills/Deploy/SKILL.md", skill("Deploy", "live"));
		put(".8gent/skills/retro.md", "---\nname: retro\ndescription: mine\n---\nowner retro\n");
		const m = mgr();
		await m.loadSkills();
		expect(m.getSkill("Deploy")?.prompt).toBe("live");
		expect(m.getSkill("retro")?.prompt).toBe("owner retro");
	});
});

describe("scan", () => {
	test("counts per tool and kind, lists secrets as skipped, and cannot read content", () => {
		fixture();
		const reads: string[] = [];
		const base = fs as unknown as FsLike;
		// FsLike has no read method; assert the shape and wrap the calls to record every path touched.
		const spy: FsLike = {
			existsSync: (p) => {
				reads.push(p);
				return base.existsSync(p);
			},
			readdirSync: (p) => {
				reads.push(p);
				return base.readdirSync(p);
			},
			statSync: (p) => {
				reads.push(p);
				return base.statSync(p);
			},
		};
		const scan = scanOtherTools({ home, fs: spy });
		const by = Object.fromEntries(scan.tools.map((t) => [t.tool, t]));
		expect(by.claude.counts).toMatchObject({ skill: 4, instructions: 1, command: 1, memory: 2 });
		expect(by.agents.counts.skill).toBe(2);
		expect(by.codex.counts).toMatchObject({ instructions: 1, command: 1 });
		expect(by.cursor.counts.rule).toBe(1);
		const skippedNames = scan.tools
			.flatMap((t) => t.skipped.map((s) => path.basename(s.path)))
			.sort();
		expect(skippedNames).toEqual([
			".claude.json",
			".credentials.json",
			".env",
			"auth.json",
			"settings.json",
		]);
		expect(by.claude.unmapped).toContain("history.jsonl");
		expect(JSON.stringify(scan)).not.toContain(SECRET);
		expect(Object.keys(spy)).not.toContain("readFileSync");
	});
});

describe("consent then ingest", () => {
	test("consent No writes nothing, not even a folder", () => {
		fixture();
		const scan = scanOtherTools({ home });
		const r = ingest(scan, { consent: false, home });
		expect(r.written).toEqual([]);
		expect(fs.existsSync(path.join(home, ".8gent"))).toBe(false);
	});

	test("asking with the default answer, or no answer, writes nothing", async () => {
		fixture();
		const said: string[] = [];
		const base = { home, say: (l: string) => said.push(l) };
		expect(await offerBringItHome("command", { ...base, ask: async () => false })).toBe("declined");
		expect(await offerBringItHome("command", { ...base, ask: async () => null })).toBe(
			"unanswered",
		);
		expect(fs.existsSync(importedRoot(home))).toBe(false);
	});

	test("consent Yes writes provenance, dedupes, lets core win, never opens a secret", () => {
		fixture();
		const opened: string[] = [];
		const scan = scanOtherTools({ home });
		const r = ingest(scan, {
			consent: true,
			home,
			env: { HOME: home },
			now: () => new Date("2026-10-25T13:00:00Z"),
			readFile: (p) => {
				opened.push(p);
				return fs.readFileSync(p, "utf-8");
			},
		});
		expect(
			opened.every((p) => !/\.env|settings\.json|credentials|auth\.json|\.claude\.json$/.test(p)),
		).toBe(true);
		const deploy = fs.readFileSync(
			path.join(importedRoot(home), "claude", "skills", "deploy", "SKILL.md"),
			"utf-8",
		);
		expect(deploy).toContain("source-tool: claude");
		expect(deploy).toContain(`source-path: ${path.join(home, ".claude/skills/Deploy/SKILL.md")}`);
		expect(deploy).toContain("imported-at: 2026-10-25T13:00:00.000Z");
		expect(deploy).not.toContain("needs-edit");
		expect(fs.existsSync(path.join(importedRoot(home), "agents", "skills", "deploy"))).toBe(false);
		expect(r.deduped.map((d) => d.name)).toEqual(["Deploy"]);
		expect(r.coreWon.map((c) => c.name)).toEqual(["CreateSkill"]);
		expect(fs.existsSync(path.join(importedRoot(home), "claude", "skills", "createskill"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(importedRoot(home), "agents", "skills", "extra", "SKILL.md")),
		).toBe(true);
		expect(
			fs.readFileSync(path.join(importedRoot(home), "codex", "instructions", "agents.md"), "utf-8"),
		).toContain("source-tool: codex");
		const mem = fs.readdirSync(path.join(importedRoot(home), "claude", "memory"));
		expect(mem.length).toBe(2);
		expect(r.pending.reduce((n, p) => n + p.count, 0)).toBe(2);
		expect(JSON.parse(fs.readFileSync(importManifestPath(home), "utf-8")).items.length).toBe(
			r.written.length,
		);
		expect(hasImported(home)).toBe(true);
	});

	test("a $PAI_DIR or missing-path skill is imported marked needs-edit; the loader skips it with its reason", async () => {
		fixture();
		const r = ingest(scanOtherTools({ home }), { consent: true, home, env: { HOME: home } });
		const legacy = r.written.find((w) => w.name === "Legacy");
		expect(legacy?.status).toBe("needs-edit");
		expect(legacy?.reason).toContain("$PAI_DIR");
		expect(r.written.find((w) => w.name === "Pathy")?.reason).toContain(
			"/Users/nobody/gone/notes.md",
		);
		const text = fs.readFileSync(legacy?.dest ?? "", "utf-8");
		expect(text).toMatch(/needs-edit: references \$PAI_DIR/);

		const m = mgr();
		await m.loadSkills();
		expect(m.getSkill("legacy")).toBeUndefined();
		expect(m.getUnavailable().find((u) => u.name === "legacy")?.reason).toContain("$PAI_DIR");
		expect(m.getSkill("deploy")?.filePath).toContain(path.join(".8gent", "imported", "claude"));
	});
});

describe("after import, live loading of other tools stops", () => {
	test("before import ~/.claude skills load; after, only the imported copy does", async () => {
		put(".claude/skills/Deploy/SKILL.md", skill("Deploy", "live body"));
		let m = mgr();
		await m.loadSkills();
		expect(m.getSkill("Deploy")?.filePath).toContain(path.join(".claude", "skills"));

		ingest(scanOtherTools({ home }), { consent: true, home, env: { HOME: home } });
		put(".claude/skills/Late/SKILL.md", skill("Late", "added after import"));
		m = mgr();
		await m.loadSkills();
		expect(m.getSkill("Deploy")?.filePath).toContain(path.join(".8gent", "imported"));
		expect(m.getSkill("Late")).toBeUndefined();
	});
});

describe("the ask", () => {
	test("first run asks once: a No is remembered, a yes imports and says what needs editing", async () => {
		fixture();
		const said: string[] = [];
		const asked: string[] = [];
		const deps = (answer: boolean | null) => ({
			home,
			env: { HOME: home },
			say: (l: string) => said.push(l),
			ask: async (line: string, defaultYes: boolean) => {
				asked.push(line);
				expect(defaultYes).toBe(false);
				return answer;
			},
		});
		expect(await offerBringItHome("first-run", deps(false))).toBe("declined");
		expect(asked[0]).toContain("(y/N)");
		expect(asked[0]).toContain("Claude Code (~/.claude): 4 skills");
		expect(fs.existsSync(importedRoot(home))).toBe(false);
		expect(await offerBringItHome("first-run", deps(true))).toBe("already-asked");
		expect(asked.length).toBe(1);
		expect(await offerBringItHome("command", deps(true))).toBe("imported");
		expect(said.join("\n")).toContain("Needs your edit: Legacy");
		expect(hasImported(home)).toBe(true);
	});

	test("nothing found asks nothing", async () => {
		const asked: string[] = [];
		const out = await offerBringItHome("first-run", {
			home,
			say: () => {},
			ask: async (l) => {
				asked.push(l);
				return true;
			},
		});
		expect(out).toBe("nothing-found");
		expect(asked).toEqual([]);
	});
});
