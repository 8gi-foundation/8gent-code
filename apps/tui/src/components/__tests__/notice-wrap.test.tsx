/** A wrapped notice at 40 columns: no word cut in the middle, no row starting with a space. */
import { expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { wrapNotice } from "../../lib/notice-wrap.js";
import { MessageList } from "../message-list.js";

const content = "Session saved to ~/.8gent/sessions/2026-10-29-0439-design-pass.json";
const draw = (columns: number) =>
	renderToString(
		<MessageList
			messages={[{ id: "s", role: "system", content, timestamp: new Date() } as Message]}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			contentWidth={columns - 2}
			rowBudget={40}
		/>,
		{ columns },
	);

test("a long path breaks after a slash at 40 columns, never inside the year", () => {
	const out = draw(40);
	expect(out).toContain("~/.8gent/sessions/");
	expect(out).toContain("2026-10-29-0439-design-pass.json");
});

test("wrapNotice keeps words whole and starts no row with a space", () => {
	const rows = wrapNotice(
		"ollama is not running; using openrouter:qwen/qwen3-coder:free for this session.",
		36,
	);
	expect(rows.every((r) => r === r.trim() && r.length <= 36)).toBe(true);
	expect(rows.join(" ")).toContain("this session.");
});

test("at 100 columns the notice is one ruled row as before", () => {
	expect(draw(100)).toContain(`─── ${content} ───`);
});
