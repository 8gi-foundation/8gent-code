import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../eight/session-store.js";
import { TOOL_NAMES, scrubProposalText } from "./vessel-proposal-scrub.js";

const HOME = "/Users/janedoe";
const KEY = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;
const run = (s: string) => scrubProposalText(s, { home: HOME }).text;

describe("input shape", () => {
	test("empty input stays empty", () => {
		expect(scrubProposalText("", { home: HOME })).toEqual({
			text: "",
			redactedCount: 0,
			rules: [],
		});
	});

	test("a clean structural line is kept", () => {
		const line =
			'{"type":"message","id":"e1","parentId":null,"ts":"2026-10-25T10:00:00.000Z","message":{"role":"user","content":"[REDACTED]"}}';
		expect(run(line)).toBe(line);
	});

	const WORDS = [
		"Zanzibar",
		"Quokka",
		"Doe",
		"José",
		"BobDrive",
		"dmitri",
		"Bobs-MacBook-Pro",
		"janedoe",
	];
	const probes: Record<string, string> = {
		"truncated line":
			'{"role":"user","content":["Zanzibar divorce","Quokka"],"ts":"2026-10-25T10:0',
		"pretty printed array": '{\n  "content": [\n    "Zanzibar Quokka"\n  ]\n}',
		"heading then blank": "### User\n\nZanzibar Quokka paragraph",
		"second paragraph": "User: first\n\nZanzibar Quokka second paragraph",
		"three word name": "/Users/Jane Marie Doe/src/a.ts",
		"NFD path": "/Users/Jos\u0065\u0301/work/x.ts and José",
		"folder in prose": "~/Clients/Zanzibar Divorce/notes.md",
		"dashed folder": "~/Zanzibar-divorce",
		"volume path": "/Volumes/BobDrive/Zanzibar",
		"You label": "You: Zanzibar Quokka",
		"Eight label": "Eight: Zanzibar Quokka",
		"python repr": "{'role': 'user', 'content': 'Zanzibar Quokka'}",
		"json key text": '{"content":{"Zanzibar-divorce.md":1}}',
		"deep json key": '{"message":{"content":[{"type":"tool_use","input":{"Quokka.txt":"x"}}]}}',
		"value under id": '{"id":"Zanzibar Quokka divorce","type":"message"}',
		"value under type": '{"type":"Zanzibar Quokka please"}',
		"value under tool": '{"tool":"cat /Users/dmitri/Zanzibar.txt"}',
		"value under role": '{"role":"Quokka"}',
		"value under ts": '{"ts":"Quokka at noon"}',
		"user at host": "dmitri@Bobs-MacBook-Pro",
		"user at host in json": '{"name":"dmitri@Bobs-MacBook-Pro"}',
		"unc path": "\\\\BobDrive\\Zanzibar\\Quokka.txt",
		"windows forward slash": "C:/Users/dmitri/Zanzibar",
		"windows json escaped": "C:\\\\Users\\\\janedoe\\\\Quokka",
		summary: '{"type":"compaction","id":"c1","summary":"The user asked about Zanzibar Quokka"}',
		thinking: '{"type":"thinking","thinking":"Zanzibar"}',
		reasoning: '{"type":"reasoning","reasoning":"Quokka"}',
		"tool command": '{"type":"tool_use","input":{"command":"cat Zanzibar-Quokka.txt"}}',
		"arguments string":
			'{"function":{"name":"bash","arguments":"{\\"command\\":\\"cat Zanzibar\\"}"}}',
		cwd: `{"type":"session","id":"s1","cwd":"${HOME}/Clients/Zanzibar"}`,
		"top-level array": '["Zanzibar","Quokka"]',
		"top-level string": '"Zanzibar Quokka"',
		"session name": '{"type":"session_info","ts":"2026-10-25T10:00:00.000Z","name":"acme-payroll"}',
		"one word type": '{"type":"Zanzibar-divorce-papers"}',
		"one word tool name": '{"type":"tool_use","name":"jane.doe"}',
		"one word channel": '{"channel":"Zanzibar_divorce"}',
		"model with name": '{"model":"janedoe:Zanzibar"}',
		"provider with name": '{"provider":"Zanzibar"}',
		"phone as id": '{"id":"0871234567","parentId":"353871234567"}',
		"numbers in content": '{"content":[353871234567,4111111111111111]}',
		"phone as ts": '{"ts":353871234567}',
		"phone as tokens": '{"tokensBefore":353871234567}',
		"number carriers nested":
			'{"type":"tool_result","content":[{"type":"text","version":8712345,"tokensAfter":9876543}]}',
		"number carriers wrong top entry":
			'{"type":"message","version":8712345,"tokensBefore":8712345}',
		"version out of bound": '{"type":"session","version":8712345}',
		secret: `OPENROUTER_API_KEY=${KEY}`,
	};
	for (const [name, input] of Object.entries(probes)) {
		test(name, () => {
			const out = run(input);
			for (const w of [...WORDS, KEY, "cat "]) {
				expect(out.normalize("NFC")).not.toContain(w.normalize("NFC"));
			}
			expect(run(out)).toBe(out);
		});
	}

	test("phone numbers do not survive in any field", () => {
		const out = run(
			'{"id":"0871234567","parentId":"353871234567","content":[353871234567,4111111111111111],"ts":353871234567}',
		);
		for (const n of ["0871234567", "353871234567", "4111111111111111"])
			expect(out).not.toContain(n);
	});

	test("ids become a stable counter that keeps links", () => {
		const out = run(
			'{"type":"message","id":"abc12345","parentId":null}\n{"type":"message","id":"ff00ff00","parentId":"abc12345"}',
		);
		expect(out).toBe(
			'{"type":"message","id":"e1","parentId":null}\n{"type":"message","id":"e2","parentId":"e1"}',
		);
	});

	test("booleans and null pass under a container key", () => {
		expect(run('{"content":[true,null]}')).toBe('{"content":[true,null]}');
	});

	test("every live tool name is in the copied list", async () => {
		const { ToolExecutor } = await import("../eight/tools.js");
		const names = (
			new ToolExecutor(os.tmpdir()).getToolDefinitions() as Array<{ function: { name: string } }>
		).map((d) => d.function.name);
		expect(names.filter((n) => !TOOL_NAMES.has(n))).toEqual([]);
	});

	test("seven digit numbers never ride on version or token keys", () => {
		for (const line of [
			'{"type":"tool_result","content":[{"type":"text","version":8712345,"tokensAfter":9876543}]}',
			'{"type":"message","version":8712345,"tokensBefore":8712345}',
			'{"type":"session","version":8712345}',
			'{"type":"compaction","tokensBefore":8712345,"tokensAfter":9876543}',
		]) {
			const out = run(line);
			expect(out).not.toContain("8712345");
			expect(out).not.toContain("9876543");
		}
	});

	test("version and token counts pass on their own top-level entry", () => {
		const a = '{"type":"session","version":3}';
		const b = '{"type":"compaction","tokensBefore":120000,"tokensAfter":9000}';
		expect(run(a)).toBe(a);
		expect(run(b)).toBe(b);
	});

	test("a non-JSON line is replaced whole and counted", () => {
		const r = scrubProposalText("hello there", { home: HOME });
		expect(r.text).toBe("[REDACTED:unstructured]");
		expect(r.rules).toContain("unstructured");
		expect(r.redactedCount).toBeGreaterThan(0);
	});

	test("array strings keep their length", () => {
		expect(run('{"content":["a","b","c"]}')).toBe(
			'{"content":["[REDACTED]","[REDACTED]","[REDACTED]"]}',
		);
	});
});

