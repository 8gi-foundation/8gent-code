import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import { runExtCommand } from "./ext-cli";
import { ExtensionHost, extensionsWanted } from "./host";
import { PI_IMPORT_MANIFEST, type PiImportEntry, Type, defaultPiExtensionsDir } from "./pi-compat";

const FIXTURES = path.join(import.meta.dir, "__fixtures__", "pi-extensions");
const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(path.join(tmpdir(), "pi-import-"));
	made.push(d);
	return d;
};

describe("8gent ext import-pi", () => {
	test("copies each Pi extension as pi-<name>, records sha256, reports loaded / partial / failed", async () => {
		const dest = tmp();
		const { code, output } = await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		const row = (name: string) =>
			output.split("\n").find((l) => l.trim().startsWith(`${name} `)) ?? "";

		expect(row("pi-hello-tool")).toContain("loaded");
		expect(row("pi-hello-tool")).toContain("tools: hello");
		expect(row("pi-greet-command")).toContain("loaded");
		expect(row("pi-greet-command")).toContain("/greet");
		expect(row("pi-bash-guard")).toContain("loaded");
		expect(row("pi-dir-ext")).toContain("/stamp");
		expect(row("pi-session-notes")).toContain("partial");
		expect(row("pi-session-notes")).toContain('pi.on("session_start")');
		expect(row("pi-session-notes")).toContain("pi.registerShortcut");
		// Failures name exactly what is missing.
		expect(row("pi-custom-editor")).toContain("failed");
		expect(row("pi-custom-editor")).toContain("Pi API CustomEditor");
		expect(row("pi-send-message")).toContain("failed");
		expect(row("pi-send-message")).toContain("pi.sendUserMessage");
		expect(row("pi-needs-npm")).toContain("failed");
		expect(row("pi-needs-npm")).toContain('"left-pad"');
		expect(code).toBe(2);

		expect(existsSync(path.join(dest, "pi-hello-tool.ts"))).toBe(true);
		expect(existsSync(path.join(dest, "pi-dir-ext", "index.ts"))).toBe(true);
		expect(existsSync(path.join(dest, "pi-dir-ext", "lib.ts"))).toBe(true);
		const manifest = JSON.parse(
			readFileSync(path.join(dest, PI_IMPORT_MANIFEST), "utf8"),
		) as PiImportEntry[];
		const hello = manifest.find((m) => m.name === "pi-hello-tool");
		expect(hello?.source).toBe(path.join(FIXTURES, "hello-tool.ts"));
		expect(hello?.sha256).toBe(
			createHash("sha256")
				.update(readFileSync(path.join(FIXTURES, "hello-tool.ts")))
				.digest("hex"),
		);
		expect(manifest.find((m) => m.name === "pi-dir-ext")?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("imported tool, command and tool_call guard work through 8gent's host", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		const host = new ExtensionHost(dest);
		await host.load();
		const ctx = { cwd: "/work" };

		const hello = host.getTool("hello");
		expect(hello?.parameters).toEqual({
			type: "object",
			properties: {
				name: { description: "Name to greet", type: "string" },
				shout: { type: "boolean" },
			},
			required: ["name"],
		});
		expect(await host.runTool("hello", { name: "Ana" }, ctx)).toBe("Hello, Ana!");
		expect(await host.runTool("hello", { name: "Ana", shout: true }, ctx)).toBe("HELLO, ANA!");
		expect(await host.runCommand("greet", "Bo", ctx)).toBe("Hello, Bo! (in /work)");
		expect(await host.runCommand("stamp", "x", ctx)).toBe("[stamped] x");

		// Pi calls our run_command "bash": the guard sees the same name it was written for.
		expect(await host.checkToolCall("run_command", { command: "rm -rf /" })).toContain(
			"Dangerous command blocked",
		);
		expect(await host.checkToolCall("run_command", { command: "ls" })).toBeNull();
		expect(await host.checkToolCall("read_file", { path: "a" })).toBeNull();
	});

	test("an imported tool runs through the executor's policy gate (unattended asks)", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
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

	test("re-import replaces the copy and keeps one manifest entry per extension", async () => {
		const dest = tmp();
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		await runExtCommand(["import-pi", FIXTURES], { extensionsDir: dest });
		const manifest = JSON.parse(
			readFileSync(path.join(dest, PI_IMPORT_MANIFEST), "utf8"),
		) as PiImportEntry[];
		expect(manifest.filter((m) => m.name === "pi-hello-tool")).toHaveLength(1);
	});

	test("a missing Pi folder is a clear error; a bad subcommand prints usage", async () => {
		const r = await runExtCommand(["import-pi", path.join(tmp(), "nope")], {
			extensionsDir: tmp(),
		});
		expect(r.code).toBe(1);
		expect(r.output).toContain("no Pi extensions folder at");
		expect((await runExtCommand(["frobnicate"])).output).toContain("Usage: 8gent ext import-pi [path]");
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
		expect(
			defaultPiExtensionsDir({ PI_CODING_AGENT_DIR: "~/pi" }, path.posix, "/Users/artale"),
		).toBe("/Users/artale/pi/extensions");
	});
});

describe("Type (TypeBox subset)", () => {
	test("an unsupported builder names itself", () => {
		expect(() => (Type as Record<string, () => unknown>).TemplateLiteral()).toThrow(
			"Pi API Type.TemplateLiteral is not supported",
		);
	});
});

describe("extensionsWanted (the TUI and headless wiring)", () => {
	test("on by default; --no-extensions or EIGHT_EXTENSIONS=0 turns it off", () => {
		expect(extensionsWanted(["bun", "8gent"], {})).toBe(true);
		expect(extensionsWanted(["bun", "8gent", "--no-extensions"], {})).toBe(false);
		expect(extensionsWanted(["bun", "8gent"], { EIGHT_EXTENSIONS: "0" })).toBe(false);
	});
});
