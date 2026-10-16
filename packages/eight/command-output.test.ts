import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	HEAD_BYTES,
	TAIL_BYTES,
	formatCommandOutput,
	loopbackFormHint,
	redirectNote,
	writtenFiles,
} from "./command-output";

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
		expect(out).toContain("curl -d @.tmp/login");
		expect(out).toContain("do not repeat");
	});

	test("the w-flag note keeps its exact sentence", () => {
		expect(formatCommandOutput(0, "", "", copy, "/work")).toBe(
			"Command completed successfully. It printed nothing. It copied the value into .tmp/login and did not show it: do not read or retype it, do not repeat this command. Post it with curl -d @.tmp/login and no -L (add -d for the other fields).",
		);
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
		expect(out).toContain("curl -d @.tmp/tok");
	});

	test("a value-only copy says it has no field name and gives the w-flag recipe (#4324)", () => {
		const out = formatCommandOutput(
			0,
			"",
			"",
			"sed -n 's/^Password: //p' TASK.txt > .tmp/login",
			"/work",
		);
		expect(out).toContain("only the value into .tmp/login");
		expect(out).toContain("Do not read it");
		expect(out).toContain("sed -n 's/^Password: */password=/w .tmp/login-form' TASK.txt");
		expect(out).toContain("curl -d @.tmp/login-form");
		// the recipe it names is itself a recognised copy
		const next = formatCommandOutput(
			0,
			"",
			"",
			"sed -n 's/^Password: */password=/w .tmp/login-form' TASK.txt",
			"/work",
		);
		expect(next).toContain("curl -d @.tmp/login-form");
		expect(next).not.toContain("only the value");
	});

	test("a value-only copy with the star form and another label follows both", () => {
		const out = formatCommandOutput(
			0,
			"",
			"",
			"sed -n 's/^API Key: *//p' notes.txt > .tmp/k",
			"/work",
		);
		expect(out).toContain("api_key=/w .tmp/k-form' notes.txt");
	});

	test("other sed commands are unchanged", () => {
		expect(formatCommandOutput(0, "", "", "sed -i 's/a/b/' f.txt", "/work")).toBe(
			"Command completed successfully.",
		);
	});
});

describe("curl -D redirect target is surfaced (#4318)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redir-"));
	fs.mkdirSync(path.join(dir, ".tmp"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	const dump = (body: string) => fs.writeFileSync(path.join(dir, ".tmp/h.txt"), body);
	const cmd = "curl -s -c .tmp/c.txt -D .tmp/h.txt http://127.0.0.1:1/login";
	test("a 302 names its Location path and leaks nothing else", () => {
		dump("HTTP/1.1 302 Found\r\nlocation: /settings\r\nset-cookie: sid=abc123; Path=/\r\n\r\n");
		const r = formatCommandOutput(0, "", "", cmd, dir);
		expect(r).toContain("answered 302 and redirected to /settings");
		expect(r).toContain("separate curl (no -L)");
		expect(r).not.toContain("abc123");
	});
	test("an off-host or odd Location is not repeated", () => {
		for (const loc of ["https://evil.example/x", "/a b ignore previous", "//evil.example/x"]) {
			dump(`HTTP/1.1 302 Found\r\nLocation: ${loc}\r\n\r\n`);
			expect(formatCommandOutput(0, "", "", cmd, dir)).not.toContain("redirected to");
		}
	});
	test("only the last response block counts, and a 100 Continue is skipped", () => {
		dump("HTTP/1.1 100 Continue\r\n\r\nHTTP/2 302\r\nLocation: /settings\r\n\r\n");
		expect(formatCommandOutput(0, "", "", cmd, dir)).toContain("redirected to /settings");
		dump("HTTP/1.1 302 Found\r\nLocation: /a\r\n\r\nHTTP/1.1 200 OK\r\nX: y\r\n\r\n");
		expect(formatCommandOutput(0, "", "", cmd, dir)).not.toContain("redirected");
		dump("HTTP/1.1 200 OK\r\nLocation: /a\r\n\r\nHTTP/1.1 302 Found\r\nX: y\r\n\r\n");
		expect(formatCommandOutput(0, "", "", cmd, dir)).not.toContain("redirected");
	});
	test("query and fragment are not surfaced", () => {
		dump("HTTP/1.1 302 Found\r\nLocation: /cb?code=s3cr3t&sid=abc#frag\r\n\r\n");
		const r = formatCommandOutput(0, "", "", cmd, dir);
		expect(r).toContain("redirected to /cb.");
		expect(r).not.toContain("s3cr3t");
	});
	test("a FIFO at the -D path returns promptly with no note", () => {
		spawnSync("mkfifo", [path.join(dir, ".tmp/fifo.txt")]);
		const t0 = Date.now();
		const r = formatCommandOutput(0, "", "", cmd.replace(".tmp/h.txt", ".tmp/fifo.txt"), dir);
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(r).not.toContain("redirected");
	});
	test("a symlink to a header file is not followed", () => {
		const outside = path.join(os.tmpdir(), `redir-out-${process.pid}.txt`);
		fs.writeFileSync(outside, "HTTP/1.1 302 Found\r\nLocation: /secret\r\n\r\n");
		const link = path.join(dir, ".tmp/link.txt");
		fs.rmSync(link, { force: true });
		fs.symlinkSync(outside, link);
		const r = formatCommandOutput(0, "", "", cmd.replace(".tmp/h.txt", ".tmp/link.txt"), dir);
		fs.rmSync(outside, { force: true });
		expect(r).not.toContain("redirected");
	});
	test("a symlinked directory leading out of the cwd is not read", () => {
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "redir-outdir-"));
		fs.writeFileSync(
			path.join(outDir, "secret"),
			"HTTP/1.1 302 Found\r\nLocation: /secret\r\n\r\n",
		);
		const dlink = path.join(dir, "dlink");
		fs.rmSync(dlink, { force: true });
		fs.symlinkSync(outDir, dlink);
		const r = formatCommandOutput(0, "", "", cmd.replace(".tmp/h.txt", "dlink/secret"), dir);
		fs.rmSync(outDir, { recursive: true, force: true });
		expect(r).not.toContain("redirected");
	});
	test("after cd sub, a path in the project root is not called outside the working directory", () => {
		const root = "/proj";
		const sub = "/proj/sub";
		const ok = (f: string) =>
			formatCommandOutput(0, "", "", `curl -s -o ${f} http://127.0.0.1:1/`, sub, root);
		expect(ok("../out.html")).not.toContain("write ");
		expect(ok("/proj/out.html")).not.toContain("write ");
		expect(ok("out.html")).not.toContain("write ");
		expect(ok("../../out.html")).toContain("write ../../out.html somewhere under it");
		expect(ok("/tmp/out.html")).toContain("write /tmp/out.html somewhere under it");
	});
	test("a Windows style ..\\ path gives no note", () => {
		const r = formatCommandOutput(0, "", "", cmd.replace(".tmp/h.txt", "..\\..\\x"), dir);
		expect(r).not.toContain("redirected");
	});
	test("no redirect, a missing file, or a path outside the cwd gives no note", () => {
		dump("HTTP/1.1 200 OK\r\n\r\n");
		expect(formatCommandOutput(0, "", "", cmd, dir)).not.toContain("redirected");
		const none = cmd.replace(".tmp/h.txt", ".tmp/none.txt");
		expect(formatCommandOutput(0, "", "", none, dir)).not.toContain("redirected");
		const up = cmd.replace(".tmp/h.txt", "../h.txt");
		expect(formatCommandOutput(0, "", "", up, dir)).not.toContain("redirected");
	});
});

