/**
 * Chat text reaches the DJ (#4530), so it must stay data. A query full of shell
 * metacharacters has to arrive at yt-dlp as one literal argument, and a BPM
 * file path has to reach the shell as a positional parameter, never a script.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DJ, setDjSpawn, setDjTools, ytSearch } from "../dj";

afterEach(() => {
	setDjSpawn();
	setDjTools();
});

describe("ytSearch", () => {
	test("a query with shell metacharacters is one literal argument", async () => {
		const evil = 'x"; touch /tmp/pwned-4530 #$(id)`id`|&&';
		let seen: { cmd: string; args: string[] } | null = null;
		setDjSpawn((cmd, args) => {
			seen = { cmd, args };
			const c = new EventEmitter() as unknown as ChildProcess;
			(c as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
			(c as unknown as { kill: () => boolean }).kill = () => true;
			setTimeout(() => c.emit("close", 1), 0);
			return c;
		});
		await ytSearch("/usr/bin/yt-dlp", evil);
		expect(seen!.cmd).toBe("/usr/bin/yt-dlp");
		expect(seen!.args.at(-1)).toBe(`ytsearch5:${evil}`);
		expect(seen!.args.filter((a) => a.includes(evil))).toHaveLength(1);
		expect(existsSync("/tmp/pwned-4530")).toBe(false);
	});
});

describe("DJ.bpm", () => {
	test("a file path with shell metacharacters is never executed", () => {
		const dir = mkdtempSync(join(tmpdir(), "dj-bpm-"));
		const marker = "pwned-4530-bpm"; // a relative path: the shell would create it in its cwd
		try {
			const file = join(dir, `a";touch ${marker};echo ".wav`.replace(/\//g, "_"));
			writeFileSync(file, "x");
			setDjTools({ sox: "/usr/bin/false", ffmpeg: "/usr/bin/false" });
			new DJ().bpm(file);
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(marker, { force: true });
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
