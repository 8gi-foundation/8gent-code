import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HEAD_BYTES, TAIL_BYTES, formatCommandOutput } from "./command-output";

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
