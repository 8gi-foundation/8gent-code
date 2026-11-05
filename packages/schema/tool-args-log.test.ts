import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ToolExecutor } from "../eight/tools";
import { ToolArgGuard } from "./tool-args";

const closed = (): object[] => [
	{
		type: "function",
		function: {
			name: "t",
			parameters: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
		},
	},
];

const saved = process.env.EIGHT_SCHEMA_CHECK;
beforeEach(() => {
	process.env.EIGHT_SCHEMA_CHECK = "1";
});
afterEach(() => {
	if (saved === undefined) {
		// biome-ignore lint/performance/noDelete: an env var set to undefined becomes the string "undefined"
		delete process.env.EIGHT_SCHEMA_CHECK;
	} else process.env.EIGHT_SCHEMA_CHECK = saved;
});

describe("ToolArgGuard log line is safe", () => {
	it("never echoes a control character from a model-chosen key", () => {
		const lines: string[] = [];
		new ToolArgGuard(closed, (l) => lines.push(l)).observe("t", {
			"\x1b]52;c;ZXZpbA==\x07": 1,
			"line\nbreak\r\x00\x7f\x9b": 2,
		});
		expect(lines).toHaveLength(1);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the assertion
		expect(lines[0]).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/);
		expect(lines[0]).toContain("not allowed");
	});

	it("caps the log line however many bad keys arrive", () => {
		const lines: string[] = [];
		const args: Record<string, number> = {};
		for (let i = 0; i < 50_000; i++) args[`k${i}`] = i;
		new ToolArgGuard(closed, (l) => lines.push(l)).observe("t", args);
		expect(lines).toHaveLength(1);
		expect(lines[0].length).toBeLessThanOrEqual(2000);
		expect(lines[0]).toContain("more");
	});

	it("caps a single huge key", () => {
		const lines: string[] = [];
		new ToolArgGuard(closed, (l) => lines.push(l)).observe("t", { ["x".repeat(100_000)]: 1 });
		expect(lines[0].length).toBeLessThanOrEqual(2000);
	});
});

describe("ToolExecutor wiring", () => {
	it("flag on: a bad call is logged and the tool still runs", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ex = new ToolExecutor(process.cwd());
			const out = await ex.execute("read_file", { path: "package.json", offset: "x" });
			const logged = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[schema-check] tool=read_file"));
			expect(logged).toHaveLength(1);
			expect(logged[0]).toContain("rejected");
			expect(out).toContain("\"name\""); // the tool ran and read the file, it was not blocked
		} finally {
			warn.mockRestore();
		}
	});

	it("flag off: nothing is logged", async () => {
		process.env.EIGHT_SCHEMA_CHECK = "0";
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await new ToolExecutor(process.cwd()).execute("read_file", { path: "package.json", offset: "x" });
			expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("[schema-check]"))).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});
});
