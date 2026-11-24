/**
 * A new chat tab is titled "Chat", not "Chat N". The tab strip already
 * numbers every tab in front of its name (the "5" in "5Chat"), so a counter
 * in the name repeats the number and, once a tab closes or a utility tab
 * sits earlier, disagrees with it: "5Chat 4" on a live frame.
 */

import { describe, expect, test } from "bun:test";
import { defaultTabTitle } from "../hooks/useWorkspaceTabs";

describe("defaultTabTitle", () => {
	test("a new chat tab is titled Chat, however many chats are open", () => {
		expect(defaultTabTitle("chat")).toBe("Chat");
	});

	test("the chat title carries no counter that could disagree with the strip number", () => {
		expect(defaultTabTitle("chat")).not.toMatch(/\d/);
	});

	test("utility tabs keep their own label", () => {
		expect(defaultTabTitle("notes")).toBe("Notes");
		expect(defaultTabTitle("settings")).toBe("Settings");
	});
});
