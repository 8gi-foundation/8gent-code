import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUILT_IN_SLASH_COMMANDS } from "../../apps/tui/src/lib/slash-commands";

const here = import.meta.dir;
const repo = resolve(here, "../..");
const pages = readdirSync(here).filter((f) => f.endsWith(".md"));

const slash = new Set<string>();
for (const c of BUILT_IN_SLASH_COMMANDS) {
	slash.add(c.name);
	for (const a of c.aliases) slash.add(a);
}

// Top-level subcommands of bin/8gent.ts: the `case "x":` lines of the dispatch switch.
const bin = readFileSync(join(repo, "bin/8gent.ts"), "utf8");
const cliCommands = new Set<string>(["tui"]);
for (const m of bin.matchAll(/^\t\tcase "([a-z-]+)"/gm)) cliCommands.add(m[1]);

// Placeholders and skill examples that are not built-in commands.
const slashAllowed = new Set(["skill"]);

function read(page: string) {
	return readFileSync(join(here, page), "utf8");
}

describe("docs/user", () => {
	test("has the seven pages", () => {
		for (const p of ["install", "first-run", "commands", "sessions", "headless", "extensions", "approvals"]) {
			expect(pages).toContain(`${p}.md`);
		}
	});

	for (const page of pages) {
		const text = read(page);

		test(`${page}: every /command exists`, () => {
			const missing: string[] = [];
			for (const m of text.matchAll(/`\/([a-z][a-z-]*)[ `\]<|\\]/g)) {
				if (!slash.has(m[1]) && !slashAllowed.has(m[1])) missing.push(`/${m[1]}`);
			}
			expect(missing).toEqual([]);
		});

		test(`${page}: every "8gent <command>" exists`, () => {
			const missing: string[] = [];
			// Only check code: fenced blocks and inline code spans.
			const code: string[] = [];
			let fenced = false;
			for (const line of text.split("\n")) {
				if (line.startsWith("```")) {
					fenced = !fenced;
					continue;
				}
				if (fenced) code.push(line);
				else for (const span of line.matchAll(/`([^`]+)`/g)) code.push(span[1]);
			}
			for (const line of code) {
				for (const m of line.matchAll(/(?:^|[\s|"(])8gent ([a-z][a-z-]*)\b/g)) {
					if (!cliCommands.has(m[1])) missing.push(`8gent ${m[1]}`);
				}
			}
			expect(missing).toEqual([]);
		});

		test(`${page}: relative links resolve`, () => {
			const bad: string[] = [];
			for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)(?:#[^)]*)?\)/g)) {
				if (!existsSync(resolve(dirname(join(here, page)), m[1]))) bad.push(m[1]);
			}
			expect(bad).toEqual([]);
		});

		test(`${page}: house rules`, () => {
			expect(text).not.toContain("—");
			expect(text).not.toContain("os.8gi.org");
			// The word is banned in prose; the real `/agent` command is the one allowed use.
			expect(/\bagents?\b/i.test(text.replaceAll("/agent", ""))).toBe(false);
		});
	}

	test("run flags documented exist in run.ts", () => {
		const run = readFileSync(join(repo, "packages/eight/run.ts"), "utf8");
		const headless = read("headless.md");
		for (const f of ["--yes", "--output-format", "--provider", "--model", "--cwd", "--max-turns", "--image", "--no-workspace-boundary"]) {
			expect(headless).toContain(f);
			expect(run).toContain(f);
		}
	});

	test("rpc methods documented exist in rpc-server.ts", () => {
		const rpc = readFileSync(join(repo, "packages/eight/rpc-server.ts"), "utf8");
		for (const m of ["session.create", "session.message", "session.abort", "session.destroy", "tools.list"]) {
			expect(read("headless.md")).toContain(m);
			expect(rpc).toContain(`"${m}"`);
		}
	});
});
