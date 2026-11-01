import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../../goal/ledger";
import { resolveReference, resolveSafePath } from "../extractors";

let root: string;
let repo: string;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-extract-"));
	fs.writeFileSync(path.join(root, "three.txt"), "alpha\nbeta\ngamma\n");
	fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");
	fs.writeFileSync(path.join(root, "notes.md"), "# notes\n");

	repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "test@test"]);
	git(repo, ["config", "user.name", "test"]);
	fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "first"]);
	fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "second"]);
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const roots = () => [root];

describe("path safety", () => {
	test("refuses a path outside the allowed roots", () => {
		expect(() => resolveSafePath("/etc/passwd", roots())).toThrow(/outside allowed roots/);
	});

	test("refuses traversal escapes", () => {
		expect(() => resolveSafePath(path.join(root, "..", "escape"), roots())).toThrow(
			/outside allowed roots/,
		);
	});

	test("refuses secret-shaped paths even inside a root", () => {
		for (const p of [".env", ".env.local", "keys/hmac.bin", "my-secret.txt", "id.pem"]) {
			expect(() => resolveSafePath(path.join(root, p), roots())).toThrow(/denied/);
		}
	});
});

describe("file extractors", () => {
	test("file.lines counts lines like a human, not wc -l off-by-one", () => {
		expect(resolveReference("file.lines", { path: path.join(root, "three.txt") }, roots())).toBe(
			"3",
		);
	});

	test("file.line returns the exact 1-based line, trimmed", () => {
		expect(
			resolveReference("file.line", { path: path.join(root, "three.txt"), line: "2" }, roots()),
		).toBe("beta");
	});

	test("file.line out of range throws (becomes a stripped claim)", () => {
		expect(() =>
			resolveReference("file.line", { path: path.join(root, "three.txt"), line: "99" }, roots()),
		).toThrow(/out of range/);
	});

	test("file.sha256 matches an independent hash", () => {
		const p = path.join(root, "three.txt");
		const expected = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
		expect(resolveReference("file.sha256", { path: p }, roots())).toBe(expected);
	});

	test("dir.count counts glob matches", () => {
		expect(resolveReference("dir.count", { path: root, glob: "*.ts" }, roots())).toBe("2");
	});
});

describe("git extractors", () => {
	test("git.head matches rev-parse", () => {
		expect(resolveReference("git.head", { repo }, roots())).toBe(git(repo, ["rev-parse", "HEAD"]));
	});

	test("git.rev resolves a ref", () => {
		expect(resolveReference("git.rev", { repo, ref: "main" }, roots())).toBe(
			git(repo, ["rev-parse", "HEAD"]),
		);
	});

	test("git.count counts a range", () => {
		expect(resolveReference("git.count", { repo, range: "HEAD" }, roots())).toBe("2");
	});

	test("git.branch names the current branch", () => {
		expect(resolveReference("git.branch", { repo }, roots())).toBe("main");
	});

	test("a ref starting with a dash is refused (no argv injection)", () => {
		expect(() =>
			resolveReference("git.rev", { repo, ref: "--upload-pack=/bin/sh" }, roots()),
		).toThrow(/invalid git ref/);
	});
});

describe("ledger.head", () => {
	test("recomputes the chain and returns the head hash", () => {
		const ledger = Ledger.open({ runId: "t", baseDir: root, key: Buffer.from("k".repeat(32)) });
		ledger.append({ kind: "x", payload: { a: 1 } });
		ledger.append({ kind: "x", payload: { b: 2 } });
		const head = ledger.headHash;
		ledger.close();
		expect(
			resolveReference("ledger.head", { path: path.join(root, "t", "ledger.jsonl") }, roots()),
		).toBe(head);
	});

	test("a tampered chain throws instead of returning a hash", () => {
		const dir = path.join(root, "tampered");
		const ledger = Ledger.open({ runId: "r", baseDir: dir, key: Buffer.from("k".repeat(32)) });
		ledger.append({ kind: "x", payload: { a: 1 } });
		ledger.close();
		const file = path.join(dir, "r", "ledger.jsonl");
		const entry = JSON.parse(fs.readFileSync(file, "utf8").trim());
		entry.payload.a = 999; // tamper
		fs.writeFileSync(file, `${JSON.stringify(entry)}\n`);
		expect(() => resolveReference("ledger.head", { path: file }, roots())).toThrow(/chain broken/);
	});
});

describe("registry", () => {
	test("unknown extractor throws", () => {
		expect(() => resolveReference("nope.nope", {}, roots())).toThrow(/unknown extractor/);
	});

	test("missing required arg throws with the arg named", () => {
		expect(() => resolveReference("file.lines", {}, roots())).toThrow(/missing required arg path=/);
	});
});
