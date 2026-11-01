import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitSyncPoller } from "../../apps/tui/src/hooks/useGitSync";

describe("background git outside a repository", () => {
	test("commit-gate's git probe writes nothing to the process stderr", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
		try {
			const gate = path.resolve(import.meta.dir, "commit-gate.ts");
			const script = `
				import * as g from ${JSON.stringify(gate)};
				const fp = g.treeFingerprint(${JSON.stringify(dir)});
				const unstaged = g.hasUnstaged(${JSON.stringify(dir)});
				console.log(JSON.stringify({ fp, unstaged }));
			`;
			const proc = Bun.spawn(["bun", "-e", script], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
			});
			const [err, out] = await Promise.all([
				new Response(proc.stderr).text(),
				new Response(proc.stdout).text(),
			]);
			await proc.exited;
			expect(err).toBe("");
			expect(out).toContain('"fp":null');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the polling caller asks git once, not on every poll, once the folder is not a repo", async () => {
		let calls = 0;
		const poll = createGitSyncPoller("/nowhere", async () => {
			calls++;
			return { stdout: "", stderr: "fatal: not a git repository", code: 128 };
		});
		for (let i = 0; i < 5; i++) expect((await poll()).status).toBe("no-repo");
		expect(calls).toBe(1);
	});

	test("inside a repository the poller keeps asking", async () => {
		let calls = 0;
		const poll = createGitSyncPoller("/repo", async (args) => {
			calls++;
			if (args.includes("--is-inside-work-tree")) return { stdout: "true\n", stderr: "", code: 0 };
			if (args.includes("--abbrev-ref")) return { stdout: "main\n", stderr: "", code: 0 };
			return { stdout: "0\n", stderr: "", code: 0 };
		});
		await poll();
		const first = calls;
		await poll();
		expect(calls).toBe(first * 2);
	});
});
