import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBugReport } from "./bug-report.js";

const homes: string[] = [];
afterEach(() => {
	for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const KEY = "sk-ant-api03-" + "a".repeat(93) + "AA";

function setup() {
	const home = mkdtempSync(join(tmpdir(), "bug-"));
	homes.push(home);
	mkdirSync(join(home, ".8gent"), { recursive: true });
	const session = join(home, "s.jsonl");
	writeFileSync(session, `{"role":"user","content":"my key is ${KEY} in ${home}/proj"}\n`);
	writeFileSync(join(home, ".8gent", "tui.log"), Array.from({ length: 300 }, (_, i) => `line ${i} token=${i === 299 ? KEY : "x"}`).join("\n"));
	return { home, session };
}

describe("createBugReport", () => {
	test("writes a local folder with version, OS, session and log tail, secrets redacted", () => {
		const { home, session } = setup();
		const dir = createBugReport({ env: { EIGHT_HOME: home } as unknown as NodeJS.ProcessEnv, sessionFile: session, version: "9.9.9", logLines: 50, note: "it broke" });
		expect(dir.startsWith(join(home, ".8gent", "bug-reports"))).toBe(true);
		expect(readdirSync(dir).sort()).toEqual(["log-tail.txt", "report.json", "session.jsonl"]);
		const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
		expect(rep.version).toBe("9.9.9");
		expect(rep.os.platform).toBe(process.platform);
		expect(rep.uploaded).toBe(false);
		expect(rep.before_sharing).toContain("Read every file");
		expect(rep.redactedSecrets).toBeGreaterThanOrEqual(1);
		for (const f of ["session.jsonl", "log-tail.txt", "report.json"]) {
			const t = readFileSync(join(dir, f), "utf8");
			expect(t).not.toContain(KEY);
			expect(t).not.toContain(home);
		}
		const log = readFileSync(join(dir, "log-tail.txt"), "utf8");
		expect(log).toContain("last 50 lines");
		expect(log).toContain("line 299");
		expect(log).not.toContain("line 100 ");
	});
	test("a secret-shaped note and a secret-shaped version never reach report.json", () => {
		const home = mkdtempSync(join(tmpdir(), "bug-"));
		homes.push(home);
		const dir = createBugReport({ env: { EIGHT_HOME: home } as unknown as NodeJS.ProcessEnv, cwd: home, note: `token ${KEY}`, version: `1.0.0 ${KEY}` });
		const raw = readFileSync(join(dir, "report.json"), "utf8");
		expect(raw).not.toContain(KEY);
		expect(raw).not.toContain("a".repeat(40));
		const rep = JSON.parse(raw);
		expect(rep.redactedSecrets).toBeGreaterThanOrEqual(2);
		expect(rep.version).toContain("1.0.0");
	});
	test("works with no session and no logs, and never reuses a folder", () => {
		const home = mkdtempSync(join(tmpdir(), "bug-"));
		homes.push(home);
		const now = new Date("2026-10-12T10:00:00Z");
		const a = createBugReport({ env: { EIGHT_HOME: home } as unknown as NodeJS.ProcessEnv, cwd: home, now });
		const b = createBugReport({ env: { EIGHT_HOME: home } as unknown as NodeJS.ProcessEnv, cwd: home, now });
		expect(a).not.toBe(b);
		expect(existsSync(join(a, "report.json"))).toBe(true);
		expect(readdirSync(a)).toEqual(["report.json"]);
	});
	test("picks the newest session for the cwd from the sessions dir", () => {
		const home = mkdtempSync(join(tmpdir(), "bug-"));
		homes.push(home);
		const dir = createBugReport({ env: { EIGHT_HOME: home } as unknown as NodeJS.ProcessEnv, cwd: home });
		expect(readdirSync(dir)).not.toContain("session.jsonl");
	});
});
