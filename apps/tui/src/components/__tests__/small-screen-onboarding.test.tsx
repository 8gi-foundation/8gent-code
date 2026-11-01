/**
 * Phone-sized terminals (Termux, ~52x34 with the keyboard up): the full
 * onboarding question and its options stay readable, and the no-model state
 * is said once. Before, a one-line NO MODEL banner AND a 12-line NO MODEL card
 * left the question two rows.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, type DOMElement, Text, render } from "ink";
import { useRef } from "react";
import type { Message } from "../../app.js";
import { chatRowBudget, useMeasuredHeight } from "../../hooks/useMeasuredHeight.js";
import { guidanceText } from "../../lib/no-provider-guidance.js";
import { questionForChat } from "../../lib/onboarding-chat.js";
import type { Readiness } from "../../lib/readiness.js";
import { LiveFocalStrip, NO_MODEL_HINT } from "../LiveFocalStrip.js";
import { MessageList } from "../message-list.js";

const at = new Date("2026-10-21T10:00:00Z");

const QUESTION = questionForChat({
	question: "How should 8gent talk to you? Pick the style that fits how you like to work.",
	kind: "select",
	choices: [
		{ label: "Concise", value: "concise", description: "short answers, no preamble" },
		{ label: "Detailed", value: "detailed", description: "explain the reasoning" },
		{ label: "Friendly", value: "friendly", description: "warm and conversational" },
	],
});

const messages: Message[] = [
	{ id: "s1", role: "system", content: "Welcome to 8gent.", timestamp: at },
	{ id: "s2", role: "system", content: "Let us set a few things up.", timestamp: at },
	{ id: "s3", role: "system", content: "Your name?", timestamp: at },
	{ id: "u1", role: "user", content: "James", timestamp: at },
	{ id: "q", role: "assistant", content: QUESTION, timestamp: at },
];

function Screen({ cols, rows }: { cols: number; rows: number }) {
	const ref = useRef<DOMElement>(null);
	const measured = useMeasuredHeight(ref);
	const noModel: Readiness = {
		state: "none",
		reason: "Ollama at localhost:11434 did not answer.",
		model: "",
	};
	return (
		<Box flexDirection="column" width={cols} height={rows}>
			<Box flexShrink={0}>
				<Text>8gent Code</Text>
			</Box>
			<LiveFocalStrip
				mode="Planning"
				activeStep="idle"
				route="-"
				tokens="0"
				contextPct={0}
				contextState="fresh"
				animate={false}
				width={cols - 4}
				readiness={noModel}
			/>
			<Box ref={ref} flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden">
				<MessageList
					messages={messages}
					rowBudget={chatRowBudget(measured, rows, false)}
					contentWidth={cols - 4}
					scrollEnabled={false}
					showAnimations={false}
					animateTyping={false}
				/>
			</Box>
			<Box flexShrink={0}>
				<Text>INPUT-LINE</Text>
			</Box>
		</Box>
	);
}

async function frameAt(cols: number, rows: number): Promise<string> {
	const out = new EventEmitter() as EventEmitter & {
		frames: string[];
		write: (s: string) => boolean;
	};
	Object.assign(out, { columns: cols, rows, isTTY: false, frames: [] as string[] });
	out.write = (s: string) => {
		out.frames.push(s);
		return true;
	};
	const app = render(<Screen cols={cols} rows={rows} />, {
		stdout: out as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	await new Promise((r) => setTimeout(r, 80));
	app.unmount();
	const last = out.frames.filter((f) => f.includes("INPUT-LINE")).at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	return last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

// Wrapping can break a phrase across rows, so compare with whitespace folded.
const flat = (s: string) => s.replace(/[│─┌┐└┘]/g, " ").replace(/\s+/g, " ");

describe("onboarding on a small terminal", () => {
	for (const [cols, rows] of [
		[52, 34],
		[80, 24],
	] as const) {
		test(`${cols}x${rows}: full question and options visible, NO MODEL at most once`, async () => {
			const f = flat(await frameAt(cols, rows));
			expect(f).toContain("How should 8gent talk to you?");
			expect(f).toContain("Pick the style that fits how you like to work.");
			for (const c of ["Concise", "Detailed", "Friendly"]) expect(f).toContain(c);
			expect(f).toContain("short answers, no preamble");
			expect(f).toContain("warm and conversational");
			expect(f).toContain(NO_MODEL_HINT);
			expect(f.match(/NO MODEL/g)?.length ?? 0).toBeLessThanOrEqual(1);
		});
	}

	test("the one-line status names the next step; the full guide is behind /provider", () => {
		expect(NO_MODEL_HINT).toBe("No model yet. Type /provider to choose one.");
		const guide = guidanceText(undefined, "Ollama at localhost:11434 did not answer.");
		expect(guide).toContain("/provider ollama");
		expect(guide).toContain("8gent keys set openrouter");
	});
});
