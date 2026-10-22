/**
 * Every key the TUI binds, in one table. /hotkeys and /help print it, so the
 * list a person reads is the list the code keeps (#3918, Pi gap D8).
 *
 * When you bind a key in app.tsx (or a component that owns a global key),
 * add its row here; keybindings.test.ts checks app.tsx against this table and
 * presses each Ctrl key in the real App to see the screen change. A key whose
 * view is not drawn stays out of the table until it is (#4008).
 */

export type KeyGroup = "core" | "prompt" | "tabs" | "views" | "extras";

export interface KeyBinding {
	/** As a person types it: "Ctrl+L", "Shift+Tab", "Ctrl+1-9". */
	keys: string;
	action: string;
	group: KeyGroup;
}

export const KEYBINDINGS: readonly KeyBinding[] = [
	{ keys: "Enter", action: "Send the message (queued while a task runs)", group: "core" },
	{ keys: "Esc", action: "Stop the running task, or close the open view", group: "core" },
	{ keys: "Tab", action: "Accept the grey suggestion", group: "core" },
	{ keys: "Up / Down", action: "Previous / next message you sent", group: "core" },
	{ keys: "Shift+Tab", action: "Permission mode: Plan, Ask, Guarded, Infinite", group: "core" },
	{ keys: "Ctrl+L", action: "Model picker", group: "core" },
	{ keys: "/provider", action: "Provider picker", group: "core" },
	{ keys: "Ctrl+P", action: "Command palette", group: "core" },
	{ keys: "Ctrl+C", action: "Save the session and quit", group: "core" },
	{ keys: "@", action: "Pick a project file; Tab inserts its path", group: "prompt" },
	{
		keys: "!cmd",
		action: "Run a shell command; output goes with your next message",
		group: "prompt",
	},
	{ keys: "!!cmd", action: "Run a shell command; output stays here", group: "prompt" },
	{ keys: "Ctrl+T", action: "New chat tab", group: "tabs" },
	{ keys: "Ctrl+W", action: "Close the current tab", group: "tabs" },
	{ keys: "Ctrl+1-9", action: "Switch to tab by number", group: "tabs" },
	{ keys: "Ctrl+X", action: "Open or close the PLAN column", group: "views" },
	{ keys: "Ctrl+F", action: "Live view of the session in 8gent Browser", group: "views" },
	{ keys: "Ctrl+Y", action: "Cycle the work mode", group: "views" },
	{ keys: "Ctrl+G", action: "Send the running task to the background", group: "views" },
	{ keys: "Ctrl+R", action: "Start or stop voice input", group: "extras" },
	{
		keys: "Ctrl+D",
		action: "Hand the keyboard to the DJ deck (with a track loaded)",
		group: "extras",
	},
	{ keys: "Ctrl+A", action: "Animations on or off", group: "extras" },
	{ keys: "Ctrl+S", action: "Sound on or off", group: "extras" },
];

/**
 * Termux and other phone terminals send Ctrl+digit as the bare digit, so the
 * tab shortcut types a number instead of switching (#4723). On those, the same
 * action is bound to Alt+digit: on Termux tap the ALT key on the extra-keys
 * row, then the digit; ESC then the digit is two keypresses and does not
 * work. Decided from the environment only, never a probe:
 * TERMUX_VERSION, or EIGHT_ALT_DIGIT_KEYS=1 to force it on any terminal.
 */
export function altDigitKeys(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_ALT_DIGIT_KEYS === "1" || Boolean(env.TERMUX_VERSION);
}

/** The table with the tab-number row showing a key this terminal can send. */
export function bindingsFor(
	env: Record<string, string | undefined> = process.env,
): readonly KeyBinding[] {
	if (!altDigitKeys(env)) return KEYBINDINGS;
	return KEYBINDINGS.map((b) => (b.keys === "Ctrl+1-9" ? { ...b, keys: "Alt+1-9" } : b));
}

const GROUP_TITLES: Record<KeyGroup, string> = {
	core: "Core",
	prompt: "Prompt",
	tabs: "Tabs",
	views: "Views",
	extras: "Extras",
};

/** The /hotkeys text: every binding, grouped, keys aligned. */
export function formatHotkeys(bindings: readonly KeyBinding[] = bindingsFor()): string {
	return `Keyboard shortcuts:\n${formatHotkeyRows(bindings)}`;
}

/** The grouped rows without the heading, for /help. */
export function formatHotkeyRows(bindings: readonly KeyBinding[] = bindingsFor()): string {
	const width = Math.max(...bindings.map((b) => b.keys.length));
	const out: string[] = [];
	for (const group of Object.keys(GROUP_TITLES) as KeyGroup[]) {
		const rows = bindings.filter((b) => b.group === group);
		if (rows.length === 0) continue;
		out.push(`${GROUP_TITLES[group]}:`);
		for (const b of rows) out.push(`  ${b.keys.padEnd(width)}  ${b.action}`);
	}
	return out.join("\n");
}
