import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig } from "../mcp/config";
import { runExtCommand } from "./ext-cli";
import type { ImportPaths, ImportRecord } from "./import-sources";
import { expandPromptCommand, loadPromptTemplates } from "./prompts";

const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fake home with Claude Code, Pi and 8gent folders. */
function world(): ImportPaths {
	const root = mkdtempSync(path.join(tmpdir(), "ext-import-"));
	made.push(root);
	const p: ImportPaths = {
		claudeDir: path.join(root, ".claude"),
		claudeJson: path.join(root, ".claude.json"),
		cwd: path.join(root, "proj"),
		piAgentDir: path.join(root, ".pi", "agent"),
		eightDir: path.join(root, ".8gent"),
		mcpConfig: path.join(root, ".8gent", "mcp.json"),
	};
	mkdirSync(path.join(p.claudeDir, "commands"), { recursive: true });
	mkdirSync(path.join(p.claudeDir, "skills", "pdf-tools"), { recursive: true });
	mkdirSync(p.cwd, { recursive: true });
	mkdirSync(p.piAgentDir, { recursive: true });
	return p;
}

const run = (p: ImportPaths, ...args: string[]) => runExtCommand(args, { paths: p });
const records = (p: ImportPaths) =>
	JSON.parse(readFileSync(path.join(p.eightDir, "imports.json"), "utf8")) as ImportRecord[];

describe("8gent ext import claude-code", () => {
	test("commands become staged prompt templates; --enable turns them on; skills are hashed in place", async () => {
		const p = world();
		const review = "---\ndescription: Review a file\n---\nReview $ARGUMENTS for bugs.\n";
		writeFileSync(path.join(p.claudeDir, "commands", "review.md"), review);
		writeFileSync(
			path.join(p.claudeDir, "commands", "ship.md"),
			"---\ndescription: Ship it\nallowed-tools: Bash(git:*)\n---\nStatus: !`git status`\nThen ship $1.\n",
		);
		writeFileSync(
			path.join(p.claudeDir, "skills", "pdf-tools", "SKILL.md"),
			"---\nname: pdf-tools\n---\nUse pdftotext.\n",
		);

		const staged = await run(p, "ext-ignored-placeholder");
		expect(staged.code).toBe(1); // unknown subcommand prints usage

		const r = await run(p, "import", "claude-code");
		expect(r.code).toBe(0);
		expect(r.output).toContain("/claude-review  loaded  staged (off)  Review a file");
		expect(r.output).toContain("/claude-ship  partial");
		expect(r.output).toContain('frontmatter "allowed-tools"');
		expect(r.output).toContain("!`command` shell output");
		expect(r.output).toContain("8gent already reads this folder");
		// Staged, not live.
		expect(
			existsSync(path.join(p.eightDir, "imports", "claude-code", "prompts", "claude-review.md")),
		).toBe(true);
		expect(existsSync(path.join(p.eightDir, "prompts", "claude-review.md"))).toBe(false);

		const rec = records(p);
		const reviewRec = rec.find((x) => x.name === "claude-review");
		expect(reviewRec).toMatchObject({ source: "claude-code", kind: "prompt", enabled: false });
		expect(reviewRec?.path).toBe(path.join(p.claudeDir, "commands", "review.md"));
		expect(reviewRec?.sha256).toBe(createHash("sha256").update(review).digest("hex"));
		expect(rec.find((x) => x.kind === "skill")?.name).toBe("pdf-tools");

		const on = await run(p, "import", "claude-code", "--enable");
		expect(on.output).toContain("/claude-review  loaded  enabled");
		const templates = loadPromptTemplates([path.join(p.eightDir, "prompts")]);
		expect(expandPromptCommand("/claude-review src/app.ts", templates)).toBe(
			"Review src/app.ts for bugs.",
		);
		expect(records(p).find((x) => x.name === "claude-review")?.enabled).toBe(true);
	});
});

