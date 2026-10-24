/**
 * The full output of a tool call, kept for the screen (#4954). The UI used to get 200 characters;
 * a person who wants to see why a call failed needs the lines the model saw. The text stays in
 * this process (it rides the tool-end event into the TUI's memory) and never goes anywhere else.
 * The cap keeps a runaway log from filling memory: the head and the tail are kept, because a
 * failure's cause is at the end and its context at the start.
 */

export const TOOL_OUTPUT_CAP = 20_000;
const HEAD = 8_000;
const TAIL = 12_000;

export function keepToolOutput(result: string): string {
	if (result.length <= TOOL_OUTPUT_CAP) return result;
	const dropped = result.length - HEAD - TAIL;
	return `${result.slice(0, HEAD)}\n... ${dropped} characters not kept ...\n${result.slice(-TAIL)}`;
}
