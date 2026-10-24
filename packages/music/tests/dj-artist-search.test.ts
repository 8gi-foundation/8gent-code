/**
 * An artist-only query plays that artist's top track (#4963, Refs #4907).
 *
 * Artale on Termux: `/dj play burna boy` said "No results found" while
 * `/dj play kanye west` and `/dj play burna boy on the low` played. The search asked
 * yt-dlp for one hit and counted any non-zero exit as "no results", so one hit that
 * could not be extracted (unavailable, age-gated, a live stream) ended the search.
 * yt-dlp is stubbed here: its output and exit code are the test's, no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { pickTrack, setDjSpawn, ytSearch } from "../dj";

const URL = (id: string) => `https://www.youtube.com/watch?v=${id}`;
/** One line of `yt-dlp --dump-json`: JSON, so a tab or newline in a title is escaped. */
const J = (title: string, url: string | null, duration: string | number | null = null) =>
	JSON.stringify({ title, url, duration: duration === "NA" ? null : duration });

/** A yt-dlp that prints `rows` (tab separated) and exits with `code`. */
function ytdlp(rows: string[], code = 0): { seen: { cmd: string; args: string[] }[] } {
	const seen: { cmd: string; args: string[] }[] = [];
	setDjSpawn((cmd, args) => {
		seen.push({ cmd, args });
		const c = new EventEmitter() as unknown as ChildProcess;
		const out = new EventEmitter();
		(c as unknown as { stdout: EventEmitter }).stdout = out;
		(c as unknown as { kill: () => boolean }).kill = () => true;
		setTimeout(() => {
			if (rows.length) out.emit("data", `${rows.join("\n")}\n`);
			c.emit("close", code);
		}, 0);
		return c;
	});
	return { seen };
}

afterEach(() => setDjSpawn());

describe("an artist-only query", () => {
	test("asks for several hits, flat, ignoring entries that cannot be extracted", async () => {
		const { seen } = ytdlp([J("Last Last", URL("a"), 170)]);
		await ytSearch("/usr/bin/yt-dlp", "burna boy");
		const args = seen[0].args;
		expect(args.some((a) => /^ytsearch([2-9]|\d\d+):burna boy$/.test(a))).toBe(true);
		expect(args).toContain("--flat-playlist");
		expect(args).toContain("--ignore-errors");
		// The query is one literal argument, as before.
		expect(args.at(-1)).toBe(args.find((a) => a.endsWith(":burna boy")) as string);
	});

	test("a first hit that is a live stream is skipped for the first real track", async () => {
		ytdlp([J("Burna Boy Radio 24/7", URL("live"), null), J("Last Last", URL("a"), 170)]);
		expect(await ytSearch("/usr/bin/yt-dlp", "burna boy")).toEqual({
			title: "Last Last",
			url: URL("a"),
		});
	});

	test("yt-dlp exits 1 over an entry it could not extract: the rows it printed still play", async () => {
		ytdlp([J("Last Last", URL("a"), 170), J("Ye", URL("b"), 210)], 1);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("a"));
	});

	test("a three-hour mix ahead of the song does not win", async () => {
		ytdlp([J("Burna Boy Mix 3 hours", URL("mix"), 10800), J("Ye", URL("b"), 210)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("b"));
	});

	test("a clip under a minute does not win either", async () => {
		ytdlp([J("short", URL("s"), 20), J("Ye", URL("b"), 210)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("b"));
	});

	test("when only a mix or a live stream exists it still plays, rather than saying no results", async () => {
		ytdlp([J("Burna Boy Mix", URL("mix"), 10800)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("mix"));
		ytdlp([J("Radio", URL("live"), null)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("live"));
	});

	test("rows with no real URL are ignored", async () => {
		ytdlp([J("broken", null, 200), J("also broken", "", 200), J("Ye", URL("b"), 210)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("b"));
	});

	test("nothing found is still nothing found, with or without an error exit", async () => {
		ytdlp([], 0);
		expect(await ytSearch("/usr/bin/yt-dlp", "zzzzqqq")).toBeNull();
		ytdlp([], 1);
		expect(await ytSearch("/usr/bin/yt-dlp", "zzzzqqq")).toBeNull();
	});

	test("a row with no duration still plays", async () => {
		ytdlp([J("Fela Kuti - No Agreement", URL("f"))]);
		expect(await ytSearch("/usr/bin/yt-dlp", "fela kuti")).toEqual({
			title: "Fela Kuti - No Agreement",
			url: URL("f"),
		});
	});

	test("a title with a tab cannot supply its own URL", async () => {
		const evil = "Burna Boy - Ye\thttps://evil.example/steal";
		ytdlp([J(evil, URL("real"), 200)]);
		const got = await ytSearch("/usr/bin/yt-dlp", "burna boy");
		expect(got?.url).toBe(URL("real"));
		expect(got?.title).toBe(evil);
	});

	test("a tab-and-newline title cannot add a row either", async () => {
		ytdlp([J(`x\nEvil\thttps://www.youtube.com/watch?v=injected1\t200`, URL("real"), 200)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "q"))?.url).toBe(URL("real"));
	});

	test("lines that are not JSON, other hosts and URLs with whitespace are dropped", async () => {
		ytdlp([
			`Evil\thttps://www.youtube.com/watch?v=plainline\t200`,
			J("elsewhere", "https://evil.example/a", 200),
			J("spaced", "https://www.youtube.com/watch?v=a b", 200),
			J("scheme", "javascript:alert(1)", 200),
			J("Ye", URL("b"), 210),
		]);
		expect((await ytSearch("/usr/bin/yt-dlp", "q"))?.url).toBe(URL("b"));
	});

	test("with no url field the 11-character video id builds the watch URL", async () => {
		ytdlp([JSON.stringify({ title: "Ye", id: "abcdefghijk", duration: 200 })]);
		expect((await ytSearch("/usr/bin/yt-dlp", "q"))?.url).toBe(
			"https://www.youtube.com/watch?v=abcdefghijk",
		);
		ytdlp([JSON.stringify({ title: "bad id", id: "x y", duration: 200 })]);
		expect(await ytSearch("/usr/bin/yt-dlp", "q")).toBeNull();
	});

	test("a long query that already played still plays", async () => {
		ytdlp([J("Burna Boy - On The Low", URL("l"), 180)]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy on the low"))?.title).toBe(
			"Burna Boy - On The Low",
		);
	});
});

describe("pickTrack", () => {
	test("music length first, then known length, then the first row", () => {
		const row = (title: string, duration: number | null) => ({ title, url: URL(title), duration });
		expect(pickTrack([row("live", null), row("mix", 9000), row("song", 200)])?.title).toBe("song");
		expect(pickTrack([row("live", null), row("mix", 9000)])?.title).toBe("mix");
		expect(pickTrack([row("live", null)])?.title).toBe("live");
		expect(pickTrack([])).toBeNull();
	});
});