describe("8gent ext import mcp", () => {
	test("servers from Claude Code and Pi land as pending; none starts until approved; secrets never printed", async () => {
		const p = world();
		writeFileSync(
			p.claudeJson,
			JSON.stringify({
				mcpServers: {
					github: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "secret-123" } },
				},
				projects: { [p.cwd]: { mcpServers: { db: { command: "db-mcp" } } } },
			}),
		);
		writeFileSync(
			path.join(p.cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { broken: { args: ["x"] } } }),
		);
		writeFileSync(
			path.join(p.piAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					jira: {
						url: "https://mcp.example.com/jira?key=abc",
						headers: { Authorization: "Bearer zzz" },
					},
				},
			}),
		);
		mkdirSync(p.eightDir, { recursive: true });
		writeFileSync(p.mcpConfig, JSON.stringify({ servers: { already: { command: "x" } } }));

		const r = await run(p, "import", "mcp");
		expect(r.code).toBe(0);
		expect(r.output).toContain(
			"github  pending approval  (Claude Code (user)) command npx (+2 args), env: GH_TOKEN (values not shown)",
		);
		expect(r.output).toContain("db  pending approval  (Claude Code (this project))");
		expect(r.output).toContain("jira  pending approval  (Pi) url https://mcp.example.com");
		expect(r.output).toContain(
			'broken  failed  (project .mcp.json) has neither "command" nor "url"',
		);
		for (const secret of ["secret-123", "Bearer zzz", "key=abc"])
			expect(r.output).not.toContain(secret);

		// The MCP loader sees only the server that was there before.
		expect(loadConfig(p.mcpConfig).map((s) => s.name)).toEqual(["already"]);
		const cfg = JSON.parse(readFileSync(p.mcpConfig, "utf8"));
		expect(cfg.pendingServers.github.importedFrom.path).toBe(p.claudeJson);
		expect(cfg.pendingServers.github.importedFrom.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(
			records(p)
				.filter((x) => x.kind === "mcp")
				.every((x) => x.enabled === false),
		).toBe(true);

		const ok = await run(p, "approve-mcp", "github");
		expect(ok.code).toBe(0);
		expect(ok.output).not.toContain("secret-123");
		expect(
			loadConfig(p.mcpConfig)
				.map((s) => s.name)
				.sort(),
		).toEqual(["already", "github"]);
		expect(
			JSON.parse(readFileSync(p.mcpConfig, "utf8")).servers.github.importedFrom,
		).toBeUndefined();
		expect((await run(p, "approve-mcp", "nope")).output).toContain("Pending: db, jira");
	});

	test("--from limits the sources; a name already live is skipped", async () => {
		const p = world();
		writeFileSync(p.claudeJson, JSON.stringify({ mcpServers: { github: { command: "npx" } } }));
		writeFileSync(
			path.join(p.piAgentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { command: "other" } } }),
		);
		mkdirSync(p.eightDir, { recursive: true });
		writeFileSync(p.mcpConfig, JSON.stringify({ mcpServers: { github: { command: "mine" } } }));
		const r = await run(p, "import", "mcp", "--from", "pi");
		expect(r.output).toContain("(Pi)");
		expect(r.output).not.toContain("Claude Code");
		expect(r.output).toContain("github  skipped  (Pi) already in");
		expect((await run(p, "import", "mcp", "--from", "cursor")).code).toBe(1);
	});
});

describe("8gent ext import <unknown>", () => {
	test("refuses with the reason and the supported sources; imports nothing", async () => {
		const p = world();
		const r = await run(p, "import", "opencode");
		expect(r.code).toBe(1);
		expect(r.output).toContain('8gent cannot import "opencode": no importer reads its format');
		expect(r.output).toContain("Supported sources: pi, claude-code, mcp");
		const f = await run(p, "import", "./some/plugin.js");
		expect(f.output).toContain("does not guess or machine-translate");
		expect(existsSync(path.join(p.eightDir, "imports.json"))).toBe(false);
	});

	test("import pi <path> is import-pi", async () => {
		const p = world();
		const dest = path.join(p.eightDir, "extensions");
		const fixtures = path.join(import.meta.dir, "__fixtures__", "pi-extensions");
		const r = await runExtCommand(["import", "pi", fixtures, "--to", dest], { paths: p });
		expect(r.output).toContain("pi-hello-tool  loaded");
	});
});
