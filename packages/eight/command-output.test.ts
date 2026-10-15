import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HEAD_BYTES, TAIL_BYTES, formatCommandOutput, writtenFiles } from "./command-output";

describe("formatCommandOutput (#3373)", () => {
	test("exit 0 with both streams keeps stderr and labels it", () => {
		expect(formatCommandOutput(0, "bun test v1.4.2\n", "5 pass\n 0 fail\n")).toBe(
			"bun test v1.4.2\n[stderr]\n5 pass\n 0 fail",
		);
	});
	test("200 KB of output still shows the summary at the end, under the artifact threshold", () => {
		const noise = `${"x".repeat(99)}\n`;
		const err = `${noise.repeat(2000)} 5 pass\n 0 fail\n`;
		const out = formatCommandOutput(0, "bun test v1.4.2\n", err);
		expect(out).toMatch(/5 pass\n 0 fail$/);
		expect(out).toMatch(/\[\d+ bytes omitted\]/);
		expect(out.startsWith("bun test v1.4.2\n[stderr]\n")).toBe(true);
		expect(Buffer.byteLength(out)).toBeLessThan(50_000);
	});
	test("the cap never splits a multi-byte character", () => {
		const out = formatCommandOutput(0, "é".repeat(20_000), "");
		expect(out).not.toContain("\uFFFD");
		expect(out).toMatch(/\[\d+ bytes omitted\]/);
	});
	test("non-zero exit string is byte for byte what main returned", () => {
		const main = (code: number, stdout: string, stderr: string) =>
			`Exit code ${code}:\n${stdout}\n${stderr}`;
		for (const [o, e] of [
			["out", "err"],
			["", "boom\n"],
			["a\nb\n", ""],
		] as const) {
			expect(formatCommandOutput(2, o, e)).toBe(main(2, o, e));
		}
	});
	test("exit 0 with one stream returns that stream", () => {
		expect(formatCommandOutput(0, "hello\n", "")).toBe("hello");
		expect(formatCommandOutput(0, "", "warning only\n")).toBe("warning only");
	});
	test("exit 0 with no output says so", () => {
		expect(formatCommandOutput(0, "", "")).toBe("Command completed successfully.");
	});
	test("non-zero exit is unchanged", () => {
		expect(formatCommandOutput(1, "out", "err")).toBe("Exit code 1:\nout\nerr");
	});
	test("a real passing bun test run reports its pass count", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-output-"));
		fs.writeFileSync(
			path.join(dir, "a.test.ts"),
			'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
		);
		const r = Bun.spawnSync([process.execPath, "test"], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		expect(r.exitCode).toBe(0);
		const before = r.stdout.toString() || r.stderr.toString();
		const after = formatCommandOutput(r.exitCode, r.stdout.toString(), r.stderr.toString());
		expect(after).toMatch(/1 pass/);
		// The old shape lost the summary whenever bun wrote anything to stdout.
		if (r.stdout.toString().trim()) expect(before).not.toMatch(/1 pass/);
	});

	// A secret that straddles a cut must be scrubbed before the cut, or the fragment
	// left on either side no longer matches the scanner and reaches the model (#2464).
	const TOKEN = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`; // 40 chars, matches github_token
	const fragments = (t: string) => {
		const out: string[] = [];
		for (let i = 0; i + 8 <= t.length; i++) out.push(t.slice(i, i + 8));
		return out;
	};
	const assertNoFragment = (out: string) => {
		for (const f of fragments(TOKEN)) expect(out).not.toContain(f);
	};
	test("a token across the head cut leaves no fragment", () => {
		const pre = `${"x".repeat(HEAD_BYTES - 21)}\n`; // token starts 20 bytes before the head cut
		const stdout = `${pre}${TOKEN}\n${"y".repeat(TAIL_BYTES * 2)}`;
		const out = formatCommandOutput(0, stdout, "");
		expect(out).toMatch(/\[\d+ bytes omitted\]/);
		assertNoFragment(out);
	});
	test("a token across the tail cut leaves no fragment", () => {
		const post = `\n${"z".repeat(TAIL_BYTES - 21)}`; // token ends 20 bytes inside the tail
		const stdout = `${"y".repeat(HEAD_BYTES * 4)}\n${TOKEN}${post}`;
		const out = formatCommandOutput(0, stdout, "");
		expect(out).toMatch(/\[\d+ bytes omitted\]/);
		assertNoFragment(out);
	});
	test("a token inside the kept tail is redacted, not dropped silently", () => {
		const stdout = `${"y".repeat(HEAD_BYTES * 8)}\n${TOKEN}\n5 pass\n`;
		const out = formatCommandOutput(0, stdout, "");
		expect(out).toContain("[REDACTED:github_token]");
		assertNoFragment(out);
	});
});

describe("silent success names the file it wrote (browser_operation pilot)", () => {
	const cwd = "/work/run";
	test("curl -o is readable; the cookie jar is named but never offered to read_file", () => {
		const r = formatCommandOutput(
			0,
			"",
			"",
			"curl -s -c cj.txt http://127.0.0.1:1/ -o login.html",
			cwd,
		);
		expect(r).toContain("wrote login.html.");
		expect(r).toContain("read_file on that file");
		expect(r).toContain("cj.txt holds session cookies or headers: do not read it");
		expect(r).not.toMatch(/wrote [^.]*cj\.txt/);
	});
	test("dump headers and cookie jars alone give no read_file suggestion", () => {
		for (const c of [
			"curl -s -D h.txt http://x/",
			"curl --cookie-jar=j http://x/",
			"curl --dump-header h http://x/",
		]) {
			const r = formatCommandOutput(0, "", "", c, cwd);
			expect(r).not.toContain("read_file");
			expect(r).toContain("do not read");
		}
	});
	test("several files say those files", () => {
		const r = formatCommandOutput(0, "", "", "curl -s http://x/ -o a.html > b.txt", cwd);
		expect(r).toContain("a.html, b.txt");
		expect(r).toContain("on those files");
	});
	test("targets outside the working directory are called out", () => {
		for (const f of ["/tmp/a.html", "../a.html", "~/a.html"]) {
			const r = formatCommandOutput(0, "", "", `curl -s -o ${f} http://x/`, cwd);
			expect(r).toContain("inside the working directory");
		}
		expect(formatCommandOutput(0, "", "", "curl -s -o a.html http://x/", cwd)).not.toContain(
			"inside the working",
		);
	});
	test("curl -O takes no value; wget -O and -o do", () => {
		expect(writtenFiles("curl -O http://x/f").readable).toEqual([]);
		expect(writtenFiles("wget -O out.html http://x/").readable).toEqual(["out.html"]);
		expect(writtenFiles("wget -o wget.log http://x/").readable).toEqual(["wget.log"]);
	});
	test("redirects count; /dev/null, 2>&1 and => do not", () => {
		expect(writtenFiles("echo hi > out.txt").readable).toEqual(["out.txt"]);
		expect(writtenFiles("cmd >/dev/null 2>&1").readable).toEqual([]);
		expect(writtenFiles('bun -e "x=>x"').readable).toEqual([]);
		expect(writtenFiles("bun -e x=>x").readable).toEqual([]);
	});
	test("no file, no note change", () => {
		expect(formatCommandOutput(0, "", "", "mkdir -p .tmp", cwd)).toBe(
			"Command completed successfully.",
		);
	});
	test("real output is never touched", () => {
		expect(formatCommandOutput(0, "hi\n", "", "curl -o a.txt x", cwd)).toBe("hi");
	});
});

