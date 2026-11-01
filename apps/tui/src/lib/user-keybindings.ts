/**
 * User key overrides (Pi parity row D8, module side).
 *
 * ~/.8gent/keybindings.json maps an action to a key:
 *   { "Model picker": "Ctrl+K", "new-chat-tab": "Ctrl+N" }
 * An action is named by its text in the KEYBINDINGS table (any case) or by its
 * slug (actionId). Values are one chord: modifiers Ctrl/Alt/Shift joined by "+"
 * and one key ("L", "Enter", "F5"). Bad entries are skipped and described in
 * `errors`; a missing or corrupt file never throws. Ctrl+C stays "Save the
 * session and quit": nothing can take it and quit cannot leave it.
 * Wiring into app.tsx is another lane.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../../../../packages/core/home.js";
import { KEYBINDINGS, type KeyBinding } from "./keybindings.js";

export interface UserKeybindings {
	/** Valid overrides: the table's `keys` string for that action -> new chord, e.g. "Ctrl+L" -> "Ctrl+K". */
	overrides: Record<string, string>;
	/** Human-readable problems, one per rejected entry (or file-level problem). */
	errors: string[];
}

export function keybindingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveHome(env), ".8gent", "keybindings.json");
}

/** Stable id for an action: lowercase words joined by "-", at most 6 words. */
export function actionId(action: string): string {
	return action
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.slice(0, 6)
		.join("-");
}

/** Keys that stay where they are: rebinding these actions could move quit, stop or the permission mode. */
const LOCKED_ACTION_KEYS = new Set(["Ctrl+C", "Esc", "Shift+Tab"]);
/** Plain keys no action may be bound onto: they carry send, stop, focus and history. */
const RESERVED_TARGETS = new Set(["Enter", "Esc", "Tab", "Up", "Down"]);

const MODS = ["ctrl", "alt", "shift"] as const;
const NAMED = new Set(["enter", "esc", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

/** Canonical chord ("Ctrl+L", "Alt+Shift+F5") or null when it is not one. */
export function normalizeChord(raw: string): string | null {
	const parts = raw.split("+").map((p) => p.trim());
	if (parts.length === 0 || parts.some((p) => p === "")) return null;
	const key = parts[parts.length - 1];
	const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
	if (mods.size !== parts.length - 1) return null;
	for (const m of mods) if (!(MODS as readonly string[]).includes(m)) return null;
	let k: string;
	if (key.length === 1) k = key.toUpperCase();
	else if (/^f([1-9]|1[0-2])$/i.test(key)) k = key.toUpperCase();
	else if (NAMED.has(key.toLowerCase())) k = key[0].toUpperCase() + key.slice(1).toLowerCase();
	else return null;
	const ordered = MODS.filter((m) => mods.has(m)).map((m) => m[0].toUpperCase() + m.slice(1));
	return [...ordered, k].join("+");
}

function isChord(keys: string): boolean {
	return normalizeChord(keys) !== null;
}

function findAction(name: string, table: readonly KeyBinding[]): KeyBinding | null {
	const lower = name.trim().toLowerCase();
	return table.find((b) => b.action.toLowerCase() === lower || actionId(b.action) === lower) ?? null;
}

/** Validate a parsed keybindings object against the table. Pure. */
export function validateKeybindings(input: unknown, table: readonly KeyBinding[] = KEYBINDINGS): UserKeybindings {
	const errors: string[] = [];
	const overrides: Record<string, string> = {};
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { overrides, errors: ["keybindings.json must be an object of action: key pairs."] };
	}
	const taken = new Map<string, string>(); // chord -> action text that ends up holding it
	for (const b of table) if (isChord(b.keys)) taken.set(normalizeChord(b.keys) as string, b.action);
	const chosen = new Map<string, string>(); // action text -> new chord
	for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
		const row = findAction(name, table);
		if (!row) {
			errors.push(`"${name}": no such action. Run /hotkeys for the list.`);
			continue;
		}
		if (typeof value !== "string") {
			errors.push(`"${name}": the key must be text such as "Ctrl+K".`);
			continue;
		}
		const chord = normalizeChord(value);
		if (!chord) {
			errors.push(`"${name}": "${value}" is not a key. Use e.g. "Ctrl+K", "Alt+Shift+F5".`);
			continue;
		}
		if (!isChord(row.keys)) {
			errors.push(`"${name}": this action cannot be rebound (it is not a single key).`);
			continue;
		}
		const own = normalizeChord(row.keys) as string;
		if (LOCKED_ACTION_KEYS.has(own)) {
			if (chord !== own) errors.push(`"${name}": this action (${own}) is fixed and cannot be rebound.`);
			continue;
		}
		if (RESERVED_TARGETS.has(chord)) {
			errors.push(`"${name}": ${chord} is reserved and cannot be bound to another action.`);
			continue;
		}
		if (chord === "Ctrl+C") {
			errors.push(`"${name}": Ctrl+C is reserved for quit.`);
			continue;
		}
		chosen.set(row.action, chord);
		overrides[row.keys] = chord;
	}
	// Collisions: the final key map must give each chord to one action.
	const finalOwner = new Map<string, string[]>();
	for (const b of table) {
		if (!isChord(b.keys)) continue;
		const c = chosen.get(b.action) ?? (normalizeChord(b.keys) as string);
		finalOwner.set(c, [...(finalOwner.get(c) ?? []), b.action]);
	}
	for (const [chord, owners] of finalOwner) {
		if (owners.length < 2) continue;
		const movers = owners.filter((o) => chosen.has(o));
		if (movers.length === 0) continue;
		for (const o of movers) {
			const row = table.find((b) => b.action === o) as KeyBinding;
			errors.push(`"${o}": ${chord} is already used by "${owners.find((x) => x !== o)}".`);
			delete overrides[row.keys];
		}
	}
	return { overrides, errors };
}

/** Load and validate the user's file. Missing file = no overrides, no errors. Never throws. */
export function loadUserKeybindings(
	env: NodeJS.ProcessEnv = process.env,
	table: readonly KeyBinding[] = KEYBINDINGS,
): UserKeybindings {
	const file = keybindingsPath(env);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { overrides: {}, errors: [] };
		return { overrides: {}, errors: [`Could not read ${file}: ${(e as Error).message}`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { overrides: {}, errors: [`${file} is not valid JSON: ${(e as Error).message}`] };
	}
	return validateKeybindings(parsed, table);
}
