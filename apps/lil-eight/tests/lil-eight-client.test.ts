/**
 * Lil Eight is a client of the daemon, never its owner (governance #1123).
 *
 * On 13 Nov a Lil Eight build started `bun run <checkout>/packages/daemon/index.ts`
 * outside launchd. That copy kept its own cron list and rewrote cron.json over the
 * real daemon's jobs. These tests pin the fix: the app's sources never name the
 * daemon entry or bun, and the start plan only ever asks launchd to kickstart
 * the installed com.8gent.daemon service.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "..", "LilEight");
const swiftSources = readdirSync(APP_DIR)
	.filter((f) => f.endsWith(".swift"))
	.map((f) => ({ file: f, text: readFileSync(join(APP_DIR, f), "utf8") }));

/** Code lines only: comments may explain what is forbidden. */
const codeLines = (text: string) =>
	text
		.split("\n")
		.map((line, i) => ({ n: i + 1, line }))
		.filter(({ line }) => !line.trim().startsWith("//") && !line.trim().startsWith("///"));

describe("Lil Eight never starts the daemon itself", () => {
	test("sources include main.swift and DaemonService.swift", () => {
		const names = swiftSources.map((s) => s.file);
		expect(names).toContain("main.swift");
		expect(names).toContain("DaemonService.swift");
	});

	const forbidden: Array<[string, RegExp]> = [
		["the daemon entry path", /packages\/daemon/],
		["a daemon index.ts", /index\.ts/],
		["a bun executable", /\/bun\b|"bun"/],
		["a checkout path override", /EIGHT_CODE_PATH/],
		["the removed startDaemon()", /\bstartDaemon\s*\(/],
	];
	for (const [what, re] of forbidden) {
		test(`no Swift code line names ${what}`, () => {
			const hits = swiftSources.flatMap(({ file, text }) =>
				codeLines(text)
					.filter(({ line }) => re.test(line))
					.map(({ n, line }) => `${file}:${n}: ${line.trim()}`),
			);
			expect(hits).toEqual([]);
		});
	}

	test("the not-running path goes through DaemonService.requestStart", () => {
		const main = swiftSources.find((s) => s.file === "main.swift")!.text;
		expect(main).toContain("DaemonService.requestStart()");
	});

	test("build.sh compiles DaemonService.swift into the app", () => {
		const build = readFileSync(join(import.meta.dir, "..", "build.sh"), "utf8");
		expect(build).toContain("LilEight/DaemonService.swift");
	});

	const swiftc = Bun.which("swiftc");
	test.skipIf(process.platform !== "darwin" || !swiftc)(
		"start plan: kickstart the installed service, else report not running",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "lil-eight-check-"));
			const out = join(dir, "check");
			try {
				const build = Bun.spawnSync(
					[
						swiftc!,
						"-parse-as-library",
						"-o",
						out,
						join(APP_DIR, "DaemonService.swift"),
						join(import.meta.dir, "DaemonServiceCheck.swift"),
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				expect(build.stderr.toString()).not.toContain("error:");
				expect(build.exitCode).toBe(0);
				const run = Bun.spawnSync([out], { stdout: "pipe", stderr: "pipe" });
				const text = run.stdout.toString();
				expect(text).not.toContain("FAIL");
				expect(text).toContain("DaemonServiceCheck: PASS");
				expect(run.exitCode).toBe(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
