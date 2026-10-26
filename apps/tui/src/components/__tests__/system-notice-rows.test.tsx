/**
 * A wrapped one-line system notice, rendered through Ink: under 60 columns it
 * drops its two rule rows so a stack of notices leaves room for the chat.
 * At 100 columns it keeps them.
 */
import { expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { MessageList } from "../message-list.js";

const at = new Date("2026-10-26T11:00:00Z");
const notice: Message = {
	id: "s1",
	role: "system",
	content: "TTS output enabled. 8gent replies will be spoken.",
	timestamp: at,
};
const render = (columns: number) =>
	renderToString(
		<MessageList
			messages={[notice]}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			contentWidth={columns - 2}
			rowBudget={40}
		/>,
		{ columns },
	);

test("at 40 columns a wrapped notice has no rule rows", () => {
	const out = render(40);
	expect(out).not.toContain("───");
	expect(out).toContain("will be spoken.");
	expect(out.split("\n").filter((l) => l.trim()).length).toBe(2);
});

test("at 100 columns the notice still sits between rules on one row", () => {
	const out = render(100);
	expect(out).toContain("─── TTS output enabled. 8gent replies will be spoken. ───");
});