describe("real SessionStore transcript", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-session-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("zero user bytes survive and the structure stays useful", () => {
		const s = SessionStore.create({ cwd: `${HOME}/work/acme`, name: "seed" }, dir);
		const first = s.append({ role: "user", content: "please rewrite my private Acme payroll" });
		s.append({ role: "assistant", content: `I opened ${HOME}/work/acme/pay.ts with ${KEY}` });
		s.append({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Zebrafish ledger idea" },
				{ type: "reasoning", reasoning: "Quokka reasoning" },
				{
					type: "tool_use",
					id: "t1",
					name: "run_command",
					input: { command: "cat Acme-payroll.txt" },
				},
				{
					type: "function",
					function: { name: "search_files", arguments: '{"command":"cat Walrus-notes.txt"}' },
				},
			],
		});
		s.compact("The user asked to rewrite their private Acme payroll parser.", {
			firstKeptId: first,
		});
		s.branch(first, { summary: "Abandoned: Platypus invoice experiment" });
		const raw = fs.readFileSync(s.file, "utf-8");
		expect(raw).toContain("janedoe");
		const out = run(raw);
		for (const bad of [
			"janedoe",
			"Acme",
			"acme",
			"payroll",
			KEY,
			"pay.ts",
			"Zebrafish",
			"Quokka",
			"Walrus",
			"Platypus",
			"work",
		]) {
			expect(out).not.toContain(bad);
		}
		expect(run(out)).toBe(out);

		const rows = out
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		const types = rows.map((r) => r.type);
		expect(types.filter((x) => x === "message").length).toBe(3);
		expect(types).toContain("compaction");
		expect(types).toContain("branch_summary");
		expect(out).toContain('"run_command"');
		expect(out).toContain('"search_files"');
		expect(out).toContain('"thinking"');
	});
});
