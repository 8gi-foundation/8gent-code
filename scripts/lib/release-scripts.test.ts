/**
 * The release helper scripts (#3981), run as the workflows run them, with
 * fake `gh` and `minisign` binaries:
 *   release-require-draft.sh  never touches the files of a published release
 *   release-sign.sh           signs SHA256SUMS with the key clients embed
 *   release-alarm.sh          one P0 issue per failing workflow and ref
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "..");
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "release-scripts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, `#!/bin/bash\necho "$@" >> "${dir}/${name}.log"\n${body}\n`);
	chmodSync(p, 0o755);
	return p;
}

function run(script: string, args: string[], env: Record<string, string>) {
	const r = spawnSync("bash", [script, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const log = (name: string) =>
	existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8") : "";

describe("release-require-draft.sh", () => {
	const script = join(SCRIPTS, "release-require-draft.sh");
	test("a draft passes", () => {
		const gh = fake("gh", "echo true");
		expect(run(script, ["v1.2.3"], { GH: gh }).code).toBe(0);
	});
	test("a published release is refused", () => {
		const gh = fake("gh", "echo false");
		const r = run(script, ["v1.2.3"], { GH: gh });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("already published");
	});
	test("a missing release passes only with --allow-missing", () => {
		const gh = fake("gh", "exit 1");
		expect(run(script, ["v1.2.3"], { GH: gh }).code).not.toBe(0);
		expect(run(script, ["v1.2.3", "--allow-missing"], { GH: gh }).code).toBe(0);
	});
});

describe("release-sign.sh", () => {
	function setup(pubKey: string): { script: string; sums: string } {
		const sdir = join(dir, "scripts");
		mkdirSync(sdir, { recursive: true });
		copyFileSync(join(SCRIPTS, "release-sign.sh"), join(sdir, "release-sign.sh"));
		writeFileSync(join(sdir, "release-signing.pub"), `# comment\n${pubKey}\n`);
		const sums = join(dir, "SHA256SUMS");
		writeFileSync(sums, `${"a".repeat(64)}  8gent-linux-x64\n`);
		return { script: join(sdir, "release-sign.sh"), sums };
	}

	test("no key anywhere: ships unsigned with a notice", () => {
		const { script, sums } = setup("");
		const r = run(script, [sums, "v1.2.3"], { MINISIGN: fake("minisign", "exit 9") });
		expect(r.code).toBe(0);
		expect(r.out).toContain("unsigned");
		expect(log("minisign")).toBe("");
	});

	test("a public key without the secret fails (clients would refuse the release)", () => {
		const { script, sums } = setup("RWPUBKEY");
		const r = run(script, [sums, "v1.2.3"], { MINISIGN: fake("minisign", "exit 0") });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("MINISIGN_SECRET_KEY");
	});

	test("the secret without a public key fails", () => {
		const { script, sums } = setup("");
		const r = run(script, [sums, "v1.2.3"], {
			MINISIGN: fake("minisign", "exit 0"),
			MINISIGN_SECRET_KEY: "secret",
		});
		expect(r.code).not.toBe(0);
	});

	test("signs, then verifies against the embedded public key", () => {
		const { script, sums } = setup("RWPUBKEY");
		const r = run(script, [sums, "v1.2.3"], {
			MINISIGN: fake("minisign", "exit 0"),
			MINISIGN_SECRET_KEY: "secret",
		});
		expect(r.code).toBe(0);
		const calls = log("minisign").trim().split("\n");
		expect(calls[0]).toContain("-S -s");
		expect(calls[0]).toContain(`-x ${sums}.minisig`);
		expect(calls[1]).toContain("-P RWPUBKEY");
	});

	test("a signature that does not verify against the embedded key fails", () => {
		const { script, sums } = setup("RWPUBKEY");
		const r = run(script, [sums, "v1.2.3"], {
			MINISIGN: fake("minisign", 'case "$1" in -V) exit 1 ;; esac; exit 0'),
			MINISIGN_SECRET_KEY: "secret",
		});
		expect(r.code).not.toBe(0);
	});
});

describe("release-alarm.sh", () => {
	const script = join(SCRIPTS, "release-alarm.sh");
	test("opens a P0 issue when none is open", () => {
		const gh = fake("gh", "exit 0");
		const r = run(script, ["release.yml", "v1.2.3", "https://x/run"], { GH: gh, REPO: "o/r" });
		expect(r.code).toBe(0);
		expect(log("gh")).toContain(
			"issue create --repo o/r --title Release failed: release.yml on v1.2.3",
		);
		expect(log("gh")).toContain("--label P0");
	});
	test("comments on the open issue with the same title", () => {
		const gh = fake(
			"gh",
			'[ "$1 $2" = "issue list" ] && printf "12\\tRelease failed: release.yml on v1.2.3\\n"; exit 0',
		);
		const r = run(script, ["release.yml", "v1.2.3", "https://x/run"], { GH: gh, REPO: "o/r" });
		expect(r.code).toBe(0);
		expect(log("gh")).toContain("issue comment 12");
		expect(log("gh")).not.toContain("issue create");
	});
	test("a detail argument replaces the default consequence line (npm channel)", () => {
		const gh = fake("gh", "exit 0");
		const r = run(
			script,
			["release.yml npm channel", "v1.2.3", "https://x/run", "npm latest did not move to v1.2.3"],
			{ GH: gh, REPO: "o/r" },
		);
		expect(r.code).toBe(0);
		expect(log("gh")).toContain("--title Release failed: release.yml npm channel on v1.2.3");
		expect(log("gh")).toContain("npm latest did not move to v1.2.3");
		expect(log("gh")).not.toContain("installers keep serving");
	});
});
