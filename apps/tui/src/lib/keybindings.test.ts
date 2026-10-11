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
	M: "Ctrl+Shift+M: terminals send it as Ctrl+M, which most send as Enter; /provider is listed",
	o: "sets expandedView, which no view has drawn since #2350 (#4008)",
	k: "kanban view not drawn since #2350 (#4008)",
	b: "process sidebar draws nothing visible since #2350 (#4008)",
	e: "predict view not drawn since #2350 (#4008)",
	n: "Notes tab: utility tabs not drawn since #2350 (#4008)",
	j: "background jobs panel not drawn since #2350 (#4008)",
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

/** Listed Ctrl keys the screen test cannot press, and why. */
const NOT_PRESSED: Record<string, string> = {
	"Ctrl+C": "quits the App",
	"Ctrl+R": "opens the microphone",
	"Ctrl+D": "acts only with a DJ track loaded",
};

test("every listed Ctrl key changes the screen in the real App", async () => {
	const { runAppHarness } = await import("../__tests__/app-driver.js");
	const harness = path.join(import.meta.dir, "../__tests__/keys-screen.harness.tsx");
	const events = await runAppHarness(harness);
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	const changed = new Map(
		events.filter((e) => e.phase === "probe").map((e) => [e.key as string, e.changed as boolean]),
	);
	for (const b of KEYBINDINGS) {
		if (!/^Ctrl\+[A-Z]$/.test(b.keys) || b.keys in NOT_PRESSED) continue;
		expect({ key: b.keys, changed: changed.get(b.keys) }).toEqual({ key: b.keys, changed: true });
	}
}, 90000);
