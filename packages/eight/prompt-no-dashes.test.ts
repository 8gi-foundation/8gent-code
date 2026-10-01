/**
 * Nothing the model receives contains an em dash or an en dash (#3146).
 *
 * The prompt told the model "No em dashes" while showing it about twenty, and
 * a small model follows examples before instructions: its replies came back
 * full of them. This test reads the text the way the model gets it.
 *
 * 1. Real turns: an Agent, built for every runtime path and role, runs one turn
 *    against a stubbed model in a subprocess (throwaway HOME). Every request
 *    body is scanned: system prompt, messages and tool definitions.
 * 2. Everything a turn only sends sometimes: every prompt segment and composed
 *    prompt, both tool catalogs (native and text path, all tools, not just the
 *    loaded ones), and the text-tool loop's check and nudge messages.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asSchema } from "ai";
import { removeWhenReleased } from "../core/open-files";

const DASH = /[–—]/g;

/** Each dash with a little context, so a failure says exactly where. */
function dashesIn(label: string, text: string): string[] {
	const hits: string[] = [];
	for (const m of text.matchAll(DASH)) {
		const at = m.index ?? 0;
		hits.push(`${label}: ...${text.slice(Math.max(0, at - 50), at + 30).replace(/\s+/g, " ")}...`);
	}
	return hits;
}

