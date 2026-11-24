/** #334: SessionStore tree files are 0600 on create and on append, never through a symlink. */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, treeDir } from "./session-store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-session-store-private-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("SessionStore file mode (#334)", () => {
	test("created 0600 under umask 022, still 0600 after an append; looser file tightened", () => {
		const prev = process.umask(0o022);
		try {
			const s = SessionStore.create({ id: "priv-s1" }, root);
			expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
			s.append({ role: "user", content: "hello" } as never);
			expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
			fs.chmodSync(s.file, 0o644);
			s.append({ role: "user", content: "again" } as never);
			expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(prev);
		}
	});

	test("a symlink planted at the session path is not written through", () => {
		const dir = treeDir(root);
		const target = path.join(root, "victim.txt");
		fs.writeFileSync(target, "keep");
		fs.symlinkSync(target, path.join(dir, "linked-s.jsonl"));
		expect(() => SessionStore.create({ id: "linked-s" }, root)).toThrow();
		expect(fs.readFileSync(target, "utf-8")).toBe("keep");
	});
});
