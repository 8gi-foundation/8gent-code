/**
 * Shared run_command sanitizer (packages/permissions/shell-sanitizer.ts).
 *
 * Unit: a single unquoted `&` separating commands is blocked on every
 * platform; quoted, escaped and redirection forms stay allowed; the other
 * rules (&&, ||, ;, $(), backticks) are unchanged.
 *
 * Integration: both real entry points - ToolExecutor.run_command and the AI
 * SDK agentTools.run_command - refuse a chained command before any spawn
 * (neither sentinel file is created) and still run a quoted `&`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTools, setToolContext } from "../ai/tools";
import { ToolExecutor } from "../eight/tools";
import { hasUnquotedAmpersand, sanitizeShellCommand } from "./shell-sanitizer";

const AMP_REASON =
	"Command chaining or background execution with & is not allowed. Use separate run_command calls instead";

describe("sanitizeShellCommand: single & (POSIX and Windows)", () => {
	const blocked = [
		"sleep 100 & del x",
		"a & b",
		"curl x & rm -rf y",
		"sleep 100 &",
		"sleep 100 & ",
		"a&b",
		'echo "ok" & rm y',
		"echo 'ok' & rm y",
		"cmd 2>&1 & rm y",
	];

	for (const platform of ["linux", "darwin", "win32"] as const) {
		for (const cmd of blocked) {
			test(`blocks \`${cmd}\` on ${platform}`, () => {
				const r = sanitizeShellCommand(cmd, platform);
				expect(r.safe).toBe(false);
				expect(r.reason).toBe(AMP_REASON);
			});
		}
	}

	const allowedEverywhere = [
		'echo "a&b"',
		"cmd 2>&1",
		"cmd >&2",
		"cmd 1<&0",
		'curl "https://x?a=1&b=2"',
	];
	for (const platform of ["linux", "darwin", "win32"] as const) {
		for (const cmd of allowedEverywhere) {
			test(`allows \`${cmd}\` on ${platform}`, () => {
				expect(sanitizeShellCommand(cmd, platform)).toEqual({ safe: true });
			});
		}
	}

	// POSIX-only quoting and escaping forms.
	const allowedPosix = [
		"curl 'https://x?a=1&b=2'",
		"echo a\\&b",
		"cmd &>out.log",
		"cmd &>>out.log",
		'echo "a \\" & b"',
	];
	for (const platform of ["linux", "darwin"] as const) {
		for (const cmd of allowedPosix) {
			test(`allows \`${cmd}\` on ${platform}`, () => {
				expect(sanitizeShellCommand(cmd, platform)).toEqual({ safe: true });
			});
		}
	}

	// cmd.exe does not treat single quotes as quoting or \ as an escape, so the
	// POSIX-safe forms above really do chain there. Its escape is ^.
	test("win32: single quotes do not protect &", () => {
		expect(sanitizeShellCommand("curl 'https://x?a=1&b=2'", "win32").safe).toBe(false);
	});
	test("win32: backslash does not escape &", () => {
		expect(sanitizeShellCommand("echo a\\&b", "win32").safe).toBe(false);
	});
	test("win32: &> is a separator, not a redirect", () => {
		expect(sanitizeShellCommand("cmd &>out.log", "win32").safe).toBe(false);
	});
	test("win32: caret-escaped ^& is allowed", () => {
		expect(sanitizeShellCommand("echo a^&b", "win32")).toEqual({ safe: true });
	});

	test("default platform is the host", () => {
		expect(sanitizeShellCommand("sleep 100 & del x").safe).toBe(false);
		expect(sanitizeShellCommand('echo "a&b"').safe).toBe(true);
	});

	test("hasUnquotedAmpersand leaves && to its own rule", () => {
		expect(hasUnquotedAmpersand("a && b", "linux")).toBe(false);
	});
});

describe("sanitizeShellCommand: other rules unchanged", () => {
	test("&& stays blocked with its own message", () => {
		for (const platform of ["linux", "win32"] as const) {
			const r = sanitizeShellCommand("a && b", platform);
			expect(r.safe).toBe(false);
			expect(r.reason).toBe(
				"Command chaining with && is not allowed. Use separate run_command calls instead",
			);
		}
	});
	test("&& inside quotes is data (#3879)", () => {
		expect(sanitizeShellCommand('echo "a&&b"', "linux").safe).toBe(true);
	});
	test("|| ; $() and backticks still blocked", () => {
		expect(sanitizeShellCommand("a || b").reason).toContain("||");
		expect(sanitizeShellCommand("a; b").reason).toContain("Semicolon");
		expect(sanitizeShellCommand("echo $(id)").reason).toContain("$(...)");
		expect(sanitizeShellCommand("echo `id`").reason).toContain("backticks");
	});
	test("pipes and plain redirects still allowed", () => {
		expect(sanitizeShellCommand("ls | grep x > out.txt").safe).toBe(true);
	});
});

describe("run_command entry points route through the shared sanitizer", () => {
	let dir: string;
	let executor: ToolExecutor;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "amp-gate-"));
		executor = new ToolExecutor(dir, "amp-test");
		setToolContext({ workingDirectory: dir });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const callSdk = (input: Record<string, unknown>) =>
		(
			agentTools.run_command as unknown as {
				execute: (i: unknown, o: unknown) => Promise<string>;
			}
		).execute(input, { toolCallId: "amp", messages: [] });

	test("ToolExecutor run_command: chained command is blocked before spawn", async () => {
		const out = await executor.execute("run_command", {
			command: `touch ${join(dir, "amp-a")} & touch ${join(dir, "amp-b")}`,
		});
		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain(AMP_REASON);
		await Bun.sleep(200);
		expect(existsSync(join(dir, "amp-a"))).toBe(false);
		expect(existsSync(join(dir, "amp-b"))).toBe(false);
	});

	test("AI SDK run_command: chained command is blocked before spawn", async () => {
		const out = await callSdk({
			command: `touch ${join(dir, "sdk-a")} & touch ${join(dir, "sdk-b")}`,
		});
		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain(AMP_REASON);
		await Bun.sleep(200);
		expect(existsSync(join(dir, "sdk-a"))).toBe(false);
		expect(existsSync(join(dir, "sdk-b"))).toBe(false);
	});

	test("AI SDK run_command: && is now blocked here too", async () => {
		const out = await callSdk({ command: `touch ${join(dir, "sdk-c")} && echo x` });
		expect(out).toStartWith("[BLOCKED]");
		expect(existsSync(join(dir, "sdk-c"))).toBe(false);
	});

	test("both paths still run a quoted &", async () => {
		const a = await executor.execute("run_command", { command: 'echo "amp&ok"' });
		expect(a).toContain("amp&ok");
		const b = await callSdk({ command: 'echo "amp&ok"' });
		expect(b).toContain("amp&ok");
	});
});

describe("sanitizeShellCommand: quoted text is data (#3879)", () => {
	const ok = (c: string) => expect(sanitizeShellCommand(c, "linux")).toEqual({ safe: true });
	const no = (c: string, why?: string) => {
		const r = sanitizeShellCommand(c, "linux");
		expect(r.safe).toBe(false);
		if (why) expect(r.reason).toContain(why);
	};

	test("the 04:46:33 pilot shape passes", () => {
		ok(
			'curl -sS -X POST "$B/sendMessage" --data-urlencode "chat_id=-100" --data-urlencode "text=$\'Run done.\\nChecks 11/12 passed; 487 seconds.\\nOld backups prune failed.\'"',
		);
	});
	test("; && || inside double or single quotes are data", () => {
		ok('echo "a; b"');
		ok("echo 'a; b'");
		ok('echo "a && b || c"');
		ok("echo 'a && b || c'");
		ok("grep 'x;y' file | wc -l");
	});
	test("$( and backticks inside single quotes are data", () => {
		ok("echo '$(id)'");
		ok("echo '`id`'");
		ok("echo '$(id) ; x'");
	});
	test("$( and backticks inside double quotes are still refused (bash expands them)", () => {
		no('echo "$(id)"', "$(...)");
		no('echo "x `id` y"', "backticks");
		no('echo "a; $(id)"', "$(...)");
	});
	test("real chaining outside quotes is still refused", () => {
		no("a; b", "Semicolon");
		no("a && b", "&&");
		no("a || b", "||");
		no("echo $(id)", "$(...)");
		no("echo `id`", "backticks");
		no('echo "ok"; id', "Semicolon");
		no("echo 'ok' && id", "&&");
		no('echo "ok" || id', "||");
		no("echo 'x'$(id)", "$(...)");
	});
	test("a quote mark does not hide chaining after it closes", () => {
		no("echo 'a'; rm x", "Semicolon");
		no('echo "a";rm x', "Semicolon");
	});
	test("escaped quotes do not open or close a span", () => {
		ok('echo "say \\"hi; there\\""');
		no("echo \\'; id", "Semicolon");
		no('echo \\"; id', "Semicolon");
		ok("echo it\\'s fine");
	});
	test("ANSI-C $'...' with a backslash is refused; without one it is a plain span", () => {
		no("echo $'it\\'s; fine'", "backslash");
		no("echo $'a\\nb'", "backslash");
		no("echo $'a; b'", "$'");
		no("echo $'a'; id", "Semicolon");
	});
	// 8SO review of #3880: payloads that ran a second command in bash.
	test("a backslash-escaped or doubled dollar does not open an ANSI span", () => {
		no("echo \\$'a\\'; touch PWN #'", "Semicolon");
		no("echo $$'a\\'; touch PWN #'", "Semicolon");
		no("echo $$$'a\\'; touch PWN #'");
	});
	test("a quote inside a # comment opens nothing, and the next line is refused", () => {
		no("echo hi # '\ntouch PWN; echo \\'", "new line");
		ok("echo hi # it's a comment");
		ok("echo hi # a; b");
		no("echo hi # c\ntouch PWN", "new line");
		no("echo a#b; id", "Semicolon");
		ok("echo ${#PATH}");
	});
	test("an unquoted newline or carriage return is a second command", () => {
		no("echo a\ntouch x", "new line");
		no("echo a\r\ntouch x", "new line");
		ok('echo "a\nb"');
		ok("echo 'a\nb'");
	});
	test("heredocs: here-string is not a heredoc, a command after the terminator is checked", () => {
		no("cat <<<x\ntouch y", "new line");
		ok("cat <<'EOF'\nit's fine\nEOF");
		no("cat <<'EOF'\nbody\nEOF\ntouch y", "new line");
		ok("cat <<-EOF\n\tbody\n\tEOF");
	});
	test("unbalanced quotes fail closed and say how to fix it", () => {
		no("echo 'abc", "escape the apostrophe");
		no('echo "abc', "Unbalanced");
		no("echo $'abc", "Unbalanced");
		no("echo it's", "Unbalanced");
	});
	test("a heredoc body is not quote-scanned, but its text keeps the strict rules", () => {
		ok("cat <<'EOF'\nit's fine\nEOF");
		no("cat <<'EOF'\nrun; id\nEOF", "Semicolon");
	});
	// 8SO review of #3880 (MED-4): a heredoc marker inside quotes or a comment is not a heredoc.
	test("a heredoc marker inside quotes or after # does not hide the next line", () => {
		no('echo "<<EOF"\ntouch PWN', "new line");
		no("echo '<<EOF'\ntouch PWN", "new line");
		no("echo hi # <<EOF\ntouch PWN", "new line");
	});
	test("a heredoc without its closing line is refused", () => {
		no("cat <<EOF\nbody only", "closing line");
		no("cat <<EOF", "closing line");
		ok("cat <<EOF\nbody\nEOF");
	});
	test("Windows keeps the strict whole-line rules", () => {
		expect(sanitizeShellCommand('echo "a; b"', "win32").safe).toBe(false);
	});
});

describe("sanitizeShellCommand: semicolon inside quotes is data (media-brief-video)", () => {
	test("quoted ; passes on POSIX (single, double, escaped)", () => {
		expect(sanitizeShellCommand("magick xc:red -annotate +0+0 'a;b' out.png", "linux").safe).toBe(true);
		expect(sanitizeShellCommand('echo "a;b"', "linux").safe).toBe(true);
		expect(sanitizeShellCommand("echo a\\;b", "linux").safe).toBe(true);
		expect(sanitizeShellCommand("echo 'it\"s;ok'", "linux").safe).toBe(true);
	});
	test("unquoted ; still blocked, including after a closed quote", () => {
		expect(sanitizeShellCommand("which a; mkdir video", "linux").safe).toBe(false);
		expect(sanitizeShellCommand("echo 'a'; id", "linux").safe).toBe(false);
		expect(sanitizeShellCommand('echo "a\\";id', "linux").safe).toBe(false);
		expect(sanitizeShellCommand("echo 'unterminated; id", "linux").safe).toBe(false);
	});
	test("win32 keeps the strict whole-line rule", () => {
		expect(sanitizeShellCommand("echo 'a;b'", "win32").safe).toBe(false);
	});
});

describe("backslash-escaped char before # is not a comment (8SO #3880)", () => {
	const no = (c: string) => expect(sanitizeShellCommand(c, "linux").safe).toBe(false);
	test("nine PoCs are refused", () => {
		no("echo \\;# && echo PWNED");
		no("echo \\;# ; echo PWNED");
		no("echo \\;# $(echo PWNED)");
		no("echo \\;# || id");
		no("echo \\;# `id`");
		no("echo \\;#'; echo PWNED");
		no("echo a\\ # && echo PWNED");
		no("echo \\(# && echo PWNED");
		no("echo \\|# && id");
	});
	test("find -exec \\; stays allowed, a real comment still is one", () => {
		expect(sanitizeShellCommand("find . -name x -exec echo {} \\;", "linux").safe).toBe(true);
		expect(sanitizeShellCommand("echo hi # a; b", "linux").safe).toBe(true);
	});
});

describe("sanitizeShellCommand: bash $'...' quoting is refused (8SO)", () => {
	test("ANSI-C quote smuggling is blocked on POSIX", () => {
		expect(sanitizeShellCommand("echo $'\\'';id;#'", "linux").safe).toBe(false);
		expect(sanitizeShellCommand("echo $'\\'';id;echo '", "linux").safe).toBe(false);
		expect(sanitizeShellCommand('echo $"x"', "linux").safe).toBe(false);
		expect(sanitizeShellCommand("echo $'a'", "linux").reason).toContain("$'");
	});
	test("a $ inside quotes or before other chars still passes", () => {
		expect(sanitizeShellCommand("echo '$'", "linux").safe).toBe(true);
		expect(sanitizeShellCommand('echo "cost $5"', "linux").safe).toBe(true);
	});
});
