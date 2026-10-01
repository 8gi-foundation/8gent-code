/**
 * First run with no model (T5). A bare machine opened to "READY" and
 * "providers 0/3" with no word on how to connect a model. These tests render
 * the real notice into a fake 80-column terminal: it shows while nothing can
 * answer and is gone once a provider is reachable. The frames are ANSI
 * stripped, which is exactly what NO_COLOR draws, so the snapshots also prove
 * the card reads with no colour at all.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";
import { guidanceCopy } from "../../lib/no-provider-guidance.js";
import { type ReadinessInputs, deriveReadiness } from "../../lib/readiness.js";
import { palettes } from "../../theme.js";
import { NO_PROVIDER_TONES, NoProviderNotice } from "../NoProviderCard.js";

function fakeStdout(cols: number, rows: number) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(s);
		return true;
	};
	return out;
}

// The card renders from the same readiness answer as the header strip (#3290).
async function frame(props: ReadinessInputs & { compact?: boolean }, cols = 80): Promise<string> {
	const stdout = fakeStdout(cols, 40);
	const { compact, ...inputs } = props;
	const app = render(
		<NoProviderNotice readiness={deriveReadiness(inputs)} compact={compact} copy={guidanceCopy("linux")} />,
		{
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
		},
	);
	await new Promise((r) => setTimeout(r, 30));
	app.unmount();
	const last = stdout.frames.at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	return last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+$/, "");
}

const bareMachine: ReadinessInputs = {
	provider: "ollama",
	model: "qwen3.5",
	firstProbeLanded: true,
	engines: { apfel: false, lmstudio: false, ollama: false },
	keyStatus: "not-needed",
	unreachable: null,
	build: { kind: "pending" },
	turnError: null,
};
const ollamaUp = { ...bareMachine, engines: { ...bareMachine.engines, ollama: true }, build: { kind: "built" as const } };

describe("no-model card in the chat area (T5)", () => {
	test("providers 0/3: the card shows both paths and /provider", async () => {
		const out = await frame(bareMachine);
		expect(out).toContain("NO MODEL");
		expect(out).toContain("curl -fsSL https://ollama.com/install.sh | sh");
		expect(out).toContain("ollama pull qwen3.5   # about 7 GB");
		// The documented key flow (8gent.dev models/hosted): keys.env via
		// `8gent keys`, then /provider openrouter and /model auto:free.
		expect(out).toContain("8gent keys   # opens ~/.8gent/keys.env");
		expect(out).toContain("OPENROUTER_API_KEY=<your key>");
		expect(out).toContain("/provider openrouter, then /model auto:free");
		expect(out).not.toContain("~/.8gent/.env");
		expect(out).not.toContain("openrouter-free");
		expect(out).toContain("Pick one, or type /provider.");
		// Meaning is in text, not colour: the state word and numbered paths.
		expect(out).toMatch(/│ 1\s+Run a model/);
		expect(out).toMatch(/│ 2\s+Use a free hosted model/);
		expect(out).toMatchSnapshot();
	});

	test("fits the chat column of an 80-column terminal: no line wraps or clips", async () => {
		// The chat column is about 76 wide in an 80-column terminal; 72 leaves room.
		const lines = (await frame(bareMachine, 72)).split("\n").filter(Boolean);
		// Border, lead, reason, 1 + 3 steps, 2 + 3 steps, border: twelve rows,
		// none wrapped. The reason always shows now: readiness always has one.
		expect(lines.length).toBe(12);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(72);
	});

	test("carries agent init's reason line in place of a chat notice", async () => {
		const out = await frame({
			...bareMachine,
			unreachable: "LM Studio at localhost:1234 did not answer.",
		});
		expect(out).toMatch(/│ {10}LM Studio at localhost:1234 did not answer\.\s+│/);
		expect(out).toMatchSnapshot();
	});

	test("short terminal (80x24): compact form keeps the reason, nothing wraps", async () => {
		const lines = (
			await frame(
				{ ...bareMachine, compact: true, unreachable: "Ollama at 127.0.0.1:11434 did not answer." },
				76,
			)
		)
			.split("\n")
			.filter(Boolean);
		// Border, reason, path 1, path 2 on two lines, border.
		expect(lines.length).toBe(6);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
		const out = lines.join("\n");
		expect(out).toMatch(
			/│ 1\s+Install Ollama \(ollama\.com\), ollama pull qwen3\.5, \/provider ollama/,
		);
		// After onboarding nothing else says why, so the compact form keeps it.
		expect(out).toMatch(/│ NO MODEL Ollama at 127\.0\.0\.1:11434 did not answer\./);
		expect(out).toMatch(/│ 2\s+8gent keys, set OPENROUTER_API_KEY=<your key>, restart 8gent/);
		expect(out).toMatch(/│\s{4}\/provider openrouter, then \/model auto:free/);
		expect(out).toMatchSnapshot();
	});

	test("hosted provider with no key: the card shows", async () => {
		const out = await frame({ ...bareMachine, provider: "openrouter", keyStatus: "missing" });
		expect(out).toContain("NO MODEL");
		expect(out).toContain("openrouter needs an API key.");
	});

	test("one provider ready: nothing renders", async () => {
		const out = await frame(ollamaUp);
		expect(out).not.toContain("NO MODEL");
		expect(out).toMatchSnapshot();
	});

	test("hosted provider with its key: nothing renders", async () => {
		const out = await frame({ ...ollamaUp, provider: "openrouter", keyStatus: "present" });
		expect(out).toBe("");
	});

	test("before the first probe lands: nothing renders (no flash)", async () => {
		const out = await frame({ ...bareMachine, firstProbeLanded: false });
		expect(out).toBe("");
	});

	test("compact form carries the readiness reason in the header row", async () => {
		const out = await frame({ ...bareMachine, compact: true }, 76);
		expect(out).toContain("NO MODEL Ollama is not answering.");
	});

	test("a built agent whose engine is lost mid-session: the card shows (#3290)", async () => {
		const out = await frame({ ...ollamaUp, engines: { ...ollamaUp.engines, ollama: false } });
		expect(out).toContain("NO MODEL");
		expect(out).toContain("Ollama is not answering.");
	});

	test("copy names no AI vendor and uses no em dash", () => {
		const text = JSON.stringify(guidanceCopy("linux")) + JSON.stringify(guidanceCopy("darwin"));
		expect(text).not.toContain(String.fromCharCode(0x2014)); // em dash
		expect(text).not.toMatch(/claude|anthropic|openai|gpt|gemini/i);
	});

	test("macOS and Windows point at the Ollama download page, not a shell script", () => {
		for (const p of ["darwin", "win32"] as const) {
			const steps = guidanceCopy(p).paths[0]?.steps ?? [];
			expect(steps[0]).toBe("Install Ollama from https://ollama.com/download");
		}
	});
});

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("no-model card contrast, both themes", () => {
	for (const [mode, p] of Object.entries(palettes)) {
		test(`${mode}: every text tone is AA (4.5:1), the border is 3:1`, () => {
			for (const [role, token] of Object.entries(NO_PROVIDER_TONES)) {
				const ratio = contrast(p[token], p.bg);
				if (ratio < 4.5) throw new Error(`${mode} ${role} (${token}): ${ratio.toFixed(2)}:1`);
			}
			expect(contrast(p.frame, p.bg)).toBeGreaterThanOrEqual(3);
		});
	}
});