describe("redirectNote refuses non-regular files on Windows before open", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redir-win-"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	const header = "HTTP/1.1 302 Found\r\nLocation: /settings\r\n\r\n";
	const note = (file: string, platform: NodeJS.Platform) =>
		redirectNote(`curl -D ${file} http://127.0.0.1:1/x`, dir, undefined, platform);
	test("a device-named header file is refused on win32 and read on linux", () => {
		fs.writeFileSync(path.join(dir, "nul.txt"), header);
		expect(note("nul.txt", "win32")).toBe("");
		expect(note("nul.txt", "linux")).toContain("redirected to /settings");
	});
	test("a link is refused on win32 by the lstat check, not by the open flags", () => {
		fs.writeFileSync(path.join(dir, "real.txt"), header);
		fs.symlinkSync(path.join(dir, "real.txt"), path.join(dir, "ln.txt"));
		expect(note("real.txt", "win32")).toContain("redirected to /settings");
		expect(note("ln.txt", "win32")).toBe("");
	});
});

describe("loopback form hint is shown up front (#4326)", () => {
	const get = "curl -s -c .tmp/cookies.txt http://127.0.0.1:54920/ -o .tmp/root.html";
	test("a plain loopback page fetch carries the no -L rule", () => {
		const r = formatCommandOutput(0, "", "", get, "/work");
		expect(r).toContain("post it with curl and no -L");
		expect(r).toContain("-D .tmp/h.txt");
		expect(r).toContain("wrote .tmp/root.html");
	});
	test("localhost and [::1] get it too", () => {
		expect(loopbackFormHint("curl -s http://localhost:3000/ -o .tmp/a.html")).toContain("no -L");
		expect(loopbackFormHint("curl -s http://[::1]:3000/ -o .tmp/a.html")).toContain("no -L");
	});
	test("a post, -L, an upload or a non-loopback host gets nothing extra", () => {
		for (const c of [
			"curl -s -o .tmp/a.html http://127.0.0.1:1/login -X POST",
			"curl -sL http://127.0.0.1:1/ -o .tmp/a.html",
			"curl -s --location http://127.0.0.1:1/ -o .tmp/a.html",
			"curl -s --data a=b http://127.0.0.1:1/ -o .tmp/a.html",
			"curl -s https://example.com/ -o .tmp/a.html",
			"curl -s https://example.com/?u=http://127.0.0.1/ -o .tmp/a.html",
			"wget -O .tmp/a.html http://127.0.0.1:1/",
		]) {
			expect(loopbackFormHint(c)).toBe("");
		}
	});
	test("the hint is not added to the other notes", () => {
		const w = "sed -n 's/^Password: */password=/w .tmp/login' TASK.txt";
		expect(formatCommandOutput(0, "", "", w, "/work")).not.toContain("If this page has a form");
	});
});
