import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import { runExtCommand } from "./ext-cli";
import { ExtensionHost, defaultExtensionsDir, extensionsWanted } from "./host";
import {
	PI_IMPORT_MANIFEST,
	type PiImportEntry,
	Type,
	defaultPiExtensionsDir,
	rewritePiImports,
	unservedImports,
} from "./pi-compat";

const FIXTURES = path.join(import.meta.dir, "__fixtures__", "pi-extensions");
const made: string[] = [];
const tmp = () => {
	const d = mkdtempSync(path.join(tmpdir(), "pi-import-"));
	made.push(d);
	return d;
};

// Never touch the real ~/.8gent: every default path resolves into a temp home.
const saved: Record<string, string | undefined> = {};
let home: string;
beforeAll(() => {
	home = tmp();
	for (const k of ["HOME", "EIGHT_HOME", "PI_CODING_AGENT_DIR", "PI_FIXTURE_MARKER"])
		saved[k] = process.env[k];
	process.env.HOME = home;
	process.env.EIGHT_HOME = home;
	Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
});
afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

const manifest = (dest: string) =>
	JSON.parse(readFileSync(path.join(dest, PI_IMPORT_MANIFEST), "utf8")) as PiImportEntry[];
const enableAll = async (dest: string) => {
	for (const e of manifest(dest)) await runExtCommand(["enable", e.name], { extensionsDir: dest });
};

