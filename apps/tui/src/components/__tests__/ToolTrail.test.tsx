/**
 * Tool trail rendered through Ink. Rishi's pilot (2026-09-29) found that a
 * person watching the TUI could not tell what the agent did: write_file and
 * run_command finish in milliseconds, tool messages were filtered out of
 * chat, and only an "N tools" counter remained. These tests render the real
 * components with Ink's renderToString at the 80-column layout.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import type { ToolTrailEntry } from "../../lib/tool-trail.js";
import { ToolTrail } from "../ToolTrail.js";
import { MessageList } from "../message-list.js";

const at = new Date("2026-09-29T15:00:00Z");

const render80 = (node: React.ReactElement) => renderToString(node, { columns: 80 });

const toolEnd = (id: string, entry: ToolTrailEntry): Message => ({
	id: `tool-end-${id}`,
	role: "tool",
	content: "  ✓",
	timestamp: at,
	toolTrail: entry,
});

const pilotTurn: Message[] = [
	{ id: "u1", role: "user", content: "Write deck/outline.md, then run `ls deck`", timestamp: at },
	{ id: "tool-start-1", role: "tool", content: "→ write_file(...)", timestamp: at },
	toolEnd("1", { tool: "write_file", summary: "deck/outline.md", status: "ok" }),
	toolEnd("2", {
		tool: "run_command",
		summary: "ls deck && wc -l deck/deck.md",
		status: "blocked",
		reason: "blocked",
	}),
	toolEnd("3", { tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1" }),
	toolEnd("4", { tool: "read_file", summary: "packages/decide/README.md", status: "ok" }),
	{
		id: "a1",
		role: "assistant",
		content:
			"The outline is written.\n\n[harness] Not verified: 'ls deck' was requested but never ran",
		timestamp: at,
	},
];

function lines(out: string): string[] {
	return out.split("\n");
}

describe("ToolTrail", () => {
	test("success, failure and blocked lines", () => {
		const out = render80(
			<ToolTrail
				width={70}
				entries={[
					{ tool: "write_file", summary: "deck/outline.md", status: "ok" },
					{ tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1" },
					{
						tool: "write_file",
						summary: "deck/secrets.md",
						status: "blocked",
						reason: "blocked: [no-secrets-in-files]",
					},
				]}
			/>,
		);
		expect(out).toContain("✓ write_file deck/outline.md");
		expect(out).toContain("✗ run_command bun test (exit 1)");
		expect(out).toContain("⊘ write_file deck/secrets.md (blocked: [no-secrets-in-files])");
	});

	test("collapses a long run of reads", () => {
		const entries: ToolTrailEntry[] = [
			...Array.from({ length: 6 }, (_, i) => ({
				tool: "read_file",
				summary: `packages/decide/f${i}.ts`,
				status: "ok" as const,
			})),
			{ tool: "write_file", summary: "deck/outline.md", status: "ok" },
			{ tool: "run_command", summary: "wc -l deck/outline.md", status: "ok" },
			{ tool: "read_file", summary: "deck/outline.md", status: "ok" },
		];
		const out = render80(<ToolTrail width={70} entries={entries} />);
		expect(out).toContain("✓ read_file ×6 (packages/decide/…)");
		expect(lines(out)).toHaveLength(4);
	});

	test("no line is wider than its width", () => {
		const out = render80(
			<ToolTrail
				width={40}
				entries={[
					{
						tool: "run_command",
						summary: "find . -name '*.md' -not -path './node_modules/*' | xargs wc -l",
						status: "fail",
						reason: "exit 1",
					},
				]}
			/>,
		);
		for (const l of lines(out)) expect(l.length).toBeLessThanOrEqual(40);
		expect(out).toContain("(exit 1)");
	});
});

describe("MessageList with a tool trail at 80 columns", () => {
	const renderList = (messages: Message[]) =>
		render80(
			<MessageList
				messages={messages}
				animateTyping={false}
				showAnimations={false}
				scrollEnabled={false}
				contentWidth={72}
				rowBudget={40}
			/>,
		);

	test("once the reply lands, the turn's calls read as results above the text", () => {
		const out = renderList(pilotTurn);
		const ls = lines(out);
		const header = ls.findIndex((l) => l.includes("◆ 8gent"));
		const write = ls.findIndex((l) => l.includes("✓ Wrote  deck/outline.md"));
		const body = ls.findIndex((l) => l.includes("The outline is written."));
		expect(header).toBeGreaterThan(-1);
		expect(write).toBeGreaterThan(header);
		expect(body).toBeGreaterThan(write);
		expect(out).toContain("⊘ Run blocked  ls deck && wc -l deck/deck.md");
		expect(out).toContain("✗ Ran  bun test  exit 1");
		expect(out).toContain("✓ Read  packages/decide/README.md");
		// Raw tool-start/tool-end strings stay out of chat.
		expect(out).not.toContain("→ write_file(");
	});

	test("the harness Not verified note stays visible", () => {
		// The bubble wraps at its width; join the wrapped rows before matching.
		const flat = lines(renderList(pilotTurn))
			.map((l) => l.replace(/^│\s?/, "").trim())
			.join(" ");
		expect(flat).toContain("[harness] Not verified: 'ls deck' was requested but never ran");
	});

	test("calls still running show as a live trail before the reply lands", () => {
		const out = renderList(pilotTurn.slice(0, 4));
		expect(out).toContain("✓ write_file deck/outline.md");
		expect(out).toContain("⊘ run_command ls deck && wc -l deck/deck.md (blocked)");
		expect(out).not.toContain("waiting with you");
	});

	test("a turn taller than the chat window caps its trail to fit", () => {
		// Real layout while processing at 80x45: about 10 chat rows. The
		// trail must not push the reply past the window, or Ink leaves stale
		// characters behind (seen in the live run on 2026-09-29).
		const turn: Message[] = [
			pilotTurn[0],
			...Array.from({ length: 6 }, (_, i) =>
				toolEnd(`w${i}`, { tool: "write_file", summary: `notes/f${i}.txt`, status: "ok" }),
			),
			toolEnd("x", {
				tool: "run_command",
				summary: "ls notes",
				status: "blocked",
				reason: "blocked",
			}),
			{ id: "a1", role: "assistant", content: "Done.", timestamp: at },
		];
		const out = render80(
			<MessageList
				messages={turn}
				animateTyping={false}
				showAnimations={false}
				scrollEnabled={false}
				contentWidth={72}
				rowBudget={8}
			/>,
		);
		// Header + trail + body + margin stays within the 8-row budget.
		expect(lines(out).length).toBeLessThanOrEqual(8);
		expect(out).toContain("⊘ Run blocked  ls notes");
		expect(out).toContain("more steps");
		expect(out).toContain("Done.");
	});

	test("80-column render snapshot", () => {
		const out = renderList(pilotTurn);
		for (const l of lines(out)) expect(l.length).toBeLessThanOrEqual(80);
		// Timestamps are locale/timezone dependent; normalise them for the snapshot.
		expect(out.replace(/\d{2}:\d{2}\s?[AP]M/g, "HH:MM")).toMatchSnapshot();
	});
});
