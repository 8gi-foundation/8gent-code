/**
 * /consult in the TUI (#4608). The reply is shown with the person's own values
 * filled back in, so it must not be saved: the tab file and session saves skip
 * every message whose id starts with CONSULT_ID_PREFIX, the same way they skip
 * `!cmd` lines. The reply lives on screen for this run only.
 */
export const CONSULT_ID_PREFIX = "consult-";

/** Messages to save: everything except /consult lines. */
export function withoutConsultLines<T extends { id?: string }>(messages: readonly T[]): T[] {
	return messages.filter((m) => !m.id?.startsWith(CONSULT_ID_PREFIX));
}

export interface ConsultIO {
	/** Show a line in the chat. The caller must give it the id it is handed. */
	add: (line: { id: string; content: string }) => void;
	consult: (question: string) => Promise<string>;
	/** Runs after the call, for the status chip. */
	after?: () => void;
}

let seq = 0;
const nextId = () => `${CONSULT_ID_PREFIX}${Date.now()}-${seq++}`;

/** Run /consult. Every line it shows has a consult- id, including errors. Never throws. */
export async function runConsultCommand(question: string, io: ConsultIO): Promise<void> {
	try {
		io.add({ id: nextId(), content: "Consulting the cloud model with the question masked..." });
		io.add({ id: nextId(), content: await io.consult(question) });
		io.after?.();
	} catch (e) {
		io.add({ id: nextId(), content: `consult: ${e instanceof Error ? e.message : String(e)}` });
	}
}
