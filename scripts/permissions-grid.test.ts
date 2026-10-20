import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRows } from "./permissions-grid";

const SCRIPT = join(import.meta.dir, "permissions-grid.ts");
const root = mkdtempSync(join(tmpdir(), "grid-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A tree holding only a stand-in always-blocked.ts: it refuses any line with a recursive flag, minus `skip`. */
function fakeTree(name: string, skip?: string): string {
	const dir = join(root, name, "packages/permissions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "always-blocked.ts"),
		`export const commandArgvs = (t: string) => [t.split(/\\s+/)];
export const blockedReason = (a: string[]) => {
  const line = a.join(" ");
  return line.includes("-rf") && !(${JSON.stringify(skip ?? "")} && line.includes(${JSON.stringify(skip ?? "")})) ? "wipe" : null;
};
`,
	);
	return join(root, name);
}

function grid(head: string, base: string, ...extra: string[]) {
	return gridEnv({}, head, base, ...extra);
}
function gridEnv(env: Record<string, string>, head: string, base: string, ...extra: string[]) {
	const p = Bun.spawnSync(["bun", SCRIPT, "--pr-head", head, "--base", base, ...extra], {
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("permissions grid", () => {
	test("matrix is 842 rows: 161 spellings x 5 contexts plus 37 benign; quick is plain and comment", () => {
		expect(loadRows(false).length).toBe(842);
		expect(loadRows(true).length).toBe(161 * 2 + 37);
	});

	test("no wipe is spelled out in the data file or the script", () => {
		const text = ["permissions-grid.rows.json", "permissions-grid.ts"].map((f) =>
			Bun.file(join(import.meta.dir, f)).text(),
		);
		return Promise.all(text).then((all) => {
			for (const t of all) expect(/\brm -rf [/~]/.test(t)).toBe(false);
		});
	});

	test("identical trees: exit 0, nothing flips", () => {
		const t = fakeTree("same");
		const r = grid(t, t, "--no-shell");
		expect(r.code).toBe(0);
		expect(r.out).toContain("newly blocked 0, newly allowed 0");
	});

	test("head misses one spelling that base blocks: exit 1 and the row is named", () => {
		const r = grid(fakeTree("head-gap", "$'"), fakeTree("base-full"), "--no-shell");
		expect(r.code).toBe(1);
		expect(r.out).toContain("NEWLY ALLOWED on head (FAIL)");
		expect(r.out).toMatch(/newly allowed [1-9]/);
		expect(r.out).toContain("$'");
	});

	test("head blocks more than base: exit 0, rows listed as newly blocked", () => {
		const r = grid(fakeTree("head-strict"), fakeTree("base-gap", "$'"), "--no-shell");
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/newly blocked [1-9]\d*, newly allowed 0/);
	});

	test("a wipe both trees allow is a named gap under isolation; without isolation the probe is skipped and no gaps are listed", () => {
		const open = join(root, "open");
		mkdirSync(join(open, "packages/permissions"), { recursive: true });
		writeFileSync(
			join(open, "packages/permissions/always-blocked.ts"),
			"export const commandArgvs = (t: string) => [[t]];\nexport const blockedReason = () => null;\n",
		);
		const r = grid(open, open, "--quick");
		expect(r.code).toBe(0);
		if (r.out.includes("probe isolation: none")) {
			expect(r.out).toContain("probe skipped: no isolation (static grid only)");
			expect(r.out).not.toContain("NAMED SPELLING GAPS");
			expect(r.out).toContain("named gaps n/a");
		} else {
			expect(r.out).toMatch(/probe isolation: (sandbox-exec|unshare mount namespace)/);
			expect(r.out).toMatch(/named gaps [1-9]\d*/);
			expect(r.out).toContain("plain#0 ");
		}
	}, 60_000);

	test("rows.json holds no PATH-touching token except the one blocked absolute-path spelling", () => {
		const d = JSON.parse(readFileSync(join(import.meta.dir, "permissions-grid.rows.json"), "utf8"));
		const tok = /\/etc\/|\bPATH\b|command\s+-p|\/s?bin\/|\/usr\/|exec\s+-a/;
		const hits = [...d.spellings, ...d.benign].filter((x: string) => tok.test(x));
		expect(hits).toEqual(["/bin/sh -c '%RM% -rf /'"]);
	});

	test("a rev that does not exist fails loudly", () => {
		const r = grid("no-such-rev-4509", "no-such-rev-4509", "--no-shell");
		expect(r.code).not.toBe(0);
	});

	test("a policy that allows login-shell rows: they are skipped, never run, and a real file survives", () => {
		const open = join(root, "open-login");
		mkdirSync(join(open, "packages/permissions"), { recursive: true });
		writeFileSync(
			join(open, "packages/permissions/always-blocked.ts"),
			"export const commandArgvs = (t: string) => [[t]];\nexport const blockedReason = () => null;\n",
		);
		const canaryDir = join(root, "canary");
		mkdirSync(canaryDir);
		const canary = join(canaryDir, "keep.txt");
		writeFileSync(canary, "still here");
		const wipe = `%RM% -rf ${canaryDir}`;
		const spellings = [
			`bash -lc '${wipe}'`,
			`bash -ic '${wipe}'`,
			`sh --login -c '${wipe}'`,
			`zsh -c -l '${wipe}'`,
			`env bash -xlc '${wipe}'`,
			`bash -o errexit -lc '${wipe}'`,
			`bash -O extglob -l -c '${wipe}'`,
			`bash --rcfile f -i -c '${wipe}'`,
			`bash -c '${wipe}'`, // control: not a login shell, so it runs, against the stubs
			`source /etc/profile; ${wipe}`,
			`bash -c 'PATH=/bin:$PATH; ${wipe}'`,
			`bash -c 'exec -a x ${wipe}'`,
		];
		const rowsFile = join(root, "login-rows.json");
		writeFileSync(
			rowsFile,
			JSON.stringify({ contexts: { plain: "%ROW%" }, spellings, benign: [] }),
		);
		const r = gridEnv({ GRID_ROWS: rowsFile }, open, open);
		expect(r.code).toBe(0);
		const skipped = r.out
			.split("probe skipped (login/interactive/path)")[1]
			.split("NAMED SPELLING GAPS")[0];
		for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) expect(skipped).toContain(`plain#${i} `);
		expect(skipped).not.toContain("plain#8 ");
		expect(existsSync(canary)).toBe(true);
	}, 60_000);
});
