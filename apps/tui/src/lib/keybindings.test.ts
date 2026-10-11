import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KEYBINDINGS, formatHotkeys } from "./keybindings.js";

const SRC = path.join(import.meta.dir, "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");

/** Files that bind a global Ctrl key, besides app.tsx. */
const OTHER_BINDERS: Record<string, string> = { r: "hooks/useVoiceInput.ts" };

/**
 * Ctrl keys app.tsx handles but /hotkeys does not teach, and why. Adding a
 * key here is a decision; the test fails until it is made.
 */
const UNLISTED: Record<string, string> = {
	m: "alias of Ctrl+L; most terminals send Ctrl+M as Enter",
	M: "Ctrl+Shift+M, listed as such",
	o: "sets expandedView, which no view has drawn since #2350",
	k: "kanban overlay draws nothing visible (footer-clicks.test.tsx)",
	b: "process sidebar draws nothing visible (footer-clicks.test.tsx)",
};

function ctrlLettersIn(src: string): Set<string> {
	const out = new Set<string>();
	for (const m of src.matchAll(/key\.ctrl && \(?input === "([a-zA-Z])"/g)) out.add(m[1]);
	for (const m of src.matchAll(/\|\| \(input === "([a-zA-Z])"/g)) out.add(m[1]);
	return out;
}

describe("keybindings table (#3918 D8)", () => {
	const app = read("app.tsx");
	const bound = ctrlLettersIn(app);

	test("every listed Ctrl+letter is really bound", () => {
		for (const b of KEYBINDINGS) {
			const m = b.keys.match(/^Ctrl\+(?:Shift\+)?([A-Z])$/);
			if (!m) continue;
			const letter = b.keys.includes("Shift+") ? m[1] : m[1].toLowerCase();
			const file = OTHER_BINDERS[letter];
			const ok = file ? ctrlLettersIn(read(file)).has(letter) : bound.has(letter);
			expect({ key: b.keys, bound: ok }).toEqual({ key: b.keys, bound: true });
		}
	});

	test("every Ctrl+letter app.tsx binds is listed or explained", () => {
		const listed = new Set(
			KEYBINDINGS.map((b) => b.keys.match(/^Ctrl\+([A-Z])$/)?.[1]?.toLowerCase()).filter(Boolean),
		);
		for (const letter of bound) {
			expect({ letter, covered: listed.has(letter) || letter in UNLISTED }).toEqual({
				letter,
				covered: true,
			});
		}
	});

	test("Ctrl+L is the model picker, once", () => {
		expect(KEYBINDINGS.find((b) => b.keys === "Ctrl+L")?.action).toBe("Model picker");
		expect(KEYBINDINGS.filter((b) => b.keys === "Ctrl+L")).toHaveLength(1);
	});

	test("/hotkeys prints every binding once", () => {
		const text = formatHotkeys();
		for (const b of KEYBINDINGS) expect(text).toContain(b.action);
		expect(new Set(KEYBINDINGS.map((b) => b.keys)).size).toBe(KEYBINDINGS.length);
	});
});
