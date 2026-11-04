/** Fix round on #5241: the patch is bound to the payload, writes never follow links, the CLI shows what it approves. */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { approve } from "./apply.js";
import { preparedCommand } from "./cli.js";
import { gateCommand, modelDrafter, runPass } from "./pass.js";
import { PreparedWriteDenied, preparedDir } from "./store.js";
import { cand, diffDrafter, fixture } from "./testkit.js";

// Today at 20:00 local: the CLI reads the real clock, so a fixed date expired the packets.
const NOW = (() => {
	const d = new Date();
	d.setHours(20, 0, 0, 0);
	return d;
})();
const noRun = () => {
	throw new Error("must not run");
};
const diffOf = (file: string, line: string) =>
	`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;

async function prepared(f: ReturnType<typeof fixture>, name = "b.txt") {
	const r = await runPass(f.io, {
		now: NOW,
		candidates: [cand(1)],
		drafter: diffDrafter(f.diffFor(name)),
	});
	expect(r.prepared.length).toBe(1);
	return r.prepared[0];
}

function swapPatch(dir: string, id: string, body: string) {
	const p = path.join(dir, `${id}.patch`);
	fs.chmodSync(p, 0o644);
	fs.writeFileSync(p, body);
}

describe("item 1: the patch on disk is bound to the approved payload", () => {
	test("the prepared patch is written read-only", async () => {
		const f = fixture();
		const id = await prepared(f);
		expect(fs.statSync(path.join(f.dir, `${id}.patch`)).mode & 0o777).toBe(0o444);
	});

	for (const [label, file] of [
		["a CI workflow", ".github/ci.yml"],
		["the policy engine", "packages/permissions/pwn.ts"],
	]) {
		test(`a patch swapped after prepare for ${label} is refused`, async () => {
			const f = fixture();
			const id = await prepared(f);
			swapPatch(f.dir, id, diffOf(file, "pwned"));
			const res = approve(f.io, id, { now: NOW, run: noRun });
			expect(res).toMatchObject({ ran: false, status: "refused" });
			expect(res.reason).toContain("patch on disk differs");
			expect(f.io.exists(`claims/${id}`)).toBe(false);
			expect(f.io.loadPacket(id)!.status).toBe("refused");
		});
	}

	test("a deleted patch is refused too", async () => {
		const f = fixture();
		const id = await prepared(f);
		fs.rmSync(path.join(f.dir, `${id}.patch`));
		expect(approve(f.io, id, { now: NOW, run: noRun }).ran).toBe(false);
	});

	test("the gate is rebuilt from the pinned base commit; a gate edited on disk or committed later never runs", async () => {
		const f = fixture();
		f.setGate("test -f b.txt");
		const id = await prepared(f);
		const p = f.io.loadPacket(id)!;
		expect(p.apply).toContain(`sh -c 'test -f b.txt'`);
		expect(p.apply).not.toContain("bun run");
		p.gate = "touch /tmp/never";
		f.io.savePacket(p);
		let ran = "";
		expect(
			approve(f.io, id, {
				now: NOW,
				run: (c) => {
					ran = c;
					return { code: 0, output: "" };
				},
			}).status,
		).toBe("approved");
		expect(ran).not.toContain("/tmp/never");

		const g = fixture();
		g.setGate("true");
		const gid = await prepared(g);
		g.setGate("touch pwned");
		let gran = "";
		const res = approve(g.io, gid, {
			now: NOW,
			run: (c) => {
				gran = c;
				return { code: 0, output: "" };
			},
		});
		expect(res.status).toBe("approved");
		expect(gran).toContain(`sh -c 'true'`);
		expect(gran).not.toContain("pwned");
		expect(gran).toContain(g.io.loadPacket(gid)!.base!);
	});

	test("a forged base outside the owner's history is refused", async () => {
		const f = fixture();
		const id = await prepared(f);
		const p = f.io.loadPacket(id)!;
		p.base = "0".repeat(40);
		f.io.savePacket(p);
		expect(approve(f.io, id, { now: NOW, run: noRun }).ran).toBe(false);
	});

	test("real path: a package.json script swapped in after prepare never runs", async () => {
		const f = fixture();
		f.setGate("true");
		const id = await prepared(f);
		const marker = path.join(f.root, "MARKER");
		const pj = `{"scripts":{"typecheck":"touch ${marker}"}}`;
		swapPatch(
			f.dir,
			id,
			`diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{"scripts":{"typecheck":"true"}}\n\\ No newline at end of file\n+${pj}\n`,
		);
		expect(approve(f.io, id, { now: NOW }).ran).toBe(false);
		expect(fs.existsSync(marker)).toBe(false);
		expect(fs.existsSync(path.join(f.dir, "worktrees", id))).toBe(false);
	});

	test("a package.json script edit is blocked at prepare", async () => {
		const f = fixture();
		f.setGate("true");
		const r = await runPass(f.io, {
			now: NOW,
			candidates: [cand(1)],
			drafter: diffDrafter(
				'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-x\n+{"scripts":{"typecheck":"touch MARKER"}}\n',
			),
		});
		expect(r.prepared).toEqual([]);
		expect(r.blocked[0].reason).toContain("package.json");
	});

	test("after a real approve the applied patch is the payload, read-only", async () => {
		const f = fixture();
		const id = await prepared(f);
		expect(approve(f.io, id, { now: NOW }).gate).toBe("pass");
		const patch = path.join(f.dir, `${id}.patch`);
		expect(fs.readFileSync(patch, "utf8")).toBe(f.io.loadPacket(id)!.action.payload);
		expect(fs.statSync(patch).mode & 0o777).toBe(0o444);
		expect(gateCommand(f.io)).toBe("git diff --cached --check");
	});
});

describe("item 3: a write never follows a symlink", () => {
	test("a dangling symlink pointing outside is refused and nothing is created", () => {
		const { io, root, dir } = fixture();
		io.write("seed.json", "{}");
		const target = path.join(root, "outside", "made.txt");
		fs.mkdirSync(path.dirname(target));
		for (const name of ["dangling.json", "ledger.jsonl", "claims"]) {
			fs.symlinkSync(target, path.join(dir, name));
		}
		expect(() => io.write("dangling.json", "x")).toThrow(PreparedWriteDenied);
		expect(() => io.append("ledger.jsonl", "x")).toThrow(PreparedWriteDenied);
		expect(() => io.claim("claims/abc")).toThrow(PreparedWriteDenied);
		expect(fs.existsSync(target)).toBe(false);
	});

	test("a dangling symlink back inside the dir is still not written through", () => {
		const { io, dir } = fixture();
		io.write("seed.json", "{}");
		fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "alias.json"));
		expect(() => io.write("alias.json", "x")).toThrow(PreparedWriteDenied);
		expect(fs.existsSync(path.join(dir, "real.json"))).toBe(false);
	});

	test("a symlinked parent dir is refused even when it points inside", () => {
		const { io, dir } = fixture();
		io.write("real/a.json", "{}");
		fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linkdir"));
		expect(() => io.write("linkdir/b.json", "x")).toThrow(PreparedWriteDenied);
		expect(fs.existsSync(path.join(dir, "real", "b.json"))).toBe(false);
	});

	test("an atomic write leaves no temp files behind", () => {
		const { io, dir } = fixture();
		io.write("x.json", "1");
		io.write("x.json", "2");
		expect(fs.readFileSync(path.join(dir, "x.json"), "utf8")).toBe("2");
		expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
});

describe("item 4: EIGHT_PREPARED_DIR must be a real dir under ~/.8gent", () => {
	test("inside ~/.8gent is accepted; outside, dot-dot and symlinks are refused", () => {
		const { root } = fixture();
		const home = path.join(root, "home");
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		expect(preparedDir({ HOME: home })).toBe(path.join(home, ".8gent", "prepared"));
		expect(preparedDir({ HOME: home, EIGHT_PREPARED_DIR: path.join(home, ".8gent", "p2") })).toBe(
			path.join(home, ".8gent", "p2"),
		);
		for (const bad of [
			path.join(root, "elsewhere"),
			path.join(home, ".8gent"),
			path.join(home, ".8gent", "..", "x"),
			"/tmp/prepared",
		]) {
			expect(() => preparedDir({ HOME: home, EIGHT_PREPARED_DIR: bad })).toThrow(
				PreparedWriteDenied,
			);
		}
		const away = path.join(root, "away");
		fs.mkdirSync(away);
		fs.symlinkSync(away, path.join(home, ".8gent", "linked"));
		expect(() =>
			preparedDir({ HOME: home, EIGHT_PREPARED_DIR: path.join(home, ".8gent", "linked") }),
		).toThrow(/symlink/);
		expect(() =>
			preparedDir({ HOME: home, EIGHT_PREPARED_DIR: path.join(home, ".8gent", "linked", "deep") }),
		).toThrow(/symlink/);
	});

	test("the CLI refuses a bad dir and writes nothing", async () => {
		const { root } = fixture();
		const lines: string[] = [];
		const bad = path.join(root, "evil");
		const code = await preparedCommand(
			["list"],
			{ HOME: path.join(root, "home"), EIGHT_PREPARED_DIR: bad },
			(s) => lines.push(s),
		);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("must be inside");
		expect(fs.existsSync(bad)).toBe(false);
	});
});

describe("item 5: the CLI shows what it approves and asks first", () => {
	test("list shows the diff stat and touched paths; --diff shows the whole diff", async () => {
		const f = fixture();
		await prepared(f, "shown.txt");
		const lines: string[] = [];
		await preparedCommand(["list"], f.env, (s) => lines.push(s));
		const text = lines.join("\n");
		expect(text).toContain("diff: 1 file(s), +1 -0");
		expect(text).toContain("shown.txt  +1 -0");
		expect(text).toContain("touches: shown.txt");
		expect(text).not.toContain("+two");
		const full: string[] = [];
		await preparedCommand(["list", "--diff"], f.env, (s) => full.push(s));
		expect(full.join("\n")).toContain("+two");
	});

	test("approve shows the change and does nothing unless confirmed; default is no", async () => {
		const f = fixture();
		const id = await prepared(f, "conf.txt");
		const cwd = process.cwd();
		process.chdir(f.ws);
		try {
			const lines: string[] = [];
			let asked = "";
			const code = await preparedCommand(
				["approve", id.slice(0, 8)],
				f.env,
				(s) => lines.push(s),
				async (q) => {
					asked = q;
					return false;
				},
			);
			expect(code).toBe(1);
			expect(asked).toContain(id);
			expect(lines.join("\n")).toContain("touches: conf.txt");
			expect(lines.join("\n")).toContain("not confirmed; nothing done");
			expect(f.io.loadPacket(id)!.status).toBe("prepared");
			expect(f.io.exists(`claims/${id}`)).toBe(false);

			// No terminal: the built-in prompt answers No.
			expect(await preparedCommand(["approve", id], f.env, () => {})).toBe(1);
			expect(f.io.loadPacket(id)!.status).toBe("prepared");

			const ok = await preparedCommand(
				["approve", id],
				f.env,
				() => {},
				async () => true,
			);
			expect(ok).toBe(0);
			expect(f.io.loadPacket(id)!.status).toBe("approved");
		} finally {
			process.chdir(cwd);
		}
	});
});

describe("item 6: the model fetch never follows a redirect", () => {
	test("redirect is set to error", async () => {
		let init: RequestInit | undefined;
		const spy = (async (_u: string, i: RequestInit) => {
			init = i;
			return new Response(JSON.stringify({ response: "NO DIFF" }));
		}) as unknown as typeof fetch;
		await modelDrafter("http://127.0.0.1:11434", "m", spy)(cand(1), "");
		expect(init?.redirect).toBe("error");
	});
});
