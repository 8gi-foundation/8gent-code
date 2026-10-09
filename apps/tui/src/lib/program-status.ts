/**
 * Program status (OSC 7501, Mitchell Hashimoto's proposal). Tells the host
 * terminal whether the agent is working, blocked on the user, done, errored
 * or idle, so a tab or dock can show it. Terminals that do not know OSC 7501
 * ignore it ("well-behaved terminals ignore unknown OSCs"), so this is safe,
 * but we still only write on a real TTY and honour EIGHT_NO_PROGRAM_STATUS=1.
 *
 * Format: ESC ] 7501 ; state=<s>[:kind=<k>]:app=8gent ESC \
 */

export type ProgramState = "idle" | "working" | "blocked" | "done" | "error" | "clear";

const ESC = "\x1b";

export function programStatusSequence(state: ProgramState): string {
	const kind = state === "blocked" ? ":kind=permission" : "";
	return `${ESC}]7501;state=${state}${kind}:app=8gent${ESC}\\`;
}

export function programStatusEnabled(
	stream: { isTTY?: boolean },
	env: Record<string, string | undefined>,
): boolean {
	if (!stream.isTTY) return false;
	const optOut = env.EIGHT_NO_PROGRAM_STATUS;
	if (optOut && optOut !== "0") return false;
	if (env.TERM === "dumb") return false;
	return true;
}

export function deriveProgramState(i: {
	isProcessing: boolean;
	approvalPending: boolean;
	lastTurn: "ok" | "error" | null;
}): Exclude<ProgramState, "clear"> {
	if (i.approvalPending) return "blocked";
	if (i.isProcessing) return "working";
	if (i.lastTurn === "ok") return "done";
	if (i.lastTurn === "error") return "error";
	return "idle";
}

export function createProgramStatusEmitter(
	stream: { isTTY?: boolean; write: (s: string) => unknown },
	env: Record<string, string | undefined> = process.env,
) {
	const enabled = programStatusEnabled(stream, env);
	let last: ProgramState | null = null;
	const emit = (state: ProgramState) => {
		if (!enabled || state === last) return;
		last = state;
		try {
			stream.write(programStatusSequence(state));
		} catch {}
	};
	return { set: emit, clear: () => emit("clear") };
}
