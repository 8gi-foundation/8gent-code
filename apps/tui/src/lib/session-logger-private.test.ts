/**
 * #334: the TUI session logger wrote session_<date>_<id>.jsonl 0644 (the umask
 * default), and that file carries tool results. This drives the production call
 * shape: initSessionLogger, a tool result, flushSession, then reads the mode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendOwnFile } from "../../../../packages/specifications/session/durable-ledger";

let home: string;
const originalHome = process.env.HOME;
let logger: typeof import("./session-logger");

beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-session-logger-private-"));
	process.env.HOME = home; // SESSIONS_DIR is resolved from HOME at module load
	logger = await import("./session-logger");
});

afterAll(() => {
	process.env.HOME = originalHome;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("session logger file mode (#334)", () => {
	test("session file is 0600 after first write and after the flushed appends, dir is 0700", () => {
		const prev = process.umask(0o022); // the umask that made it 0644 in the pilot home
		try {
			logger.initSessionLogger("priv-1", "m", "p");
			const dir = path.join(home, ".8gent", "sessions");
			const file = fs.readdirSync(dir).find((f) => /^session_.*\.jsonl$/.test(f));
			expect(file).toBeDefined();
			const full = path.join(dir, file as string);
			expect(fs.statSync(full).mode & 0o777).toBe(0o600);
			expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

			logger.logToolStart("t", "Chat", "read_file", "c1", { path: "x" });
			logger.logToolEnd("c1", true, 5, "secret file contents");
			logger.flushSession();
			expect(fs.readFileSync(full, "utf-8")).toContain("tool_result");
			expect(fs.statSync(full).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(prev);
		}
	});

	test("a planted symlink at the session path is not followed", () => {
		const dir = path.join(home, ".8gent", "sessions");
		const target = path.join(home, "victim.txt");
		fs.writeFileSync(target, "keep");
		const link = path.join(dir, "session_link.jsonl");
		fs.symlinkSync(target, link);
		expect(() => appendOwnFile(link, "x\n")).toThrow();
		expect(fs.readFileSync(target, "utf-8")).toBe("keep");
	});
});
