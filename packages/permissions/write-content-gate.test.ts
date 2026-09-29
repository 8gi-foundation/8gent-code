/**
 * #3011: edit_file (and every other tool that writes text into a file) goes
 * through the same no-secrets-in-files check as write_file, on BOTH tool
 * paths: the text-tool ToolExecutor (packages/eight/tools.ts) and the AI SDK
 * tools (packages/ai/tools.ts).
 *
 * Test secrets are assembled at runtime so no credential-shaped literal sits
 * in the repo (same convention as secret-detector.test.ts). None are real.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.EIGHT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "write-gate-test-"));

const { applyEdit, editedLines, writtenContentFor } = await import("./write-content-gate");
const { ToolExecutor } = await import("../eight/tools");
const { agentTools, setToolContext, getToolContext } = await import("../ai/tools");

const j = (...parts: string[]) => parts.join("");
const AWS_KEY_ID = j("AK", "IA", "Q3VZ7N2KXW5JTR8M");
const AWS_SECRET = j("wJalrXUt", "nFEMI/K7MDENG/", "bPxRfiCY", "Zq8Rk2Lm", "Tp4v");
// AWS's own documentation key ends in EXAMPLE and is allowed by the detector.
const AWS_DOC_KEY = j("AK", "IA", "IOSFODNN7", "EXAMPLE");

const CONFIG = [
	"// config.ts",
	'export const region = "eu-west-1";',
	"export const accessKeyId = process.env.AWS_ACCESS_KEY_ID;",
	"",
].join("\n");

const ENV_EXAMPLE = [
	"# Copy to .env and fill in",
	"AWS_ACCESS_KEY_ID=your-access-key-here",
	`AWS_EXAMPLE_ID=${AWS_DOC_KEY}`,
	"AWS_SECRET_ACCESS_KEY=<your-secret>",
	"REGION=eu-west-1",
	"",
].join("\n");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-gate-ws-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, content: string) => fs.writeFileSync(path.join(dir, file), content);
const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf-8");

describe("editedLines / applyEdit", () => {
	test("returns the full touched line, not the rest of the file", () => {
		const orig = "a = 1\nb = 2\nc = 3\n";
		expect(editedLines(orig, "2", "22")).toBe("b = 22");
	});

	test("an insertion ending in a newline does not pull in the next line", () => {
		const orig = "first\nsecond\n";
		expect(editedLines(orig, "second\n", "inserted\nsecond\n")).toBe("inserted\nsecond");
	});

	test("a deletion is checked on the line it joins", () => {
		const orig = 'token = "\nq8ZrT2vLx9Mw4Kp7\n"';
		expect(editedLines(orig, "\n", "")).toBe('token = "q8ZrT2vLx9Mw4Kp7');
	});

	test("oldText not found is null", () => {
		expect(editedLines("abc", "zzz", "y")).toBeNull();
		expect(applyEdit("abc", "zzz", "y")).toBeNull();
	});

	test("applyEdit inserts newText literally ($-patterns are not expanded)", () => {
		expect(applyEdit("price: X", "X", "$&$'5")).toBe("price: $&$'5");
	});

	test("writtenContentFor maps each write tool to the text it writes", () => {
		expect(writtenContentFor("write_file", { content: "c" }, dir)).toBe("c");
		expect(writtenContentFor("notebook_edit_cell", { newSource: "s" }, dir)).toBe("s");
		expect(writtenContentFor("notebook_insert_cell", { source: "t" }, dir)).toBe("t");
		expect(writtenContentFor("write_notes", { content: "n" }, dir)).toBe("n");
		// Missing file: falls back to newText rather than skipping the check.
		expect(
			writtenContentFor("edit_file", { path: "nope.ts", oldText: "a", newText: "b" }, dir),
		).toBe("b");
	});
});

describe("ToolExecutor edit_file (text-tool path)", () => {
	test("an edit that inserts a fake AWS key is blocked and the file is unchanged", async () => {
		put("config.ts", CONFIG);
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("edit_file", {
			path: "config.ts",
			oldText: "process.env.AWS_ACCESS_KEY_ID",
			newText: `"${AWS_KEY_ID}"`,
		});
		expect(out).toStartWith("[TOOLG8 BLOCKED] edit_file did NOT run.");
		expect(out).toContain("The file config.ts was NOT written.");
		expect(out).toContain("[no-secrets-in-files]");
		expect(out).not.toContain("Alternative");
		expect(read("config.ts")).toBe(CONFIG);
	});

	test("an edit that finishes a split assignment (value only in newText) is blocked", async () => {
		put("creds.ini", "[default]\naws_secret_access_key = PLACEHOLDER\n");
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("edit_file", {
			path: "creds.ini",
			oldText: "PLACEHOLDER",
			newText: AWS_SECRET,
		});
		expect(out).toStartWith("[TOOLG8 BLOCKED] edit_file did NOT run.");
		expect(read("creds.ini")).toContain("PLACEHOLDER");
	});

	test("a normal edit passes and is written", async () => {
		put("config.ts", CONFIG);
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("edit_file", {
			path: "config.ts",
			oldText: '"eu-west-1"',
			newText: '"us-east-1"',
		});
		expect(out).not.toContain("[TOOLG8 BLOCKED]");
		expect(out).toContain("File edited:");
		expect(read("config.ts")).toContain('"us-east-1"');
	});

	test("an edit next to existing placeholders and the AWS doc key does not false-positive", async () => {
		put("env.example", ENV_EXAMPLE);
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("edit_file", {
			path: "env.example",
			oldText: "REGION=eu-west-1",
			newText: "REGION=us-east-1\nLOG_LEVEL=debug",
		});
		expect(out).not.toContain("[TOOLG8 BLOCKED]");
		expect(read("env.example")).toContain("LOG_LEVEL=debug");
	});

	test("a secret-shaped fixture elsewhere in the file does not block an unrelated edit", async () => {
		// A scanner test fixture already on disk: not added by this edit.
		put("fixture.ts", `const FAKE = "${AWS_KEY_ID}";\n\nexport const retries = 3;\n`);
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("edit_file", {
			path: "fixture.ts",
			oldText: "retries = 3",
			newText: "retries = 5",
		});
		expect(out).not.toContain("[TOOLG8 BLOCKED]");
		expect(read("fixture.ts")).toContain("retries = 5");
	});

	test("notebook_insert_cell with a secret is blocked", async () => {
		const nb = JSON.stringify({
			cells: [{ cell_type: "code", source: ["print(1)"], metadata: {}, outputs: [] }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		});
		put("nb.ipynb", nb);
		const exec = new ToolExecutor(dir, "primary");
		const out = await exec.execute("notebook_insert_cell", {
			path: "nb.ipynb",
			afterIndex: 0,
			cellType: "code",
			source: `key_id = "${AWS_KEY_ID}"`,
		});
		expect(out).toStartWith("[TOOLG8 BLOCKED] notebook_insert_cell did NOT run.");
		expect(read("nb.ipynb")).toBe(nb);
	});
});

describe("AI SDK tools (native path)", () => {
	let before: ReturnType<typeof getToolContext>;
	beforeEach(() => {
		before = getToolContext();
		setToolContext({ workingDirectory: dir });
	});
	afterEach(() => setToolContext(before));

	const callSdk = (name: string, input: Record<string, unknown>) =>
		(
			(agentTools as Record<string, unknown>)[name] as {
				execute: (i: unknown, o: unknown) => Promise<unknown>;
			}
		).execute(input, { toolCallId: "t3011", messages: [] });

	test("edit_file inserting a fake AWS key is blocked, file unchanged", async () => {
		put("config.ts", CONFIG);
		const out = await callSdk("edit_file", {
			path: "config.ts",
			oldText: "process.env.AWS_ACCESS_KEY_ID",
			newText: `"${AWS_KEY_ID}"`,
		});
		expect(out).toStartWith("[TOOLG8 BLOCKED] edit_file did NOT run.");
		expect(out).toContain("[no-secrets-in-files]");
		expect(read("config.ts")).toBe(CONFIG);
	});

	test("write_file with a secret is blocked here too (this path had no gate)", async () => {
		const out = await callSdk("write_file", {
			path: "leak.ts",
			content: `export const id = "${AWS_KEY_ID}";\n`,
		});
		expect(out).toStartWith("[TOOLG8 BLOCKED] write_file did NOT run.");
		expect(fs.existsSync(path.join(dir, "leak.ts"))).toBe(false);
	});

	test("a normal edit and a placeholder-adjacent edit pass", async () => {
		put("config.ts", CONFIG);
		put("env.example", ENV_EXAMPLE);
		const a = await callSdk("edit_file", {
			path: "config.ts",
			oldText: '"eu-west-1"',
			newText: '"us-east-1"',
		});
		const b = await callSdk("edit_file", {
			path: "env.example",
			oldText: "REGION=eu-west-1",
			newText: "REGION=us-east-1",
		});
		expect(a).toContain("File edited:");
		expect(b).toContain("File edited:");
		expect(read("config.ts")).toContain('"us-east-1"');
		expect(read("env.example")).toContain("REGION=us-east-1");
	});

	test("write_notes (append) with a secret is blocked before anything is saved", async () => {
		// write_notes saves under $HOME/.8gent/tabs. Point HOME at the temp dir
		// so a regression can never write into the real notes store.
		const home = process.env.HOME;
		process.env.HOME = dir;
		try {
			const out = await callSdk("write_notes", {
				title: "t",
				content: `aws_secret_access_key = ${AWS_SECRET}`,
				append: true,
			});
			expect(out).toStartWith("[TOOLG8 BLOCKED] write_notes did NOT run. Nothing was written.");
			expect(fs.existsSync(path.join(dir, ".8gent", "tabs", "notes.json"))).toBe(false);
		} finally {
			process.env.HOME = home;
		}
	});
});