function runTurn(runtime: string, role?: string, scope?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-dash-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-dash-home-"));
	try {
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
		const r = Bun.spawnSync(
			[
				process.execPath,
				path.join(import.meta.dir, "__tests__", "fixtures", "prompt-capture-probe.ts"),
				dir,
				runtime,
				role ?? "",
				scope ?? "",
			],
			{
				env: {
					...process.env,
					HOME: home,
					OPENROUTER_API_KEY: "probe",
					EIGHT_DATA_DIR: path.join(home, ".8gent"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const line = r.stdout
			.toString()
			.split("\n")
			.find((l) => l.startsWith("@@PROBE@@"));
		if (!line) {
			throw new Error(
				`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`,
			);
		}
		const out = JSON.parse(line.slice("@@PROBE@@".length)) as {
			system: string[];
			requests: unknown[];
		};
		expect(out.system.length).toBeGreaterThan(0);
		expect(out.requests.length).toBeGreaterThan(0);
		// JSON.stringify keeps U+2013/U+2014 as characters, so this scans every
		// string in every request, tool definitions included.
		return JSON.stringify(out);
	} finally {
		removeWhenReleased(dir);
		removeWhenReleased(home);
	}
}

describe("a real turn sends the model no em or en dashes (#3146)", () => {
	const cases: Array<[string, string, string?, string?]> = [
		["local text-tool path, no role", "ollama"],
		["local text-tool path, orchestrator", "ollama", "orchestrator"],
		["local text-tool path, engineer", "ollama", "engineer"],
		["local text-tool path, qa", "ollama", "qa"],
		["native path, no role", "openrouter"],
		["native path, orchestrator", "openrouter", "orchestrator"],
		["native path, engineer", "openrouter", "engineer"],
		["native path, qa", "openrouter", "qa"],
		["Table session", "ollama", undefined, "__table__"],
	];
	for (const [label, runtime, role, scope] of cases) {
		test(label, () => {
			expect(dashesIn(label, runTurn(runtime, role, scope))).toEqual([]);
		}, 60_000);
	}
});

describe("every prompt source a turn may send has no em or en dashes (#3146)", () => {
	test("prompt segments and composed prompts, every tier", async () => {
		const sp = await import("./prompts/system-prompt");
		const { DEFAULT_SYSTEM_PROMPT, PLANNING_GATE_INSTRUCTION } = await import("./prompt");
		const { ORCHESTRATOR_SEGMENT } = await import("./prompts/orchestrator-prompt");
		const { composeSoulPrompt } = await import("./prompts/soul-layers");
		const { getDeferredToolSegment } = await import("./tool-registry");
		const { loadInstructions } = await import("./instruction-loader");

		// The composed prompts also carry the user's own files: CLAUDE.md-style
		// project instructions and ~/.8gent/board-context.md. Those are the user's
		// words, not ours to rewrite, so they are cut out before the scan.
		const userFiles = [
			loadInstructions(process.cwd()),
			loadInstructions("/w"),
			sp.buildBoardContextSegment(),
		].filter((t): t is string => typeof t === "string" && t.length > 0);
		const ours = (text: string) => userFiles.reduce((t, f) => t.split(f).join(""), text);

		const texts: Array<[string, string]> = [
			["DEFAULT_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT],
			["PLANNING_GATE_INSTRUCTION", PLANNING_GATE_INSTRUCTION],
			["ORCHESTRATOR_SEGMENT", ORCHESTRATOR_SEGMENT],
			["getDeferredToolSegment()", getDeferredToolSegment()],
			[
				"USER_CONTEXT_SEGMENT",
				sp.USER_CONTEXT_SEGMENT({
					name: "Ada",
					role: "engineer",
					communicationStyle: "concise",
					language: "fr",
				}),
			],
			["buildToolCatalogSegment()", sp.buildToolCatalogSegment()],
			["buildToolCatalogSegment(concise)", sp.buildToolCatalogSegment({ concise: true })],
			[
				"buildContextualPrompt",
				sp.buildContextualPrompt({
					workingDirectory: "/w",
					isGitRepo: true,
					branch: "main",
					modifiedFiles: ["a.ts"],
					currentPlan: "1. x",
					infiniteMode: true,
				}),
			],
		];
		for (const tier of ["visitor", "collaborator", "owner"] as const) {
			texts.push([`composeSoulPrompt(${tier})`, composeSoulPrompt(tier)]);
			texts.push([`buildTieredSystemPrompt(${tier})`, sp.buildTieredSystemPrompt(tier)]);
		}
		for (const kind of ["explore", "modify", "debug", "test", "git"] as const) {
			texts.push([`getTaskSpecificPrompt(${kind})`, sp.getTaskSpecificPrompt(kind)]);
		}
		// Every exported string segment, so a new one is covered without a test edit.
		for (const [name, value] of Object.entries(sp)) {
			if (typeof value === "string") texts.push([name, value]);
		}
		expect(texts.flatMap(([label, text]) => dashesIn(label, ours(text)))).toEqual([]);
	});

	test("both tool catalogs, every tool", async () => {
		const { agentTools } = await import("../ai/tools");
		const { ToolExecutor } = await import("./tools");
		const hits: string[] = [];
		for (const [name, def] of Object.entries(agentTools)) {
			const d = def as { description?: string; inputSchema: unknown };
			hits.push(...dashesIn(`native ${name}`, d.description ?? ""));
			const schema = await asSchema(d.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema;
			hits.push(...dashesIn(`native ${name} schema`, JSON.stringify(schema)));
		}
		const textDefs = new ToolExecutor(os.tmpdir()).getToolDefinitions();
		hits.push(...dashesIn("text-path definitions", JSON.stringify(textDefs)));
		expect(hits).toEqual([]);
	});

	test("role prompts: personas and the macro-action planner", async () => {
		const { PERSONAS } = await import("../orchestration/personas");
		const { decompose } = await import("../orchestration/macro-actions");
		const plan = decompose("add a login page", { files: ["a.ts"], recentChanges: ["b.ts"] });
		expect([
			...dashesIn("PERSONAS", JSON.stringify(PERSONAS)),
			...dashesIn("decompose", JSON.stringify(plan)),
		]).toEqual([]);
	});

	test("pre-fetched context: every router reason", () => {
		// formatPreFetchedContext puts decision.reason into the context injected
		// before the first model turn; every reason is a literal in this file.
		const src = fs.readFileSync(path.join(import.meta.dir, "pre-tool-router.ts"), "utf8");
		const reasons = [...src.matchAll(/reason:\s*("[^"]*"|`[^`]*`)/g)].map((m) => m[1]);
		expect(reasons.length).toBeGreaterThan(5);
		expect(reasons.flatMap((r) => dashesIn("router reason", r))).toEqual([]);
	});

	test("the text-tool loop's check and nudge messages", async () => {
		const loop = await import("../ai/text-tool-loop");
		const texts: Array<[string, string]> = [
			["FOLLOW_UP_INSTRUCTION", String(loop.FOLLOW_UP_INSTRUCTION)],
			["COMPLETION_CHECK_MESSAGE", String(loop.COMPLETION_CHECK_MESSAGE)],
			["DEGENERATE_REPLY_MESSAGE", String(loop.DEGENERATE_REPLY_MESSAGE)],
			["cutOffToolCallMessage(name)", loop.cutOffToolCallMessage("write_file")],
			["cutOffToolCallMessage(null)", loop.cutOffToolCallMessage(null)],
			["abortedCallResult", loop.abortedCallResult(AbortSignal.abort())],
			["overCapCallResult", loop.overCapCallResult(40)],
			["blockedCheckMessage", loop.blockedCheckMessage(["path outside scope"])],
			["blockedStopNote", loop.blockedStopNote(["path outside scope"])],
			["unknownToolResult", loop.unknownToolResult("nope", ["read_file"])],
			["emptyReplyStall", loop.emptyReplyStall(2)],
			["emptyReplyNote", loop.emptyReplyNote(2)],
			["planCheckMessage", loop.planCheckMessage([{ step: "write the fix", status: "pending" }])],
		];
		expect(texts.flatMap(([label, text]) => dashesIn(label, text))).toEqual([]);
	});
});
