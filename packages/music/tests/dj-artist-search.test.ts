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
		const { seen } = ytdlp([`Last Last\t${URL("a")}\t170`]);
		await ytSearch("/usr/bin/yt-dlp", "burna boy");
		const args = seen[0].args;
		expect(args.some((a) => /^ytsearch([2-9]|\d\d+):burna boy$/.test(a))).toBe(true);
		expect(args).toContain("--flat-playlist");
		expect(args).toContain("--ignore-errors");
		// The query is one literal argument, as before.
		expect(args.at(-1)).toBe(args.find((a) => a.endsWith(":burna boy")) as string);
	});

	test("a first hit that is a live stream is skipped for the first real track", async () => {
		ytdlp([`Burna Boy Radio 24/7\t${URL("live")}\tNA`, `Last Last\t${URL("a")}\t170`]);
		expect(await ytSearch("/usr/bin/yt-dlp", "burna boy")).toEqual({
			title: "Last Last",
			url: URL("a"),
		});
	});

	test("yt-dlp exits 1 over an entry it could not extract: the rows it printed still play", async () => {
		ytdlp([`Last Last\t${URL("a")}\t170`, `Ye\t${URL("b")}\t210`], 1);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("a"));
	});

	test("a three-hour mix ahead of the song does not win", async () => {
		ytdlp([`Burna Boy Mix 3 hours\t${URL("mix")}\t10800`, `Ye\t${URL("b")}\t210`]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("b"));
	});

	test("a clip under a minute does not win either", async () => {
		ytdlp([`short\t${URL("s")}\t20`, `Ye\t${URL("b")}\t210`]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("b"));
	});

	test("when only a mix or a live stream exists it still plays, rather than saying no results", async () => {
		ytdlp([`Burna Boy Mix\t${URL("mix")}\t10800`]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("mix"));
		ytdlp([`Radio\t${URL("live")}\tNA`]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("live"));
	});

	test("rows with no real URL are ignored", async () => {
		ytdlp([`broken\tNA\t200`, `also broken\t\t200`, `Ye\t${URL("b")}\t210`]);
		expect((await ytSearch("/usr/bin/yt-dlp", "burna boy"))?.url).toBe(URL("b"));
	});

	test("nothing found is still nothing found, with or without an error exit", async () => {
		ytdlp([], 0);
		expect(await ytSearch("/usr/bin/yt-dlp", "zzzzqqq")).toBeNull();
		ytdlp([], 1);
		expect(await ytSearch("/usr/bin/yt-dlp", "zzzzqqq")).toBeNull();
	});

	test("the two-column output the search printed before still parses (no duration)", async () => {
		ytdlp([`Fela Kuti - No Agreement\t${URL("f")}`]);
		expect(await ytSearch("/usr/bin/yt-dlp", "fela kuti")).toEqual({
			title: "Fela Kuti - No Agreement",
			url: URL("f"),
		});
	});

	test("a long query that already played still plays", async () => {
		ytdlp([`Burna Boy - On The Low\t${URL("l")}\t180`]);
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
