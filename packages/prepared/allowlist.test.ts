/** Fix round 2 on #5241: the prepared tier is an allowlist, the patch is applied from stdin, the gate config is out of reach. */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyAction } from "../permissions/action-tiers.js";
import { approve, shellRunner } from "./apply.js";
import { type Packet, buildApplyCommand, packetId } from "./packet.js";
import { gateCommand, runPass } from "./pass.js";
import { cand, diffDrafter, fixture, sh } from "./testkit.js";

const NOW = new Date("2026-10-27T20:00:00");
const noRun = () => {
	throw new Error("must not run");
};
const newFile = (file: string, line: string) =>
	`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;
const gated = (payload: string) =>
	classifyAction({ kind: "apply_diff_worktree", target: "/r", payload });
const TSC = path.resolve(import.meta.dir, "../../node_modules/typescript/lib/tsc.js");

describe("non-ASCII paths are refused (APFS folds them onto protected dirs)", () => {
	const bad = [
		"packagesſ/permiſſions/new.ts", // packageſ/permiſſions
		".huſky/pre-commit", // .huſky
		"src/ß.ts", // ß
		"src/ﬁle.ts", // ﬁ
		"src/café.ts",
		"src/a​.ts",
		"src/ａ.ts", // fullwidth a
	];
	for (const p of bad) {
		test(`refused: ${JSON.stringify(p)}`, () => {
			const d = gated(newFile(p, "x"));
			expect(d.tier).toBe("blocked");
			expect(d.reason).toContain("allowlist");
		});
	}

	test("a quoted, octal-escaped header is refused before decoding", () => {
		const q =
			'diff --git "a/packages\\305\\277/x.ts" "b/packages\\305\\277/x.ts"\n--- /dev/null\n+++ "b/packages\\305\\277/x.ts"\n@@ -0,0 +1 @@\n+x\n';
		expect(gated(q).tier).toBe("blocked");
	});

	test("at prepare: refused with a reason the owner can read in blocked/", async () => {
		const f = fixture();
		const r = await runPass(f.io, {
			now: NOW,
			candidates: [cand(1)],
			drafter: diffDrafter(newFile("packagesſ/permiſſions/new.ts", "pwn")),
		});
		expect(r.prepared).toEqual([]);
		expect(r.blocked[0].reason).toContain("not on the allowlist");
		const rec = JSON.parse(
			fs.readFileSync(path.join(f.dir, "blocked", `${r.blocked[0].id}.json`), "utf8"),
		);
		expect(rec.missing).toContain("only ASCII");
	});
});

describe("the allowlist shape", () => {
	test("accepts an ordinary packages/x/src/a.ts change and a fixture JSON", () => {
		expect(gated(newFile("packages/x/src/a.ts", "export const a = 1;")).tier).toBe("gated");
		expect(gated(newFile("packages/x/__fixtures__/case.json", "{}")).tier).toBe("gated");
		expect(gated(newFile("docs/notes.md", "hi")).tier).toBe("gated");
	});
	test("refuses dot components, bad extensions, stray JSON, configs and lockfiles", () => {
		for (const p of [
			"src/.hidden.ts",
			"a/./b.ts",
			"src/a.sh",
			"src/a.yml",
			"Makefile",
			"packages/x/data.json",
			"packages/x/tsconfig.json",
			"packages/x/__fixtures__/tsconfig.json",
			"apps/web/Next.config.mjs",
			"vite.config.ts",
			"packages/x/fixtures/package-lock.json",
			"node_modules/typescript/lib/tsc.js",
			"src/a b.ts",
		]) {
			expect(gated(newFile(p, "x")).tier).toBe("blocked");
		}
	});
});

describe("the patch git applies is the verified payload, fed on stdin", () => {
	test("a patch renamed over <id>.patch after the byte check is never applied", async () => {
		const f = fixture();
		const r = await runPass(f.io, {
			now: NOW,
			candidates: [cand(1)],
			drafter: diffDrafter(newFile("good.txt", "verified")),
		});
		const id = r.prepared[0];
		const patch = path.join(f.dir, `${id}.patch`);
		expect(fs.statSync(patch).mode & 0o777).toBe(0o444);
		const res = approve(f.io, id, {
			now: NOW,
			run: (c, t, input) => {
				// The race: after approve compared the bytes, before git reads anything.
				const evil = path.join(f.dir, "evil.patch");
				fs.writeFileSync(evil, newFile("evil.txt", "swapped"));
				fs.renameSync(evil, patch);
				return shellRunner(c, t, input);
			},
		});
		expect(res.gate).toBe("pass");
		const wt = path.join(f.dir, "worktrees", id);
		expect(fs.readFileSync(path.join(wt, "good.txt"), "utf8")).toBe("verified\n");
		expect(fs.existsSync(path.join(wt, "evil.txt"))).toBe(false);
	});
});

describe("the gate config is out of the patch's reach", () => {
	function tsFixture() {
		const f = fixture();
		fs.writeFileSync(
			path.join(f.ws, "tsconfig.json"),
			`${JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }, null, 2)}\n`,
		);
		fs.mkdirSync(path.join(f.ws, "src"));
		fs.writeFileSync(path.join(f.ws, "src", "a.ts"), "export const a = 1;\n");
		sh(f.ws, "git add -A && git commit -q -m ts");
		f.setGate(`${JSON.stringify(process.execPath)} ${JSON.stringify(TSC)} --noEmit`);
		const outside = path.join(f.root, "home", ".8gent", "officers", "8GO", "merge-ready.txt");
		const before = fs.readFileSync(path.join(f.ws, "tsconfig.json"), "utf8");
		const after = `${JSON.stringify(
			{
				compilerOptions: { strict: true, incremental: true, tsBuildInfoFile: outside },
				include: ["src"],
			},
			null,
			2,
		)}\n`;
		fs.writeFileSync(path.join(f.ws, "tsconfig.json"), after);
		const diff = sh(f.ws, "git diff -- tsconfig.json");
		fs.writeFileSync(path.join(f.ws, "tsconfig.json"), before);
		return { ...f, outside, diff };
	}

	test("a tsconfig tsBuildInfoFile patch is refused at prepare and no outside file is written", async () => {
		const f = tsFixture();
		expect(f.diff).toContain("tsBuildInfoFile");
		const r = await runPass(f.io, {
			now: NOW,
			candidates: [cand(1)],
			drafter: diffDrafter(f.diff),
		});
		// Were it prepared, the owner approving it must still not write outside.
		for (const id of r.prepared) approve(f.io, id, { now: NOW });
		expect(fs.existsSync(f.outside)).toBe(false);
		expect(r.prepared).toEqual([]);
		expect(r.blocked[0].reason).toContain("tsconfig.json");
	});

	test("belt and braces: the apply command stops before the gate if the index touches config", () => {
		const f = tsFixture();
		const base = sh(f.ws, "git rev-parse HEAD").trim();
		const cmd = buildApplyCommand(f.ws, f.dir, "beltcheck", gateCommand(f.io, base), base);
		const r = shellRunner(cmd, 120_000, f.diff);
		expect(r.code).not.toBe(0);
		expect(fs.existsSync(f.outside)).toBe(false);
	});

	test("the gate body comes from git show <base>:package.json, not the working copy", () => {
		const f = fixture();
		f.setGate("true");
		const base = sh(f.ws, "git rev-parse HEAD").trim();
		fs.writeFileSync(
			path.join(f.ws, "package.json"),
			JSON.stringify({ scripts: { typecheck: "touch PWNED" } }),
		);
		expect(gateCommand(f.io, base)).toBe(`sh -c 'true'`);
	});

	test("a forged packet whose base is a commit outside the owner's history is refused", async () => {
		const f = fixture();
		f.setGate("true");
		const r = await runPass(f.io, {
			now: NOW,
			candidates: [cand(1)],
			drafter: diffDrafter(newFile("ok.txt", "x")),
		});
		const p = f.io.loadPacket(r.prepared[0])!;
		// A fetched branch tip with a hostile gate, not an ancestor of HEAD.
		const marker = path.join(f.root, "MARKER");
		sh(
			f.ws,
			`git checkout -q -b hostile && printf '%s' '{"scripts":{"typecheck":"touch ${marker}"}}' > package.json && git commit -q -am hostile && git checkout -q main`,
		);
		const hostile = sh(f.ws, "git rev-parse hostile").trim();
		const id = packetId(p.action, hostile);
		const cmd = buildApplyCommand(f.ws, f.dir, id, gateCommand(f.io, hostile), hostile);
		const forged: Packet = {
			...p,
			id,
			base: hostile,
			apply: cmd,
			action: { ...p.action, command: cmd },
		};
		f.io.savePacket(forged);
		fs.copyFileSync(path.join(f.dir, `${p.id}.patch`), path.join(f.dir, `${id}.patch`));
		const res = approve(f.io, id, { now: NOW, run: noRun });
		expect(res).toMatchObject({ ran: false });
		expect(res.reason).toContain("not in this workspace's history");
		expect(fs.existsSync(marker)).toBe(false);
	});
});
