/**
 * Agent tools must not touch the agent audit files (#3735).
 *
 * Runs against a fake HOME and a fake EIGHT_DATA_DIR in the temp dir; the real
 * ~/.8gent is never read or written. No workspace root is set anywhere, which
 * is the state of the main agent loop.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandTouchesAuditFiles, validatePath } from "../path-guard";
import { evaluatePolicy } from "../policy-engine";

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apg-home-"));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "apg-data-"));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "apg-proj-"));

const AUDIT_FILES = [
	path.join(FAKE_HOME, ".8gent", "audit.jsonl"),
	path.join(FAKE_HOME, ".8gent", "permissions-audit.jsonl"),
	path.join(FAKE_HOME, ".8gent", "audit", "access.db"),
	path.join(FAKE_HOME, ".8gent", "audit", "capability.db"),
	path.join(DATA_DIR, "audit.jsonl"),
	path.join(DATA_DIR, "audit", "access.db"),
];

let savedWorkspaceRoot: string | undefined;

beforeAll(() => {
	process.env.EIGHT_FAKE_HOME = FAKE_HOME;
	process.env.EIGHT_DATA_DIR = DATA_DIR;
	savedWorkspaceRoot = process.env.EIGHT_WORKSPACE_ROOT;
	delete process.env.EIGHT_WORKSPACE_ROOT;
	fs.mkdirSync(path.join(FAKE_HOME, ".8gent", "audit"), { recursive: true });
	fs.mkdirSync(path.join(DATA_DIR, "audit"), { recursive: true });
});

afterAll(() => {
	delete process.env.EIGHT_FAKE_HOME;
	delete process.env.EIGHT_DATA_DIR;
	if (savedWorkspaceRoot !== undefined) process.env.EIGHT_WORKSPACE_ROOT = savedWorkspaceRoot;
	for (const d of [FAKE_HOME, DATA_DIR, PROJ]) fs.rmSync(d, { recursive: true, force: true });
});

describe("validatePath protects agent audit files", () => {
	for (const p of AUDIT_FILES) {
		test(`denies ${path.relative(os.tmpdir(), p)}`, () => {
			expect(validatePath(p, PROJ).ok).toBe(false);
		});
	}
	test("denies the ~ spelling", () => {
		expect(validatePath("~/.8gent/audit.jsonl", PROJ).ok).toBe(false);
		expect(validatePath("~/.8gent/audit/access.db", PROJ).ok).toBe(false);
	});
	test("denies a dotdot route", () => {
		const p = path.join(PROJ, "..", path.basename(FAKE_HOME), ".8gent", "audit.jsonl");
		expect(validatePath(p, PROJ).ok).toBe(false);
	});
	test("still allows ordinary workspace paths and other home files", () => {
		expect(validatePath(path.join(PROJ, "src", "a.ts"), PROJ).ok).toBe(true);
		expect(validatePath(path.join(PROJ, "audit.md"), PROJ).ok).toBe(true);
		expect(validatePath(path.join(FAKE_HOME, ".8gent", "notes.md"), PROJ).ok).toBe(true);
	});
});

describe("evaluatePolicy denies every file tool on audit files with no workspace root", () => {
	for (const action of ["write_file", "edit_file", "delete_file", "apply_patch"]) {
		for (const p of AUDIT_FILES) {
			test(`${action} ${path.basename(p)}`, () => {
				const d = evaluatePolicy(action as never, { path: p, cwd: PROJ, workingDirectory: PROJ });
				expect(d.allowed).toBe(false);
			});
		}
	}
	test("normal workspace write and edit still allowed", () => {
		const target = path.join(PROJ, "ok.txt");
		expect(
			evaluatePolicy("write_file", { path: target, cwd: PROJ, workingDirectory: PROJ }).allowed,
		).toBe(true);
		expect(
			evaluatePolicy("edit_file", { path: target, cwd: PROJ, workingDirectory: PROJ }).allowed,
		).toBe(true);
	});
});

describe("run_command on audit files", () => {
	const denied = [
		"rm ~/.8gent/audit.jsonl",
		"rm -r ~/.8gent/audit",
		": > ~/.8gent/audit.jsonl",
		"truncate -s 0 $HOME/.8gent/permissions-audit.jsonl",
		// forward slashes: an unquoted backslash path is an escape sequence to the command parser
		`rm ${path.join(DATA_DIR, "audit.jsonl").split(path.sep).join("/")}`,
		"rm ~/'.8gent'/'audit'.jsonl",
		"cd ~/.8gent && rm audit.jsonl",
		"sqlite3 ~/.8gent/audit/access.db 'delete from t'",
	];
	for (const cmd of denied) {
		test(`denies: ${cmd}`, () => {
			expect(commandTouchesAuditFiles(cmd)).toBe(true);
			const d = evaluatePolicy("run_command", { command: cmd, cwd: PROJ, workingDirectory: PROJ });
			expect(d.allowed).toBe(false);
		});
	}
	for (const cmd of ["ls src", "bun test packages/permissions", "git status", "cat README.md"]) {
		test(`does not flag: ${cmd}`, () => {
			expect(commandTouchesAuditFiles(cmd)).toBe(false);
		});
	}
});
