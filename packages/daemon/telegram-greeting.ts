/**
 * Telegram greeting and command list. The greeting names the vessel by its own
 * configured identity (EIGHT_VESSEL_NAME, EIGHT_VESSEL_ROLE) and lists the commands
 * the bridge actually handles, taken from the bridge's own command tables so the text
 * cannot drift from the handlers. No identity configured keeps the plain "Eight" text.
 */

/** One line per command the bridge handles. A test fails if a registered command has none. */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
	"/start": "Show this greeting",
	"/help": "List every command",
	"/status": "Daemon health",
	"/delegate": "Hand a task to a worker",
	"/kill": "Stop a worker",
	"/logs": "Tail the daemon log",
	"/goals": "Show current goals",
	"/voice": "Voice replies on or off",
	"/mode": "Pick how I work",
	"/boardroom": "All officers deliberate on a topic",
	"/cancel": "Stop the current task",
	"/unstick": "Reset the busy state",
	"/plan": "Plan a task",
	"/review": "Review a change",
	"/memoff": "Memory off",
	"/memon": "Memory on",
	"/memwipe": "Erase memory",
};

export interface VesselIdentity {
	name: string;
	role?: string;
}

/** Identity from the environment, or null when the vessel is not configured with one. */
export function vesselIdentity(
	env: Record<string, string | undefined> = process.env,
): VesselIdentity | null {
	const name = env.EIGHT_VESSEL_NAME?.trim();
	if (!name) return null;
	const role = env.EIGHT_VESSEL_ROLE?.trim();
	return { name, ...(role ? { role } : {}) };
}

export function greetingText(opts: {
	identity: VesselIdentity | null;
	mode: string;
	commands: readonly string[];
}): string {
	const { identity, mode, commands } = opts;
	const who = identity
		? `${identity.name}${identity.role ? `, ${identity.role}` : ""} is online`
		: "Eight is online";
	const list = commands.filter((c) => COMMAND_DESCRIPTIONS[c]).join(", ");
	return `${who} (${mode} mode). Commands: ${list}\n\nWhat do we work on next?`;
}
