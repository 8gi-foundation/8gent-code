/**
 * One spelling for a key combo, so a block list cannot be walked around.
 *
 * The actuators (packages/hands: cliclick and osascript) split a combo on "+",
 * accept "command"/"control"/"option" as modifiers, and press the LAST
 * non-modifier token. So "Command+Q", "shift+cmd+q" and "q+cmd" all fire a
 * quit, while an exact-string block list sees three strings it does not know.
 * normalizeKeys mirrors the actuators' reading and returns a canonical form:
 * lower case, aliases folded, modifiers in a fixed order, then the key.
 *
 * isDangerousCombo blocks a combo whose key matches a blocked combo's key and
 * whose modifiers include all of that combo's modifiers, so cmd+q also covers
 * cmd+shift+q and cmd+alt+q.
 */

const MODIFIER_ALIASES: Record<string, string> = {
	cmd: "cmd",
	command: "cmd",
	"⌘": "cmd",
	meta: "cmd",
	super: "cmd",
	ctrl: "ctrl",
	control: "ctrl",
	ctl: "ctrl",
	"^": "ctrl",
	alt: "alt",
	opt: "alt",
	option: "alt",
	"⌥": "alt",
	shift: "shift",
	"⇧": "shift",
	fn: "fn",
};

const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift", "fn"];

/** Keys that the actuators treat as the same physical key, folded for matching. */
const KEY_ALIASES: Record<string, string> = {
	escape: "esc",
	return: "enter",
	del: "delete",
	backspace: "delete",
	"fwd-delete": "delete",
	forwarddelete: "delete",
};

export interface Combo {
	mods: string[];
	key: string;
}

export function parseCombo(raw: string): Combo {
	const parts = String(raw ?? "")
		.toLowerCase()
		.split("+")
		.map((s) => s.trim())
		.filter(Boolean);
	const mods = new Set<string>();
	let key = "";
	for (const p of parts) {
		const m = MODIFIER_ALIASES[p];
		if (m) mods.add(m);
		else key = KEY_ALIASES[p] ?? p; // last non-modifier wins, as in the actuators
	}
	return { mods: MODIFIER_ORDER.filter((m) => mods.has(m)), key };
}

/** "Shift+Command+Q" -> "cmd+shift+q". */
export function normalizeKeys(raw: string): string {
	const c = parseCombo(raw);
	return [...c.mods, c.key].filter(Boolean).join("+");
}

/** Quit, close, log out, force-quit, system interrupt, clear browsing data. */
export const BLOCKED_COMBOS: readonly string[] = [
	"cmd+q",
	"cmd+w",
	"cmd+shift+q",
	"cmd+alt+esc",
	"alt+f4",
	"ctrl+alt+delete",
	"ctrl+shift+delete",
];

/** The blocked combo this one would fire, or null. */
export function isDangerousCombo(raw: string): string | null {
	const c = parseCombo(raw);
	if (!c.key) return null;
	for (const b of BLOCKED_COMBOS) {
		const bc = parseCombo(b);
		if (bc.key === c.key && bc.mods.every((m) => c.mods.includes(m))) return b;
	}
	return null;
}
