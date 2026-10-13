import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KEYBINDINGS } from "../../apps/tui/src/lib/keybindings";
import { BUILT_IN_SLASH_COMMANDS, formatSlashHelp } from "../../apps/tui/src/lib/slash-commands";

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
	test("has the five pages", () => {
		for (const p of ["install", "use", "keys", "headless", "extensions"]) {
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

	// ---- keys (K1, B4) -------------------------------------------------

	// Everything before the Windows Terminal section describes 8gent's own keys.
	const keysPage = read("keys.md");
	const wtAt = keysPage.indexOf("\n## Windows Terminal");
	const ownKeys = keysPage.slice(0, wtAt);
	const tableKeys = new Set(KEYBINDINGS.map((b) => b.keys));

	test("keys.md lists exactly the rows of KEYBINDINGS, in order", () => {
		expect(wtAt).toBeGreaterThan(0);
		const rows: string[] = [];
		for (const line of ownKeys.split("\n")) {
			const m = line.match(/^\| (.+?) \| (.+?) \|$/);
			if (m && m[1] !== "Keys" && !m[1].startsWith("---")) rows.push(`${m[1]} | ${m[2]}`);
		}
		expect(rows).toEqual(KEYBINDINGS.map((b) => `${b.keys} | ${b.action}`));
	});

	test("every Ctrl/Alt/Shift key named outside the Windows Terminal section is bound", () => {
		const bad: string[] = [];
		for (const page of pages) {
			const text = page === "keys.md" ? ownKeys : read(page);
			for (const m of text.matchAll(/\b((?:Ctrl|Alt|Shift)(?:\+[A-Za-z0-9]+(?:-9)?)+)/g)) {
				if (!tableKeys.has(m[1])) bad.push(`${page}: ${m[1]}`);
			}
		}
		expect(bad).toEqual([]);
	});

	test("Windows Terminal section names only keys 8gent's table does not bind, or says so", () => {
		const wt = keysPage.slice(wtAt);
		expect(wt).toContain("Alt+Enter");
		expect(wt).toContain("Ctrl+Q");
		expect(wt).toContain("Shift+Enter");
		expect(wt).toContain("Ctrl+Shift");
		// 8gent must really have no binding for the keys the page says it lacks.
		expect(tableKeys.has("Shift+Enter")).toBe(false);
		// Alt+Enter is bound, but Windows Terminal swallows it, so Ctrl+Q does the same.
		for (const k of ["Alt+Enter", "Ctrl+Q"]) expect(tableKeys.has(k)).toBe(true);
		for (const k of tableKeys) expect(k.startsWith("Ctrl+Shift")).toBe(false);
		// The remap advice is valid JSON.
		const json = wt.match(/```json\n([\s\S]*?)```/);
		expect(json).not.toBeNull();
		expect(() => JSON.parse(json![1])).not.toThrow();
	});

	test("use.md: /help all and the core menu are real", () => {
		expect(read("use.md")).toContain("/help all");
		expect(formatSlashHelp(true)).not.toBe(formatSlashHelp(false));
	});

	test("use.md: @ mention and !cmd are implemented", () => {
		const lib = join(repo, "apps/tui/src/lib");
		expect(readFileSync(join(lib, "file-mention.ts"), "utf8")).toContain("mentionAtEnd");
		const bang = readFileSync(join(lib, "bang-command.ts"), "utf8");
		expect(bang).toContain("parseBang");
		expect(bang).toContain("BANG_TIMEOUT_MS = 120_000");
		expect(read("use.md")).toContain("120 seconds");
	});

	test("install.md: installer settings exist in the scripts", () => {
		const sh = readFileSync(join(repo, "scripts/install.sh"), "utf8");
		const ps = readFileSync(join(repo, "scripts/install.ps1"), "utf8");
		const text = read("install.md");
		expect(text).toContain("scripts/install.ps1");
		for (const v of ["EIGHT_VERSION", "EIGHT_INSTALL_DIR"]) {
			expect(text).toContain(v);
			expect(sh).toContain(v);
			expect(ps).toContain(v);
		}
		expect(text).toContain("EIGHT_NO_MODIFY_PATH");
		expect(ps).toContain("EIGHT_NO_MODIFY_PATH");
		expect(text).toContain("install.sh | sh");
		expect(text).toContain("install.ps1 | iex");
	});
});
