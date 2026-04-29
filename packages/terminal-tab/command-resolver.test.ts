/**
 * Tests for command-resolver — the /term args parser.
 */

import { describe, expect, it } from "bun:test";
import { type PresetEntry, resolveTermCommand } from "./command-resolver.js";

const PRESETS: PresetEntry[] = [
	{ id: "claude", label: "Claude Code", command: "claude" },
	{ id: "openclaw", label: "OpenClaw", command: "openclaw" },
	{ id: "8gent", label: "8gent (nested)", command: "8gent" },
];

describe("resolveTermCommand — bare and shell", () => {
	it("/term with no args spawns the shell interactively", () => {
		const r = resolveTermCommand({ args: [], presets: PRESETS, shell: "/bin/zsh" });
		expect(r.command).toBe("/bin/zsh");
		expect(r.args).toEqual(["-i"]);
		expect(r.source).toBe("shell");
		expect(r.label).toContain("zsh");
	});

	it("/term shell is identical to bare /term", () => {
		const r = resolveTermCommand({ args: ["shell"], presets: PRESETS, shell: "/bin/bash" });
		expect(r.command).toBe("/bin/bash");
		expect(r.args).toEqual(["-i"]);
		expect(r.source).toBe("shell");
	});

	it("falls back to /bin/zsh when no shell is configured", () => {
		const r = resolveTermCommand({ args: [], presets: PRESETS, shell: undefined });
		expect(r.command).toMatch(/sh$/);
	});
});

describe("resolveTermCommand — presets", () => {
	it("/term claude resolves to the claude binary in interactive mode", () => {
		const r = resolveTermCommand({ args: ["claude"], presets: PRESETS, shell: "/bin/zsh" });
		expect(r.command).toBe("claude");
		expect(r.args).toEqual([]);
		expect(r.source).toBe("preset");
		expect(r.label).toBe("Claude Code");
	});

	it("preset matching is case-insensitive", () => {
		const r = resolveTermCommand({ args: ["CLAUDE"], presets: PRESETS, shell: "/bin/zsh" });
		expect(r.source).toBe("preset");
		expect(r.command).toBe("claude");
	});

	it("/term 8gent resolves to the 8gent binary", () => {
		const r = resolveTermCommand({ args: ["8gent"], presets: PRESETS, shell: "/bin/zsh" });
		expect(r.command).toBe("8gent");
		expect(r.source).toBe("preset");
	});

	it("/term openclaw onboard is treated as raw (preset+extra args)", () => {
		const r = resolveTermCommand({
			args: ["openclaw", "onboard"],
			presets: PRESETS,
			shell: "/bin/zsh",
		});
		expect(r.source).toBe("raw");
		expect(r.command).toBe("/bin/zsh");
		expect(r.args).toEqual(["-c", "openclaw onboard"]);
	});
});

describe("resolveTermCommand — raw passthrough", () => {
	it("/term ls -la routes through the shell with -c", () => {
		const r = resolveTermCommand({ args: ["ls", "-la"], presets: PRESETS, shell: "/bin/zsh" });
		expect(r.command).toBe("/bin/zsh");
		expect(r.args).toEqual(["-c", "ls -la"]);
		expect(r.source).toBe("raw");
		expect(r.label).toBe("ls -la");
	});

	it("/term unknown-preset routes through the shell (no error)", () => {
		const r = resolveTermCommand({ args: ["nope"], presets: PRESETS, shell: "/bin/zsh" });
		expect(r.source).toBe("raw");
		expect(r.command).toBe("/bin/zsh");
		expect(r.args).toEqual(["-c", "nope"]);
	});

	it("truncates long raw commands when used as a label", () => {
		const long = `echo ${"x".repeat(200)}`;
		const r = resolveTermCommand({ args: long.split(" "), presets: PRESETS, shell: "/bin/zsh" });
		expect(r.label.length).toBeLessThanOrEqual(40);
		expect(r.label.endsWith("…")).toBe(true);
	});
});