describe("login-line copy names its file and the next step (#4303)", () => {
	const copy = "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt";

	test("a silent sed w copy says where the value went and how to post it", () => {
		const out = formatCommandOutput(0, "", "", copy, "/work");
		expect(out).toContain("Command completed successfully.");
		expect(out).toContain(".tmp/login");
		expect(out).toContain("curl -s -d @.tmp/login");
		expect(out).toContain("do not repeat");
	});

	test("the post form names the loopback URL and says no -L (#4303, run 2026-10-15_164257)", () => {
		const out = formatCommandOutput(0, "", "", copy, "/work");
		expect(out).toContain("http://127.0.0.1:PORT/");
		expect(out).toContain("no -L");
	});

	test("it never tells the model to read the file back", () => {
		const out = formatCommandOutput(0, "", "", copy, "/work");
		expect(out).not.toContain("Run read_file");
		expect(out).toContain("do not read");
	});

	test("it follows the output name the model chose", () => {
		const out = formatCommandOutput(
			0,
			"",
			"",
			"sed -n 's/^Token: */token=/w .tmp/tok' notes.txt",
			"/work",
		);
		expect(out).toContain("curl -s -d @.tmp/tok");
	});

	test("other sed commands are unchanged", () => {
		expect(formatCommandOutput(0, "", "", "sed -i 's/a/b/' f.txt", "/work")).toBe(
			"Command completed successfully.",
		);
	});
});
