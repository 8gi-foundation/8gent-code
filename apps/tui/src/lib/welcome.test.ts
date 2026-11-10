import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WELCOME_HINT, makeWelcomeMessage } from "./welcome.js";

const OLD_GREETINGS = [
	"Good day. What shall we build?",
	"Ah, a new task. Excellent.",
	"Ready to craft something magnificent?",
	"At your service. What's the mission?",
	"Splendid to see you. Where shall we begin?",
];

test("the opening is the same on every launch", () => {
	const real = Math.random;
	let calls = 0;
	Math.random = () => {
		calls++;
		return real();
	};
	try {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(makeWelcomeMessage().content);
		expect([...seen]).toEqual([WELCOME_HINT]);
		expect(calls).toBe(0);
	} finally {
		Math.random = real;
	}
});

test("no string from the old greeting lists appears", () => {
	const content = makeWelcomeMessage().content;
	for (const g of OLD_GREETINGS) expect(content).not.toContain(g);
	for (const file of ["../app.tsx", "../hooks/useChatTabState.ts", "./welcome.ts"]) {
		const src = readFileSync(new URL(file, import.meta.url), "utf-8");
		for (const g of OLD_GREETINGS) expect(src).not.toContain(g);
		expect(src).not.toContain("GREETINGS");
	}
});
