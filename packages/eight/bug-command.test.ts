import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUG_SHARE_LINE, BUG_USAGE, runBugCommand } from "./bug-command.js";

const homes: string[] = [];
afterEach(() => {
	for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const KEY = "sk-ant-api03-" + "b".repeat(93) + "AA";

function setup() {
	const home = mkdtempSync(join(tmpdir(), "bugcmd-"));
	homes.push(home);
	mkdirSync(join(home, ".8gent"), { recursive: true });
	const session = join(home, "s.jsonl");
	writeFileSync(session, `{"role":"user","content":"key ${KEY}"}\n`);
	return { home, session, env: { EIGHT_HOME: home } as unknown as NodeJS.ProcessEnv };
}

describe("runBugCommand", () => {
	test("the version passed in reaches report.json", () => {
		const { env, session } = setup();
		const dir = runBugCommand(["x"], { env, sessionFile: session, version: "4.5.6" }).text.split(
			"\n",
		)[0];
		expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).version).toBe("4.5.6");
	});
	test("home is shortened on a segment boundary, through a symlinked home", () => {
		const { home, env } = setup();
		const link = `${home}-link`;
		symlinkSync(home, link);
		homes.push(link);
		const logs = join(home, "l.log");
		writeFileSync(logs, `a ${link}/proj b ${realpathSync(home)}/x c ${home}-other/y\n`);
		const dir = runBugCommand(["x"], {
			env: { EIGHT_HOME: link } as unknown as NodeJS.ProcessEnv,
			logFiles: [logs],
		}).text.split("\n")[0];
		const t = readFileSync(join(dir, "log-tail.txt"), "utf8");
		expect(t).toContain("a ~/proj b ~/x c ");
		expect(t).toContain(`${home}-other/y`);
		expect(t).not.toContain("/private~");
	});
	test("with EIGHT_HOME set the report lands there and the session is found there", () => {
		const { home, env } = setup();
		const sd = join(home, ".8gent", "sessions");
		mkdirSync(sd, { recursive: true });
		const r = runBugCommand(["x"], { env, cwd: home });
		expect(r.text.startsWith(join(home, ".8gent", "bug-reports"))).toBe(true);
	});
	test("builds the folder and prints its path plus the share line", () => {
		const { home, session, env } = setup();
		const r = runBugCommand(["the", "tui", "froze"], {
			env,
			sessionFile: session,
			version: "1.2.3",
		});
		expect(r.code).toBe(0);
		const [dir, line, ...rest] = r.text.split("\n");
		expect(dir.startsWith(join(home, ".8gent", "bug-reports"))).toBe(true);
		expect(line).toBe(BUG_SHARE_LINE);
		expect(rest).toEqual([]);
		expect(readdirSync(dir).sort()).toEqual(["report.json", "session.jsonl"]);
	});
	test("the description is stored redacted", () => {
		const { env, session } = setup();
		const r = runBugCommand([`crash with ${KEY}`], { env, sessionFile: session });
		const dir = r.text.split("\n")[0];
		const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
		expect(rep.note).toContain("crash with");
		expect(rep.note).not.toContain(KEY);
		expect(rep.redactedSecrets).toBeGreaterThanOrEqual(1);
	});
	test("a fake API key in the session is absent from the output and the folder", () => {
		const { env, session } = setup();
		const r = runBugCommand(["x"], { env, sessionFile: session });
		expect(r.text).not.toContain(KEY);
		const dir = r.text.split("\n")[0];
		for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toContain(KEY);
	});
	test("no description is a usage error and writes nothing", () => {
		const { home, env } = setup();
		const r = runBugCommand(["  "], { env });
		expect(r).toEqual({ code: 2, text: BUG_USAGE });
		expect(() => readdirSync(join(home, ".8gent", "bug-reports"))).toThrow();
	});
});
