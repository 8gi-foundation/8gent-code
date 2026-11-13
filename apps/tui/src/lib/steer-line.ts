/**
 * The line printed when Enter steers a running turn. It describes something
 * still waiting, so it is only true for a while: until the model has answered
 * after it, or the turn has ended. After that it is noise on an idle screen.
 */
export const STEERING_LINE = "Steering: it reaches the model after the current tool call.";

type ChatLine = { role: string; content: string };

/**
 * The messages to draw: a steering line stays only while a turn runs and the
 * model has not answered since. The steer's own bubble and every other line
 * are kept; nothing is removed from the saved history.
 */
export function liveSteerLines<T extends ChatLine>(
	messages: readonly T[],
	turnRunning: boolean,
): T[] {
	let lastAnswer = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAnswer = i;
			break;
		}
	}
	return messages.filter(
		(m, i) =>
			!(m.role === "system" && m.content === STEERING_LINE) || (turnRunning && i > lastAnswer),
	);
}
