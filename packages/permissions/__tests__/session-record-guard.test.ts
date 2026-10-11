/**
 * Tool calls must not change the session's own records. Fake HOME and data dir in the
 * temp dir; the real ~/.8gent is never touched. No workspace root is set.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SESSION_RECORD_DIRS,
	SESSION_RECORD_FILES,
	commandMutatesSessionRecords,
	validatePath,
} from "../path-guard";
import { evaluatePolicy } from "../policy-engine";

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "srg-home-"));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "srg-data-"));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "srg-proj-"));
const D = path.join(FAKE_HOME, ".8gent");

const RECORDS = [
	path.join(D, "sessions", "abc.json"),
	path.join(D, "sessions", "abc", "checkpoints.jsonl"),
	path.join(D, "sessions", "abc.log"),
	path.join(D, "daemon.log"),
	path.join(D, "logs", "tools.log"),
	path.join(D, "approvals-audit.jsonl"),
	path.join(D, "checkpoints", "ckpt_001"),
	path.join(D, "sessions"),
	path.join(DATA_DIR, "sessions", "abc.json"),
	path.join(DATA_DIR, "approvals-audit.jsonl"),
	path.join(DATA_DIR, "daemon.log"),
];

let savedRoot: string | undefined;

beforeAll(() => {
	process.env.EIGHT_FAKE_HOME = FAKE_HOME;
	process.env.EIGHT_DATA_DIR = DATA_DIR;
	savedRoot = process.env.EIGHT_WORKSPACE_ROOT;
	delete process.env.EIGHT_WORKSPACE_ROOT;
	for (const r of RECORDS.filter((r) => !r.endsWith("sessions"))) {
		fs.mkdirSync(path.dirname(r), { recursive: true });
		fs.writeFileSync(r, "line1\n");
	}
});

afterAll(() => {
	delete process.env.EIGHT_FAKE_HOME;
	delete process.env.EIGHT_DATA_DIR;
	if (savedRoot !== undefined) process.env.EIGHT_WORKSPACE_ROOT = savedRoot;
	for (const d of [FAKE_HOME, DATA_DIR, PROJ]) fs.rmSync(d, { recursive: true, force: true });
});

const rel = (p: string) => p.replace(FAKE_HOME, "~").replace(DATA_DIR, "$DATA");

describe("the protected list is one named list", () => {
	test("covers sessions, logs, checkpoints, daemon.log, approvals-audit.jsonl", () => {
		expect([...SESSION_RECORD_DIRS].sort()).toEqual(["checkpoints", "logs", "sessions"]);
		expect([...SESSION_RECORD_FILES].sort()).toEqual(["approvals-audit.jsonl", "daemon.log"]);
	});
});

describe("file tools: every record x every write operation is denied", () => {
	for (const action of ["write_file", "edit_file", "delete_file", "apply_patch"]) {
		for (const p of RECORDS) {
			test(`${action} ${rel(p)}`, () => {
				const d = evaluatePolicy(action as never, { path: p, cwd: PROJ, workingDirectory: PROJ });
				expect(d.allowed).toBe(false);
			});
		}
	}
	test("the ~ spelling and a dotdot route are denied", () => {
		expect(validatePath("~/.8gent/daemon.log", PROJ).ok).toBe(false);
		expect(validatePath("~/.8gent/sessions/x.json", PROJ).ok).toBe(false);
		const dd = path.join(PROJ, "..", path.basename(FAKE_HOME), ".8gent", "logs", "a.log");
		expect(validatePath(dd, PROJ).ok).toBe(false);
	});
	test("the data dir itself cannot be deleted or moved", () => {
		expect(validatePath(D, PROJ).ok).toBe(false);
		expect(validatePath(DATA_DIR, PROJ).ok).toBe(false);
	});
	test("a symlink into the records does not tunnel", () => {
		const link = path.join(PROJ, "link.log");
		fs.symlinkSync(path.join(D, "daemon.log"), link);
		expect(validatePath(link, PROJ).ok).toBe(false);
	});
});

describe("reads stay allowed", () => {
	for (const action of ["read_file", "glob", "list_files"]) {
		for (const p of RECORDS) {
			test(`${action} ${rel(p)}`, () => {
				const d = evaluatePolicy(action as never, { path: p, cwd: PROJ, workingDirectory: PROJ });
				expect(d.allowed).toBe(true);
			});
		}
	}
	test("validatePath read access is ok, write access is not", () => {
		for (const p of RECORDS) {
			expect(validatePath(p, PROJ, {}, "read").ok).toBe(true);
			expect(validatePath(p, PROJ, {}, "write").ok).toBe(false);
			expect(validatePath(p, PROJ).ok).toBe(false); // default is the strict reading
		}
	});
	test("credential dirs are still denied for reads", () => {
		expect(validatePath(path.join(FAKE_HOME, ".ssh", "id_rsa"), PROJ, {}, "read").ok).toBe(false);
	});
	test("shell reads are not flagged", () => {
		for (const c of [
			"cat ~/.8gent/daemon.log",
			"tail -f ~/.8gent/logs/tools.log",
			"grep error ~/.8gent/sessions/abc.log",
			"ls ~/.8gent/sessions",
			"cp ~/.8gent/daemon.log /tmp/copy.log",
			"cat ~/.8gent/approvals-audit.jsonl | wc -l",
			"echo hi > out.txt",
			"rm build.log",
			"git status",
		])
			expect(commandMutatesSessionRecords(c)).toBe(false);
	});
});

describe("internal writers keep working", () => {
	test("plain fs writers (session manager, checkpoint store, daemon log) are not gated", () => {
		for (const r of RECORDS.filter((r) => fs.existsSync(r) && fs.statSync(r).isFile())) {
			fs.appendFileSync(r, "more\n");
			expect(fs.readFileSync(r, "utf8")).toContain("more");
		}
	});
	test("ordinary workspace and other data-dir files are still writable", () => {
		expect(validatePath(path.join(PROJ, "a.ts"), PROJ).ok).toBe(true);
		expect(validatePath(path.join(D, "notes.md"), PROJ).ok).toBe(true);
		expect(validatePath(path.join(D, "artifacts", "x"), PROJ).ok).toBe(true);
		expect(
			evaluatePolicy("write_file", { path: path.join(PROJ, "ok.txt"), cwd: PROJ, workingDirectory: PROJ })
				.allowed,
		).toBe(true);
	});
});

describe("shell: every record x every mutating operation is denied", () => {
	const targets = [
		"~/.8gent/sessions/abc.json",
		"~/.8gent/sessions/abc/checkpoints.jsonl",
		"~/.8gent/sessions/abc.log",
		"~/.8gent/daemon.log",
		"~/.8gent/logs/tools.log",
		"~/.8gent/approvals-audit.jsonl",
		"~/.8gent/checkpoints/ckpt_001",
		"$HOME/.8gent/daemon.log",
		"$DATA/sessions/abc.json",
		"$DATA/approvals-audit.jsonl",
	];
	const ops: Array<(t: string) => string> = [
		(t) => `rm ${t}`,
		(t) => `rm -f ${t}`,
		(t) => `unlink ${t}`,
		(t) => `truncate -s 0 ${t}`,
		(t) => `> ${t}`,
		(t) => `: > ${t}`,
		(t) => `echo x >> ${t}`,
		(t) => `echo x 2>&1 > ${t}`,
		(t) => `mv ${t} /tmp/x`,
		(t) => `mv /tmp/x ${t}`,
		(t) => `cp /tmp/x ${t}`,
		(t) => `sed -i '' s/a/b/ ${t}`,
		(t) => `sed -i s/a/b/ ${t}`,
		(t) => `tee ${t} < /tmp/x`,
		(t) => `shred -u ${t}`,
		(t) => `git checkout -- ${t}`,
		(t) => `git restore ${t}`,
		(t) => `cat /dev/null | tee ${t}`,
		(t) => `rm "${t}"`,
		(t) => `r'm' ${t}`,
	];
	for (const t of targets) {
		for (const op of ops) {
			const raw = op(t);
			const cmd = raw.replace("$DATA", DATA_DIR);
			test(`denies: ${raw}`, () => {
				expect(commandMutatesSessionRecords(cmd)).toBe(true);
				const d = evaluatePolicy("run_command", { command: cmd, cwd: PROJ, workingDirectory: PROJ });
				expect(d.allowed).toBe(false);
			});
		}
	}
	for (const c of [
		"mv ~/.8gent/sessions ~/x",
		"rm -r ~/.8gent",
		"rm -r ~/.8gent/",
		"cd ~/.8gent && rm daemon.log",
		"cd ~/.8gent/logs && rm *.log",
		"cd ~/.8gent/sessions; truncate -s0 abc.json",
		"find ~/.8gent/logs -name '*.log' -delete",
		"git checkout -- logs/run.jsonl",
		"git checkout -- logs/run.log",
		"cp /tmp/x ~/.8gent/sessions/abc.json",
	])
		test(`denies: ${c}`, () => {
			expect(commandMutatesSessionRecords(c)).toBe(true);
		});
});
