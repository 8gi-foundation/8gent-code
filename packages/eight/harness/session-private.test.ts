/** #334: the harness audit session (createSession) is 0600, dir 0700, no symlink follow. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;
const originalHome = process.env.HOME;
let mod: typeof import("./session");

beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-harness-session-private-"));
	process.env.HOME = home; // SESSIONS_DIR is resolved from HOME at module load
	mod = await import("./session");
});

afterAll(() => {
	process.env.HOME = originalHome;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("harness session file mode (#334)", () => {
	test("file is 0600 after the first append under umask 022", async () => {
		const prev = process.umask(0o022);
		try {
			const s = mod.createSession("priv-h1");
			await s.append("tool_result" as never, { out: "x" });
			expect(fs.statSync(s.filePath).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(s.filePath)).mode & 0o777).toBe(0o700);
		} finally {
			process.umask(prev);
		}
	});

	test("an existing looser file is tightened and a symlink is refused", async () => {
		const dir = path.join(home, ".8gent", "audit");
		const loose = path.join(dir, "loose.jsonl");
		fs.writeFileSync(loose, "", { mode: 0o644 });
		fs.chmodSync(loose, 0o644);
		const s = mod.createSession("loose");
		await s.append("tool_result" as never, { out: "x" });
		expect(fs.statSync(loose).mode & 0o777).toBe(0o600);

		const target = path.join(home, "victim.txt");
		fs.writeFileSync(target, "keep");
		fs.symlinkSync(target, path.join(dir, "linked.jsonl"));
		const l = mod.createSession("linked");
		await expect(l.append("tool_result" as never, { out: "x" })).rejects.toThrow();
		expect(fs.readFileSync(target, "utf-8")).toBe("keep");
	});
});
