import { describe, expect, test } from "bun:test";
import { sendMessageBody } from "./send-body";

// #3231: an officer reply is agent-authored; a URL in it must not be fetched
// by Telegram's preview crawler.
describe("sendMessageBody", () => {
	test("disables link previews for every parse mode", () => {
		for (const mode of ["Markdown", "HTML", "None"] as const) {
			const body = sendMessageBody(1, "see https://attacker.example/?q=SECRET", mode);
			expect(body.link_preview_options).toEqual({ is_disabled: true });
		}
	});

	test("keeps chat, text and parse mode as before", () => {
		expect(sendMessageBody(5, "hi")).toMatchObject({
			chat_id: 5,
			text: "hi",
			parse_mode: "Markdown",
		});
		expect(sendMessageBody(5, "hi", "None").parse_mode).toBeUndefined();
	});
});
