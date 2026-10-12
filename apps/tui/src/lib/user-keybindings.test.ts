import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYBINDINGS } from "./keybindings.js";
import { actionId, loadUserKeybindings, normalizeChord, validateKeybindings } from "./user-keybindings.js";

const homes: string[] = [];
afterEach(() => {
	for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function homeWith(content?: string): NodeJS.ProcessEnv {
	const h = mkdtempSync(join(tmpdir(), "kb-"));
	homes.push(h);
	if (content !== undefined) {
		mkdirSync(join(h, ".8gent"));
		writeFileSync(join(h, ".8gent", "keybindings.json"), content);
	}
	return { EIGHT_HOME: h } as NodeJS.ProcessEnv;
}

describe("normalizeChord", () => {
	test("canonicalizes", () => {
		expect(normalizeChord("ctrl+k")).toBe("Ctrl+K");
		expect(normalizeChord("shift+alt+f5")).toBe("Alt+Shift+F5");
		expect(normalizeChord("enter")).toBe("Enter");
		for (const bad of ["", "Ctrl+", "Ctrl+Ctrl+K", "Hyper+K", "Ctrl+KK", "Ctrl K"]) expect(normalizeChord(bad)).toBeNull();
	});
});

describe("loadUserKeybindings", () => {
	test("no file: nothing, no errors", () => {
		expect(loadUserKeybindings(homeWith())).toEqual({ overrides: {}, errors: [] });
	});
	test("applies overrides by action text or slug", () => {
		const r = loadUserKeybindings(homeWith(JSON.stringify({ "model picker": "ctrl+k", [actionId("Open or close the PLAN column")]: "Alt+P" })));
		expect(r.errors).toEqual([]);
		expect(r.overrides).toEqual({ "Ctrl+L": "Ctrl+K", "Ctrl+X": "Alt+P" });
	});
	test("corrupt JSON and wrong shapes never throw", () => {
		expect(loadUserKeybindings(homeWith("{nope")).errors[0]).toContain("not valid JSON");
		expect(loadUserKeybindings(homeWith("[1]")).errors.length).toBe(1);
		expect(loadUserKeybindings(homeWith("null")).errors.length).toBe(1);
	});
	test("reports bad entries and keeps the good ones", () => {
		const r = loadUserKeybindings(homeWith(JSON.stringify({ "Model picker": "Ctrl+K", "No such thing": "Ctrl+Q", "Command palette": 5, "Cycle the work mode": "Banana", Enter: "Ctrl+Z" })));
		expect(r.overrides).toEqual({ "Ctrl+L": "Ctrl+K" });
		expect(r.errors.length).toBe(4);
		expect(r.errors.join("\n")).toContain("no such action");
	});
});

describe("Ctrl+C is protected", () => {
	test("cannot move quit", () => {
		const r = validateKeybindings({ "Save the session and quit": "Ctrl+Q" });
		expect(r.overrides).toEqual({});
		expect(r.errors[0]).toContain("Ctrl+C");
	});
	test("nothing can take Ctrl+C", () => {
		const r = validateKeybindings({ "Model picker": "ctrl+c" });
		expect(r.overrides).toEqual({});
		expect(r.errors[0]).toContain("reserved");
	});
	test("rebinding quit to Ctrl+C itself is a harmless no-op", () => {
		expect(validateKeybindings({ "Save the session and quit": "Ctrl+C" }).errors).toEqual([]);
	});
});

describe("collisions and non-chord rows", () => {
	test("taking another action's key is rejected; swapping two is allowed", () => {
		const r = validateKeybindings({ "Model picker": "Ctrl+P" });
		expect(r.overrides).toEqual({});
		expect(r.errors[0]).toContain("already used");
		const swap = validateKeybindings({ "Model picker": "Ctrl+P", "Command palette": "Ctrl+L" });
		expect(swap.errors).toEqual([]);
		expect(swap.overrides).toEqual({ "Ctrl+L": "Ctrl+P", "Ctrl+P": "Ctrl+L" });
	});
	test("two actions to one new key are both rejected", () => {
		const r = validateKeybindings({ "Model picker": "Ctrl+K", "Command palette": "Ctrl+K" });
		expect(r.overrides).toEqual({});
		expect(r.errors.length).toBe(2);
	});
	test("rows that are not a single key cannot be rebound", () => {
		const r = validateKeybindings({ "Switch to tab by number": "Ctrl+N" });
		expect(r.errors[0]).toContain("cannot be rebound");
	});
	test("permission mode, stop and quit cannot be rebound", () => {
		for (const name of ["Permission mode: Plan, Ask, Guarded, Infinite", "Stop the running task, or close the open view", "Save the session and quit"]) {
			const r = validateKeybindings({ [name]: "Ctrl+K" });
			expect(r.overrides).toEqual({});
			expect(r.errors.length).toBe(1);
		}
	});
	test("nothing may be bound onto Enter, Esc, Tab, Up or Down", () => {
		for (const k of ["Enter", "Esc", "Tab", "Up", "Down"]) {
			const r = validateKeybindings({ "Model picker": k });
			expect(r.overrides).toEqual({});
			expect(r.errors[0]).toContain("reserved");
		}
	});
	test("a swap of Enter and Shift+Tab is refused on both sides", () => {
		const r = validateKeybindings({
			"Permission mode: Plan, Ask, Guarded, Infinite": "Enter",
			"Send the message (queued while a task runs)": "Shift+Tab",
		});
		expect(r.overrides).toEqual({});
		expect(r.errors.length).toBe(2);
	});
	test("table sanity: Ctrl+C row exists", () => {
		expect(KEYBINDINGS.some((b) => b.keys === "Ctrl+C")).toBe(true);
	});
});