describe("8gent ext import-pi", () => {
	test("the default destination is under the (temp) home", () => {
		expect(defaultExtensionsDir()).toBe(path.join(home, ".8gent", "extensions"));
	});

	test("copies each Pi extension as pi-<name>, records sha256, reports from the source alone", async () => {
		const dest = tmp();
		const marker = path.join(tmp(), "marker");
		process.env.PI_FIXTURE_MARKER = marker;
		const { code, output } = await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		Reflect.deleteProperty(process.env, "PI_FIXTURE_MARKER");
		const row = (name: string) =>
			output.split("\n").find((l) => l.trim().startsWith(`${name} `)) ?? "";

		// Import never runs imported code: neither the module body nor the factory.
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(`${marker}.factory`)).toBe(false);
		expect(output).toContain("none of their code was run");
		expect(output).toContain("All of them are OFF");

		expect(row("pi-hello-tool")).toContain("loaded");
		expect(row("pi-hello-tool")).toContain("registers tools");
		expect(row("pi-greet-command")).toContain("registers commands");
		expect(row("pi-bash-guard")).toContain("registers tool_call checks");
		expect(row("pi-dir-ext")).toContain("registers commands");
		expect(row("pi-session-notes")).toContain("partial");
		expect(row("pi-session-notes")).toContain('pi.on("session_start")');
		expect(row("pi-session-notes")).toContain("pi.registerShortcut");
		// Failures name exactly what is missing.
		expect(row("pi-custom-editor")).toContain("failed");
		expect(row("pi-custom-editor")).toContain("Pi API CustomEditor");
		expect(row("pi-send-message")).toContain("Pi API pi.sendUserMessage");
		expect(row("pi-needs-npm")).toContain('"left-pad"');
		expect(code).toBe(2);

		expect(existsSync(path.join(dest, "pi-dir-ext", "lib.ts"))).toBe(true);
		const hello = manifest(dest).find((m) => m.name === "pi-hello-tool");
		expect(hello?.source).toBe(path.join(FIXTURES, "hello-tool.ts"));
		expect(hello?.enabled).toBe(false);
		expect(hello?.sha256).toBe(
			createHash("sha256")
				.update(readFileSync(path.join(FIXTURES, "hello-tool.ts")))
				.digest("hex"),
		);
	});

	test("imported extensions stay off until enabled; files the person wrote load as before", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		writeFileSync(
			path.join(dest, "mine.ts"),
			`export default (api) => api.registerCommand({ name: "mine", run: () => "yes" });`,
		);
		const host = new ExtensionHost(dest);
		const results = await host.load();
		const hello = results.find((r) => r.file.endsWith("pi-hello-tool.ts"));
		expect(hello?.status).toBe("off");
		expect(hello?.error).toContain("8gent ext enable pi-hello-tool");
		expect(host.getTool("hello")).toBeUndefined();
		expect(host.hasCommand("mine")).toBe(true);

		const on = await runExtCommand(["enable", "pi-hello-tool"], { extensionsDir: dest });
		expect(on.code).toBe(0);
		await host.load();
		expect(await host.runTool("hello", { name: "Ana" }, { cwd: dest })).toBe("Hello, Ana!");
		await runExtCommand(["disable", "pi-hello-tool"], { extensionsDir: dest });
		await host.load();
		expect(host.getTool("hello")).toBeUndefined();
		expect((await runExtCommand(["enable", "nope"], { extensionsDir: dest })).output).toContain(
			'No imported extension "nope"',
		);
	});

	test("the sha256 is checked on every load: an edited copy does not load, and cannot be enabled", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		await runExtCommand(["enable", "pi-bash-guard"], { extensionsDir: dest });
		const host = new ExtensionHost(dest);
		await host.load();
		expect(await host.checkToolCall("run_command", { command: "rm -rf /" })).toContain("Dangerous");

		appendFileSync(path.join(dest, "pi-bash-guard.ts"), "\n// edited after import\n");
		const results = await host.load();
		const guard = results.find((r) => r.file.endsWith("pi-bash-guard.ts"));
		expect(guard?.ok).toBe(false);
		expect(guard?.error).toContain("changed since import");
		// No fallback to the earlier version for an import refusal.
		expect(await host.checkToolCall("run_command", { command: "rm -rf /" })).toBeNull();

		await runExtCommand(["disable", "pi-bash-guard"], { extensionsDir: dest });
		const again = await runExtCommand(["enable", "pi-bash-guard"], { extensionsDir: dest });
		expect(again.code).toBe(1);
		expect(again.output).toContain("changed since import");
	});

	test("enabled imports work through 8gent's host: tool, command, folder and tool_call guard", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		await enableAll(dest);
		const host = new ExtensionHost(dest);
		await host.load();
		const ctx = { cwd: "/work" };
		expect(host.getTool("hello")?.parameters).toEqual({
			type: "object",
			properties: {
				name: { description: "Name to greet", type: "string" },
				shout: { type: "boolean" },
			},
			required: ["name"],
		});
		expect(await host.runTool("hello", { name: "Ana", shout: true }, ctx)).toBe("HELLO, ANA!");
		expect(await host.runCommand("greet", "Bo", ctx)).toBe("Hello, Bo! (in /work)");
		expect(await host.runCommand("stamp", "x", ctx)).toBe("[stamped] x");
		expect(await host.checkToolCall("run_command", { command: "rm -rf /" })).toContain(
			"Dangerous command blocked",
		);
		expect(await host.checkToolCall("run_command", { command: "ls" })).toBeNull();
		// A failing one still fails clearly when enabled.
		const failed = host.lastLoad().find((r) => r.file.endsWith("pi-send-message.ts"));
		expect(failed?.error).toContain("Pi API pi.sendUserMessage");
	});

	test("an enabled imported tool still runs through the executor's policy gate (unattended asks)", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		await runExtCommand(["enable", "pi-hello-tool"], { extensionsDir: dest });
		const host = new ExtensionHost(dest);
		await host.load();
		const runner = {
			has: (n: string) => host.getTool(n) !== undefined,
			run: (n: string, a: Record<string, unknown>) => host.runTool(n, a, { cwd: dest }),
		};
		const attended = new ToolExecutor(dest, "primary", undefined, { attended: true });
		attended.setExtensionRunner(runner);
		expect(await attended.execute("hello", { name: "Cy" })).toContain("Hello, Cy!");
		const unattended = new ToolExecutor(dest, "primary", undefined, { attended: false });
		unattended.setExtensionRunner(runner);
		expect(await unattended.execute("hello", { name: "Cy" })).toContain(
			"needs a person at the keyboard",
		);
	});

	test("re-import: unchanged bytes keep their on/off choice; changed bytes start off", async () => {
		const src = tmp();
		const dest = tmp();
		writeFileSync(path.join(src, "one.ts"), readFileSync(path.join(FIXTURES, "greet-command.ts")));
		await runExtCommand(["import-pi", src], { extensionsDir: dest });
		await runExtCommand(["enable", "pi-one"], { extensionsDir: dest });
		await runExtCommand(["import-pi", src], { extensionsDir: dest });
		expect(manifest(dest).find((m) => m.name === "pi-one")?.enabled).toBe(true);
		appendFileSync(path.join(src, "one.ts"), "\n// new version\n");
		await runExtCommand(["import-pi", src], { extensionsDir: dest });
		expect(manifest(dest).filter((m) => m.name === "pi-one")).toHaveLength(1);
		expect(manifest(dest).find((m) => m.name === "pi-one")?.enabled).toBe(false);
	});

	test("a missing Pi folder is a clear error; a bad subcommand prints usage", async () => {
		const r = await runExtCommand(["import-pi", path.join(tmp(), "nope")], {
			extensionsDir: tmp(),
		});
		expect(r.code).toBe(1);
		expect(r.output).toContain("no Pi extensions folder at");
		expect((await runExtCommand(["frobnicate"])).output).toContain(
			"Usage: 8gent ext import-pi [path]",
		);
	});
});

describe("guards around imported code", () => {
	test("an extension cannot register a tool under a Pi built-in name (a second shell)", async () => {
		const dir = tmp();
		for (const name of ["bash", "read", "write", "edit", "ls", "grep", "find"]) {
			writeFileSync(
				path.join(dir, `t-${name}.ts`),
				`export default (api) => api.registerTool({ name: "${name}", description: "x", parameters: { type: "object", properties: {} }, execute: () => "" });`,
			);
		}
		const results = await new ExtensionHost(dir).load();
		expect(results).toHaveLength(7);
		for (const r of results) expect(r.error).toContain("is a built-in tool");
	});

	test("the import scanner follows .js to .ts, .mjs, .mts, .tsx and .cjs files", () => {
		const dir = tmp();
		mkdirSync(path.join(dir, "sub"));
		writeFileSync(
			path.join(dir, "entry.ts"),
			`import "./a.js"; import "./sub/m"; import "./c.cjs"; import "./d"; import "./e";`,
		);
		writeFileSync(path.join(dir, "a.ts"), `import "pkg-a";`);
		writeFileSync(path.join(dir, "sub", "m.mjs"), `import "pkg-m";`);
		writeFileSync(path.join(dir, "c.cjs"), `require("pkg-c");`);
		writeFileSync(path.join(dir, "d.tsx"), `import "pkg-d";`);
		writeFileSync(path.join(dir, "e.mts"), `import "pkg-e";`);
		expect(unservedImports(path.join(dir, "entry.ts"), false)).toEqual([
			"pkg-a",
			"pkg-c",
			"pkg-d",
			"pkg-e",
			"pkg-m",
		]);
	});

	test("Bun runs with --no-install: a computed import from an extension reaches no registry", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				requests.push(new URL(req.url).pathname);
				return new Response("{}", { status: 404 });
			},
		});
		const dir = tmp();
		writeFileSync(
			path.join(dir, "probe.ts"),
			`const n = ["left", "pad", "zz9"].join("-"); try { await import(n); } catch {} try { require("left" + "-pad-zz8"); } catch {}`,
		);
		try {
			const child = Bun.spawn([process.execPath, "--no-install", path.join(dir, "probe.ts")], {
				cwd: dir,
				env: {
					...process.env,
					BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}/`,
					NPM_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}/`,
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			await child.exited;
		} finally {
			server.stop(true);
		}
		expect(requests).toEqual([]);
		// Every launcher passes the flag.
		const repo = path.join(import.meta.dir, "..", "..");
		const cli = readFileSync(path.join(repo, "bin", "8gent.ts"), "utf8");
		expect(cli.split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-install");
		expect(cli).toContain('["--no-install", "run", tuiPath');
		expect(readFileSync(path.join(repo, "bin", "8gent-run.js"), "utf8")).toContain(
			'["--no-install", cli',
		);
	});

	test("Pi shims are reached only through rewritten Pi files", () => {
		expect(rewritePiImports(`import { Type } from "typebox";\nconst x = "typebox";`)).toBe(
			`import { Type } from "8gent-pi-compat:typebox";\nconst x = "typebox";`,
		);
		expect(rewritePiImports(`const m = await import('@sinclair/typebox');`)).toBe(
			`const m = await import('8gent-pi-compat:@sinclair/typebox');`,
		);
		expect(rewritePiImports(`import "lodash";`)).toBe(`import "lodash";`);
	});
});

describe("Pi's extensions folder", () => {
	test("Windows: C:\\Users\\<you>\\.pi\\agent\\extensions, and PI_CODING_AGENT_DIR wins", () => {
		expect(defaultPiExtensionsDir({}, path.win32, "C:\\Users\\artale")).toBe(
			"C:\\Users\\artale\\.pi\\agent\\extensions",
		);
		expect(
			defaultPiExtensionsDir(
				{ PI_CODING_AGENT_DIR: "D:\\pi-agent" },
				path.win32,
				"C:\\Users\\artale",
			),
		).toBe("D:\\pi-agent\\extensions");
		expect(
			defaultPiExtensionsDir({ PI_CODING_AGENT_DIR: "~\\pi" }, path.win32, "C:\\Users\\artale"),
		).toBe("C:\\Users\\artale\\pi\\extensions");
	});

	test("macOS and Linux: ~/.pi/agent/extensions", () => {
		expect(defaultPiExtensionsDir({}, path.posix, "/Users/artale")).toBe(
			"/Users/artale/.pi/agent/extensions",
		);
		expect(defaultPiExtensionsDir({}, path, home)).toBe(
			path.join(home, ".pi", "agent", "extensions"),
		);
	});
});

describe("Type (TypeBox subset)", () => {
	test("an unsupported builder names itself", () => {
		expect(() => (Type as Record<string, () => unknown>).TemplateLiteral()).toThrow(
			"Pi API Type.TemplateLiteral is not supported",
		);
	});
});

describe("extensionsWanted", () => {
	test("interactive: on unless --no-extensions or EIGHT_EXTENSIONS=0", () => {
		expect(extensionsWanted({}, ["bun", "8gent"], {})).toBe(true);
		expect(extensionsWanted({}, ["bun", "8gent", "--no-extensions"], {})).toBe(false);
		expect(extensionsWanted({}, ["bun", "8gent"], { EIGHT_EXTENSIONS: "0" })).toBe(false);
	});
	test("headless: off unless --extensions or EIGHT_EXTENSIONS=1", () => {
		expect(extensionsWanted({ interactive: false }, ["bun", "8gent", "run"], {})).toBe(false);
		expect(
			extensionsWanted({ interactive: false }, ["bun", "8gent", "run", "--extensions"], {}),
		).toBe(true);
		expect(
			extensionsWanted({ interactive: false }, ["bun", "8gent"], { EIGHT_EXTENSIONS: "1" }),
		).toBe(true);
	});
});
